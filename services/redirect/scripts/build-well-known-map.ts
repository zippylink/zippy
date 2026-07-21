#!/usr/bin/env bun
// BUILD-TIME ONLY — never shipped in the Worker (the runtime stays dependency-free). For each
// domain in ./app-domains.json this fetches /.well-known/assetlinks.json and
// apple-app-site-association (+ the /apple-app-site-association root fallback), parses the
// Android package + iOS appID a site publishes about ITSELF, and regenerates
// ../src/well-known-map.json — the artifact best-effort.ts reads at runtime.
//
//   Run from services/redirect:  bun run scripts/build-well-known-map.ts
//
// Politely rate-limited (10 concurrent, 5s timeout). Failures are skipped silently into a misses
// list summarised at the end. Follows only SAME-registrable-domain redirects, so a redirect to
// another site's file is never attributed to this domain. See task Wave 13.
import appDomains from "./app-domains.json";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "src", "well-known-map.json");

const CONCURRENCY = 10;
const TIMEOUT_MS = 5000;
const UA = "zippy-wellknown-bot/1.0 (+https://zipthe.link)";

type Row = {
  domain: string;
  androidPackage?: string;
  iosAppId?: string;
  fetchedAt: string;
  source: "assetlinks" | "aasa";
};

// Registrable domain — last two labels, with a small set of two-level public suffixes.
// ponytail: not a full Public Suffix List; enough to answer "same site?" for redirect safety on
// the consumer domains we probe. Add a suffix here if a real target needs it.
const TWO_LEVEL = new Set([
  "co.uk",
  "com.au",
  "co.jp",
  "co.kr",
  "com.br",
  "co.in",
  "com.mx",
  "co.nz",
  "com.tr",
  "co.za",
]);
function registrable(host: string): string {
  const p = host.toLowerCase().split(".");
  if (p.length <= 2) return p.join(".");
  const lastTwo = p.slice(-2).join(".");
  return TWO_LEVEL.has(lastTwo) ? p.slice(-3).join(".") : lastTwo;
}

// Fetch a URL, return parsed JSON or null. Same-registrable-domain redirects only; 5s timeout;
// AASA is sometimes served signed/non-JSON → JSON.parse fails → null (skipped).
async function getJson(url: string, expectHost: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": UA },
    });
    if (!res.ok) return null;
    try {
      if (registrable(new URL(res.url).hostname) !== registrable(expectHost)) return null;
    } catch {
      return null;
    }
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Android packages a site delegates ALL its https URLs to (the only best-effort-useful relation).
function androidPackages(assetlinks: unknown): string[] {
  if (!Array.isArray(assetlinks)) return [];
  const out: string[] = [];
  for (const s of assetlinks) {
    const rel = s?.relation;
    const handlesAll =
      Array.isArray(rel) && rel.includes("delegate_permission/common.handle_all_urls");
    if (
      handlesAll &&
      s?.target?.namespace === "android_app" &&
      typeof s.target.package_name === "string"
    ) {
      out.push(s.target.package_name);
    }
  }
  return [...new Set(out)];
}

// iOS appID ("TEAMID.bundle") from AASA applinks — informational only (iOS stays manual).
function iosAppId(aasa: unknown): string | undefined {
  const details = (aasa as { applinks?: { details?: unknown } })?.applinks?.details;
  if (!Array.isArray(details)) return undefined;
  for (const d of details) {
    if (typeof d?.appID === "string") return d.appID;
    if (Array.isArray(d?.appIDs) && typeof d.appIDs[0] === "string") return d.appIDs[0];
  }
  return undefined;
}

type Probe = { domain: string; hadAssetlinks: boolean; hadAasa: boolean; row: Row | null };

async function probe(domain: string): Promise<Probe> {
  const [assetlinks, aasaWk, aasaRoot] = await Promise.all([
    getJson(`https://${domain}/.well-known/assetlinks.json`, domain),
    getJson(`https://${domain}/.well-known/apple-app-site-association`, domain),
    getJson(`https://${domain}/apple-app-site-association`, domain),
  ]);
  const pkgs = androidPackages(assetlinks);
  const ios = iosAppId(aasaWk) ?? iosAppId(aasaRoot);
  const hadAssetlinks = assetlinks !== null;
  const hadAasa = aasaWk !== null || aasaRoot !== null;
  if (pkgs.length === 0 && !ios) return { domain, hadAssetlinks, hadAasa, row: null };
  return {
    domain,
    hadAssetlinks,
    hadAasa,
    row: {
      domain,
      // ponytail: first handle_all_urls package — sites virtually never list >1 distinct app.
      androidPackage: pkgs[0],
      iosAppId: ios,
      fetchedAt: new Date().toISOString(),
      source: pkgs.length ? "assetlinks" : "aasa",
    },
  };
}

const domains = [...new Set(appDomains.flatMap((a) => a.domains).map((d) => d.toLowerCase()))];

const rows: Row[] = [];
const misses: string[] = [];
let publishedAssetlinks = 0;
let publishedAasa = 0;
let usableAndroid = 0;
let usableIos = 0;

let next = 0;
async function drain(): Promise<void> {
  while (next < domains.length) {
    const domain = domains[next++] as string;
    const p = await probe(domain);
    if (p.hadAssetlinks) publishedAssetlinks++;
    if (p.hadAasa) publishedAasa++;
    if (p.row) {
      rows.push(p.row);
      if (p.row.androidPackage) usableAndroid++;
      if (p.row.iosAppId) usableIos++;
      process.stderr.write(
        `✓ ${domain}  ${p.row.androidPackage ?? "-"}  ${p.row.iosAppId ?? "-"}\n`,
      );
    } else {
      misses.push(domain);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, drain));

rows.sort((a, b) => a.domain.localeCompare(b.domain));
writeFileSync(OUT, JSON.stringify(rows, null, 2) + "\n");

const N = domains.length;
console.log(`\nwell-known-map.json regenerated: ${rows.length} rows written to ${OUT}`);
console.log(`  domains probed:            ${N}`);
console.log(
  `  published assetlinks.json: ${publishedAssetlinks}  (usable Android pkg: ${usableAndroid})`,
);
console.log(`  published AASA:            ${publishedAasa}  (usable iOS appID: ${usableIos})`);
console.log(`  misses (no usable signal): ${misses.length}`);
