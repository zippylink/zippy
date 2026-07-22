// @zippy/redirect — the Zippy core Worker (the one public door).
//
//   GET  /:slug          KV lookup → interstitial (mobile + known platform) or 301
//   POST /api/links       create a link            (Bearer API_TOKEN)
//   GET  /api/links/:slug  link info                (Bearer API_TOKEN)
//
// KV-only. No D1, no Durable Objects, no analytics. Serverless, ~$0 to run.
import { matchPlatform } from "./platforms.js";
import { bestEffortMatch } from "./best-effort.js";
import {
  renderInterstitial,
  render404,
  renderPasswordGate,
  renderPixelPage,
  inAppWebview,
  type PixelTag,
} from "./interstitial.js";
import { renderOgPage, type OgMeta } from "./og.js";

export interface Env {
  LINKS: KVNamespace;
  BASE_URL: string;
  /** Marketing site origin. Optional — when set, GET / 301s there and the 404
   *  page's "back to Zippy" points at it. Unset (self-host): / renders the 404. */
  LANDING_URL?: string;
  /** Default og:image for links with no stored card (a paste is never naked). Optional. */
  DEFAULT_OG_IMAGE?: string;
  API_TOKEN?: string;
  /** Outcome telemetry sink (Analytics Engine). Optional — unbound in local dev /
   *  self-host, in which case /t is a silent no-op and the cloud shows no data. */
  CLICKS?: AnalyticsEngineDataset;
  /** Per-redirect click sink (Analytics Engine). Optional — unbound = no click stats. */
  REDIRECTS?: AnalyticsEngineDataset;
  /** Cloud event-stream endpoint. Optional — when set, each recorded /t beacon is also
   *  forwarded there as a fire-and-forget JSON POST. Unset (self-host / local): off. */
  EVENTS_URL?: string;
  /** Bearer token sent on each forwarded event. Only used when EVENTS_URL is set. */
  EVENTS_TOKEN?: string;
  /** FLAG "1" = point the Android intent's browser_fallback_url at OUR /:slug?fb=1 instead
   *  of the destination, so a failed app-open is delivered to us and recorded as an
   *  observed `browser`. OFF BY DEFAULT (any other value / unset): Android stays
   *  `unmeasured`. Flip only after a real device confirms the fallback hop lands. */
  ANDROID_FALLBACK_MEASURE?: string;
  /** FLAG "1" = best-effort Android app-open for hosts NOT in the hand-verified table but whose
   *  published /.well-known/assetlinks.json gives an Android package (see best-effort.ts +
   *  well-known-map.json). Android only; iOS/desktop are untouched. The open is UNMEASURED by
   *  construction (its intent falls back to the DESTINATION, never our fb=1 hop). OFF BY DEFAULT
   *  (any other value / unset). Exact-match "1", like ANDROID_FALLBACK_MEASURE. */
  BEST_EFFORT_ANDROID?: string;
}

const SLUG_RE = /^[a-zA-Z0-9-_]{1,32}$/;

/** Where "back to Zippy" style links point — the marketing site if configured. */
const homeUrl = (env: Env): string => env.LANDING_URL ?? env.BASE_URL;
const NANOID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const NANOID_LEN = 6;

const html = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Query marker on the Android intent's browser_fallback_url. `?fb=1` on a slug means
 *  "the intent found no app and Chrome bounced the visitor back to us". */
const FB_PARAM = "fb";
/** `?v=` carries the A/B variant index across the fallback hop (see handleRedirect). */
const FB_AB_PARAM = "v";

/** Origin the short link was actually served from — BASE_URL for the default host, the
 *  tenant's own host on a custom domain (whose bare-slug key wouldn't resolve under
 *  BASE_URL). Never a hardcoded domain; the only sources are env + the request. */
function shortOrigin(hostname: string, env: Env): string {
  let defaultHost = hostname;
  try {
    defaultHost = new URL(env.BASE_URL).hostname;
  } catch {
    /* malformed BASE_URL → treat the request host as canonical */
  }
  return hostname === defaultHost ? env.BASE_URL.replace(/\/$/, "") : `https://${hostname}`;
}

const isMobile = (ua: string): boolean => /Android|iPhone|iPad|iPod/i.test(ua);
/** Coarse device bucket for outcome rows. Server-derived; never client-supplied. */
const deviceOf = (ua: string): string =>
  /iPad|Tablet/i.test(ua)
    ? "tablet"
    : /Android|iPhone|iPod|Mobile/i.test(ua)
      ? "mobile"
      : "desktop";

// OS bucket — the single most useful dimension for a DEEPLINK product (iOS vs Android
// decide which scheme fires, which store, which app behaviour). Coarse on purpose: no
// versions, no fingerprint. "" when it's neither (desktop/bot/unknown).
const osOf = (ua: string): string =>
  /iPhone|iPad|iPod/i.test(ua) ? "ios" : /Android/i.test(ua) ? "android" : "";

// Campaign tag — a creator who appends ?ref= or ?utm_source= to their zip gets
// attribution ("which post drove the taps") for free. Their own tagging, so no privacy
// concern; capped + lowercased for clean grouping. "" when absent.
const campaignOf = (url: URL): string =>
  (url.searchParams.get("ref") ?? url.searchParams.get("utm_source") ?? "")
    .slice(0, 64)
    .toLowerCase();

// Social crawlers that fetch a link to build an unfurl/preview card. A hit from one
// of these gets the OG page (see og.ts); everyone else redirects normally. Maintained
// set — add a signature here as platforms appear (the whole feature is this list + og.ts).
// Sources: each platform's published crawler UA (facebookexternalhit, Twitterbot, etc.).
const CRAWLER_RE =
  /facebookexternalhit|facebot|Twitterbot|LinkedInBot|Slackbot|Slack-ImgProxy|Discordbot|WhatsApp|TelegramBot|Pinterest(?:bot)?|redditbot|Applebot|SkypeUriPreview|vkShare|W3C_Validator|Embedly|Iframely|nuzzel|Google-InspectionTool|BingPreview|Mastodon|Bluesky|flipboard/i;
const isSocialCrawler = (ua: string): boolean => CRAWLER_RE.test(ua);

/** 6-char url-safe id from CSPRNG — no dependency. */
function randomSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NANOID_LEN));
  let out = "";
  for (const b of bytes) out += NANOID_ALPHABET[b % NANOID_ALPHABET.length];
  return out;
}

/** Constant-time string compare — no early-out on the first mismatched char. */
function constEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Constant-time-ish token compare (avoids leaking length-independent timing on the secret). */
function tokenOk(header: string | null, expected?: string): boolean {
  if (!expected) return false; // no token configured → writes are closed, not open
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
  return constEq(provided, expected);
}

/** SHA-256 → lowercase hex, via WebCrypto (present on Workers). Used for the derived gate
 *  cookie token, NOT for password storage (passwords use PBKDF2 — see verifyPassword). */
async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** hex string → bytes (for the stored PBKDF2 salt). Allocated from an explicit ArrayBuffer
 *  so it types as Uint8Array<ArrayBuffer> (WebCrypto's BufferSource under TS 5.9 generics). */
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(Math.floor(hex.length / 2)));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** PBKDF2-HMAC-SHA256 → lowercase hex (32 bytes). Byte-identical to Node's
 *  crypto.pbkdf2Sync(pw, salt, iters, 32, "sha256") the cloud hashes with, so the same
 *  password verifies on both sides. */
async function pbkdf2Hex(
  pw: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Verify a submitted password against the stored value. The cloud stores a slow, salted
 * PBKDF2 hash as `pbkdf2$<iters>$<saltHex>$<hashHex>` — a plaintext leak of KV/DB can't be
 * brute-forced back to the (often reused) password. Legacy bare-SHA-256 records still verify
 * for back-compat; the cloud is the only KV writer and now always writes PBKDF2, so there's
 * no downgrade path. Constant-time compare either way.
 */
async function verifyPassword(submitted: string, stored: string): Promise<boolean> {
  if (stored.startsWith("pbkdf2$")) {
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    const iterations = Number.parseInt(parts[1]!, 10);
    if (!Number.isFinite(iterations) || iterations < 1) return false;
    const actual = await pbkdf2Hex(submitted, hexToBytes(parts[2]!), iterations);
    return constEq(actual, parts[3]!);
  }
  return constEq(await sha256hex(submitted), stored); // legacy bare-SHA-256 record
}

// Password gate — cookie name is namespaced per slug so multiple protected links don't
// collide; the cookie value is a DERIVED token (hash of the stored hash + slug), so the
// raw password hash never rides in a client cookie. A visitor who proves the password once
// gets the cookie and isn't re-prompted for GATE_MAX_AGE seconds.
const GATE_MAX_AGE = 43_200; // 12h
const gateCookieName = (slug: string): string => `zpw_${slug}`;
const gateToken = (storedHash: string, slug: string): Promise<string> =>
  sha256hex(`${storedHash}:${slug}:zippy-gate`);

/** Value of a named cookie on the request, or null. */
function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Resolve the KV key for `slug` on this request's Host — pure routing, never reads
 * tier/subscription state (the mapping record is routing data written by the cloud).
 *
 *   default host (BASE_URL's host)  → bare `<slug>`          (back-compat: existing single-tenant records)
 *   any other host                  → `host:<hostname>` → { tenantId }, then `t:<tenantId>:<slug>`
 *   unmapped / malformed host       → null (caller 404s)
 */
async function resolveKey(hostname: string, slug: string, env: Env): Promise<string | null> {
  let defaultHost: string;
  try {
    defaultHost = new URL(env.BASE_URL).hostname;
  } catch {
    defaultHost = ""; // misconfigured BASE_URL → nothing is the default host; multi-host lookup still works
  }
  if (hostname === defaultHost) return slug;

  const mapping = await env.LINKS.get(`host:${hostname}`);
  if (!mapping) return null; // unknown host
  try {
    const { tenantId } = JSON.parse(mapping) as { tenantId?: unknown };
    if (typeof tenantId !== "string" || !tenantId) return null;
    return `t:${tenantId}:${slug}`;
  } catch {
    return null; // malformed mapping record → treat as unroutable, never 500 a visitor
  }
}

// Per-link conditional routing (geo + device/OS → destination). Denormalized by the cloud;
// the engine RESOLVES it at redirect time (device/OS first, then geo, then the default url).
// Mirrors @zippy/shared's RoutingRules/resolveRoute in the cloud repo — keep the two in sync.
type RoutingRules = {
  ios?: string;
  android?: string;
  desktop?: string;
  geo?: Record<string, string>;
};

type LinkValue = {
  url: string;
  branded: boolean;
  og?: OgMeta;
  orgId?: string;
  /** Unclaimed anonymous link (no-signup door). While true, every human redirect fires a
   *  fire-and-forget first-click ping to the cloud (starts the 7-day claim window there,
   *  idempotently). The cloud clears this flag on claim via the normal KV sync — see
   *  zippy-cloud libs/billing/src/kv.ts ("KEEP IN SYNC WITH THE ENGINE"). */
  anon?: boolean;
  routing?: RoutingRules;
  /** SHA-256 hash of the link's password (the cloud denormalizes the HASH, never the
   *  plaintext). Present = the link is gated: the engine shows a password form until the
   *  visitor proves the password. The engine never sees or stores the plaintext. */
  pw?: string;
  /** Cloud-hosted rich fallback page (absolute https URL). Only changes where the
   *  interstitial's automatic timeout bail lands; the visible "Continue in browser"
   *  anchor and every redirect path are untouched. */
  fbu?: string;
  /** Retargeting pixel tags (fire on the link CREATOR's behalf) — whitelist-validated
   *  by parsePx before any HTML/JS interpolation. */
  px?: PixelTag[];
  /** Scheduled destinations (epoch-seconds `from`, ascending). At redirect time the
   *  latest past entry's url becomes the EFFECTIVE default before routing runs. */
  sched?: SchedEntry[];
  /** A/B destination split — weighted variants that REPLACE the default url (the record's
   *  `url` is only the fallback when the split fails to parse). Cloud enforces ab XOR
   *  routing; if both somehow arrive, routing wins and ab is dropped at parse. */
  ab?: AbEntry[];
};

type SchedEntry = { from: number; url: string };
const SCHED_MAX = 10;

/** Keep only well-formed schedule entries, sorted by `from` asc — defends the redirect path. */
function parseSched(raw: unknown): SchedEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SchedEntry[] = [];
  for (const e of raw) {
    if (out.length >= SCHED_MAX) break;
    if (!e || typeof e !== "object") continue;
    const { from, url } = e as Record<string, unknown>;
    if (
      typeof from === "number" &&
      Number.isFinite(from) &&
      from > 0 &&
      typeof url === "string" &&
      url.startsWith("https://")
    ) {
      out.push({ from, url });
    }
  }
  return out.length ? out.sort((a, b) => a.from - b.from) : undefined;
}

type AbEntry = { u: string; w: number };
const AB_MIN = 2;
const AB_MAX = 4;

/**
 * Keep the A/B split only when EVERY entry is well-formed (2-4 entries, https urls,
 * integer weights >= 0, at least one positive) — one bad entry drops the whole split and
 * the record's url stands. Weights are cloud-validated as positive ints; the engine also
 * tolerates w=0 (a paused variant) but never negatives.
 */
function parseAb(raw: unknown): AbEntry[] | undefined {
  if (!Array.isArray(raw) || raw.length < AB_MIN || raw.length > AB_MAX) return undefined;
  const out: AbEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") return undefined;
    const { u, w } = e as Record<string, unknown>;
    if (typeof u !== "string" || !u.startsWith("https://")) return undefined;
    if (typeof w !== "number" || !Number.isInteger(w) || w < 0) return undefined;
    out.push({ u, w });
  }
  return out.some((e) => e.w > 0) ? out : undefined;
}

/** Weighted-random variant index. Zero-weight entries are never picked. */
function pickAb(ab: AbEntry[]): number {
  let total = 0;
  for (const e of ab) total += e.w;
  let r = Math.random() * total;
  for (let i = 0; i < ab.length; i++) {
    r -= ab[i]?.w ?? 0;
    if (r < 0) return i;
  }
  return 0; // unreachable (r < total and weights sum to total); satisfies tsc
}

// SECURITY: pixel ids get interpolated into inline HTML/JS — this charset whitelist
// IS the injection guard. Anything outside it (quotes, tags, >32 chars) is dropped.
const PX_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const PX_MAX = 5;

/** Keep only well-formed pixel entries the cloud denormalized — defends the render path. */
function parsePx(raw: unknown): PixelTag[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PixelTag[] = [];
  for (const e of raw) {
    if (out.length >= PX_MAX) break;
    if (!e || typeof e !== "object") continue;
    const { t, id } = e as Record<string, unknown>;
    if (
      (t === "meta" || t === "tiktok" || t === "gtm") &&
      typeof id === "string" &&
      PX_ID_RE.test(id)
    ) {
      out.push({ t, id });
    }
  }
  return out.length ? out : undefined;
}

/** Keep only the string routing fields the cloud denormalized — defends the redirect path. */
function parseRouting(raw: unknown): RoutingRules | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const r: RoutingRules = {};
  if (typeof o.ios === "string") r.ios = o.ios;
  if (typeof o.android === "string") r.android = o.android;
  if (typeof o.desktop === "string") r.desktop = o.desktop;
  if (o.geo && typeof o.geo === "object") {
    const geo: Record<string, string> = {};
    for (const [cc, v] of Object.entries(o.geo as Record<string, unknown>)) {
      if (typeof v === "string") geo[cc.toUpperCase()] = v;
    }
    if (Object.keys(geo).length) r.geo = geo;
  }
  return Object.keys(r).length ? r : undefined;
}

/**
 * Resolve the effective destination from routing rules. Order (first match wins): iOS →
 * Android → desktop (device/OS is primary — the native-app-open wedge), then geo[country],
 * then the default `url`. Country is the uppercased CF geo header. Same order as
 * @zippy/shared's resolveRoute (separate repo) — keep in sync.
 */
function resolveDestination(link: LinkValue, ua: string, country: string): string {
  const r = link.routing;
  if (r) {
    const os = osOf(ua);
    if (os === "ios" && r.ios) return r.ios;
    if (os === "android" && r.android) return r.android;
    if (!isMobile(ua) && r.desktop) return r.desktop;
    if (country && r.geo && typeof r.geo[country] === "string") return r.geo[country];
  }
  return link.url;
}

/** Keep only the string OG fields the cloud denormalized — defends the crawler path. */
function parseOg(raw: unknown): OgMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const og: OgMeta = {};
  if (typeof o.title === "string") og.title = o.title;
  if (typeof o.description === "string") og.description = o.description;
  if (typeof o.image === "string") og.image = o.image;
  return Object.keys(og).length ? og : undefined;
}

/**
 * Parse a KV link value. Back-compat: a plain string IS the destination URL. A value
 * starting with "{" is JSON `{ url, branded?, og? }` — unknown extra fields are ignored
 * (forward-compat), missing `branded` behaves like today, malformed JSON → null (404).
 * The cloud denormalizes entitlement effects (branding) and the social OG preview into
 * the record; the engine never reads subscription state or the destination's markup.
 */
function parseLinkValue(raw: string): LinkValue | null {
  if (raw[0] !== "{") return { url: raw, branded: false };
  try {
    const o = JSON.parse(raw) as {
      url?: unknown;
      branded?: unknown;
      og?: unknown;
      orgId?: unknown;
      anon?: unknown;
      routing?: unknown;
      pw?: unknown;
      fbu?: unknown;
      px?: unknown;
      sched?: unknown;
      ab?: unknown;
    };
    if (typeof o.url !== "string") return null;
    const routing = parseRouting(o.routing);
    return {
      url: o.url,
      branded: o.branded === true,
      og: parseOg(o.og),
      // Opaque tenant tag the cloud denormalizes in — the engine never interprets it,
      // only stamps it on the click data point so the cloud can roll up per-org.
      orgId: typeof o.orgId === "string" ? o.orgId : undefined,
      anon: o.anon === true ? true : undefined,
      routing,
      // Password hash (never plaintext) — a gate the engine enforces before any redirect.
      pw: typeof o.pw === "string" && o.pw ? o.pw : undefined,
      // Rich fallback page URL — defensively require an absolute https URL, else ignore.
      fbu: typeof o.fbu === "string" && o.fbu.startsWith("https://") ? o.fbu : undefined,
      px: parsePx(o.px),
      sched: parseSched(o.sched),
      // Cloud enforces ab XOR routing — if both somehow arrive, routing wins.
      ab: routing ? undefined : parseAb(o.ab),
    };
  } catch {
    return null; // malformed record → unroutable, never 500 a visitor
  }
}

async function handleRedirect(
  slug: string,
  hostname: string,
  req: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const key = await resolveKey(hostname, slug, env);
  if (key === null) return html(render404(homeUrl(env), env.LANDING_URL), 404);
  const raw = await env.LINKS.get(key);
  if (!raw) return html(render404(homeUrl(env), env.LANDING_URL), 404);
  const link = parseLinkValue(raw);
  if (!link) return html(render404(homeUrl(env), env.LANDING_URL), 404);
  const ua = req.headers.get("user-agent") ?? "";

  // Password gate — a protected link reveals NOTHING (not the destination, not the OG
  // card) until the visitor proves the password. Checked before the crawler branch on
  // purpose: a locked link must not unfurl its destination preview either. The visitor
  // proves it once (POST /:slug) and carries a per-slug derived-token cookie afterward.
  if (link.pw) {
    const token = readCookie(req, gateCookieName(slug));
    const expected = await gateToken(link.pw, slug);
    if (!token || !constEq(token, expected)) {
      return new Response(
        renderPasswordGate({
          slug,
          branded: link.branded,
          homeUrl: homeUrl(env),
          assetBase: env.LANDING_URL,
        }),
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        },
      );
    }
  }

  // Social crawler → serve the unfurl card instead of redirecting. Humans fall
  // through to the normal interstitial/301 below (link preview never breaks the
  // real click). Cache briefly so a platform's repeat crawls are cheap.
  if (isSocialCrawler(ua)) {
    // The card must advertise the URL the crawler actually fetched — on a tenant
    // custom domain that's the tenant's host, not BASE_URL (whose bare-slug key
    // wouldn't even resolve for a t:<tenantId>:<slug> record).
    const shortUrl = `${shortOrigin(hostname, env)}/${slug}`;
    return new Response(renderOgPage(shortUrl, link.url, link.og ?? {}, env.DEFAULT_OG_IMAGE), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  }

  // Scheduled destinations — the latest entry whose `from` has passed becomes the
  // EFFECTIVE default before routing/platform matching (a device rule can still beat it;
  // a scheduled App Store URL still springs the store). Entries are sorted asc by parse,
  // so the last past entry wins. Future-only schedule → the record's url stands.
  if (link.sched) {
    const now = Date.now() / 1000;
    for (const e of link.sched) if (e.from <= now) link.url = e.url;
  }

  // Resolve the effective destination — a cloud-managed link can route by device/OS + geo
  // to different destinations. CF geo is server-derived; nothing client-supplied is trusted.
  // The deeplink match runs on the RESOLVED destination, so routing + native-app spring
  // compose (iOS → App Store URL → springs the App Store app).
  const cf = (req as { cf?: { country?: string; city?: string } }).cf ?? {};
  const country = typeof cf.country === "string" ? cf.country.toUpperCase() : "";
  let dest = resolveDestination(link, ua, country);
  // A/B split — the picked variant REPLACES the default url entirely (ab XOR routing is
  // settled at parse: routing wins, so reaching here with `ab` means no routing at all).
  // The pick then flows through matchPlatform like any destination, so an App Store
  // variant still springs the store.
  // The picked index rides on to the interstitial's outcome beacon, so an A/B report can
  // say "variant B OPENED THE APP more often", not just "got more clicks".
  const url = new URL(req.url);
  // Is this the Android intent's fallback hop? (Chrome found no app and came back to us.)
  const isFallbackHop = url.searchParams.get(FB_PARAM) === "1";
  let abIndex: number | undefined;
  if (link.ab) {
    // On the fallback hop the variant is CARRIED, not re-picked: the intent that failed was
    // built for one specific variant, so the visitor must land on THAT variant's
    // destination and the `browser` row must be attributed to it. Client-supplied, so
    // validated as an in-range index into this link's own splits — the worst a forged `v`
    // can do is pick another of the link's own destinations. Missing/bogus → normal pick.
    const raw = isFallbackHop ? url.searchParams.get(FB_AB_PARAM) : null;
    const carried = raw !== null && /^\d+$/.test(raw) ? Number(raw) : -1;
    const i = carried >= 0 && carried < link.ab.length ? carried : pickAb(link.ab);
    const v = link.ab[i];
    if (v) {
      dest = v.u;
      abIndex = i;
    }
  }
  const abVariant = abIndex === undefined ? "" : String(abIndex);
  // FLAG ANDROID_FALLBACK_MEASURE: aim the intent's browser_fallback_url at a URL WE serve
  // (this same slug, marked) instead of the destination. Off → matchPlatform keeps the
  // legacy destination fallback and Android stays `unmeasured`.
  const fbUrl =
    env.ANDROID_FALLBACK_MEASURE === "1"
      ? `${shortOrigin(hostname, env)}/${encodeURIComponent(slug)}?${FB_PARAM}=1` +
        (abIndex === undefined ? "" : `&${FB_AB_PARAM}=${abIndex}`)
      : undefined;
  const match = matchPlatform(dest, fbUrl);

  // LOOP GUARD + the measurement itself. When the flag is ON this hop MUST short-circuit
  // here: /:slug?fb=1 is the same handler, so rendering the interstitial again would re-fire
  // the intent, fail again, bounce back here — an infinite loop on visitors already having
  // the worst time. Nothing below this line runs on the hop: no interstitial, and no second
  // REDIRECTS click row (the click was counted when the interstitial was served).
  // no-store + 302: a CDN caching this would swallow the very hits we are counting.
  //
  // GATED on the flag (DEFECT A — dark-launch law: flag OFF must be byte-identical to HEAD).
  // Flag OFF → ?fb=1 is treated as an ordinary request: interstitial served, click counted,
  // no outcome row. The flip-off transition is safe: an intent built while the flag was ON
  // points its fallback at ?fb=1, but with the flag now OFF fbUrl is undefined, so the
  // re-served interstitial's intent falls back to the DESTINATION — one extra hop, no loop.
  if (isFallbackHop && env.ANDROID_FALLBACK_MEASURE === "1") {
    // The `browser` outcome is OBSERVED, not inferred — the app provably did not open — but
    // record it ONLY for an Android mobile UA, the flow this intent was built for (DEFECT B).
    // Anyone can craft /:slug?fb=1 (bots expand fallback URLs straight out of the interstitial
    // HTML), and a phantom `browser` row deflates the creator's headline app-open rate, so a
    // desktop UA, a crawler, or a bare curl must 302 WITHOUT recording. The redirect is for
    // everyone; only the RECORDING is gated. No KV dedup — see task #69 decision note.
    if (osOf(ua) === "android") {
      recordOutcome(env, ctx, {
        slug,
        host: hostname,
        outcome: "browser",
        sourceApp: inAppWebview(ua) ?? "",
        platformKey: match?.key ?? "",
        country: cf.country ?? "",
        city: cf.city ?? "",
        device: deviceOf(ua),
        abVariant: abIndex,
        ts: Date.now(),
      });
    }
    return new Response(null, {
      status: 302,
      headers: { location: dest, "cache-control": "no-store" },
    });
  }

  // Click data point — one row per HUMAN redirect (crawlers returned above). Geo, device,
  // os, campaign derive server-side; nothing client-supplied is trusted. Dataset contract
  // (docs/stack/kv-schema.md): index1=orgId (opaque tenant tag from the KV record, '' for
  // self-host), blobs=[slug, country, device, platform, referrerHost, hostname, os, city,
  // campaign, abVariant]. Append-only — the cloud reader is positional. Optional binding —
  // self-host / local dev without it skips analytics entirely.
  if (env.REDIRECTS) {
    let referrerHost = "";
    try {
      const ref = req.headers.get("referer");
      if (ref) referrerHost = new URL(ref).hostname;
    } catch {
      /* malformed Referer → count the click, drop the referrer */
    }
    const device = isMobile(ua) ? "mobile" : "desktop";
    env.REDIRECTS.writeDataPoint({
      indexes: [link.orgId ?? ""],
      // Append-only: the cloud reader maps blob1..6 by position, so new dimensions go on
      // the end. os(7)=ios/android split (the deeplink product's key metric), city(8)=
      // finer "where are my fans" than country, campaign(9)=?ref/?utm_source attribution,
      // abVariant(10)=picked A/B variant index ("" when no split) for per-variant rates.
      blobs: [
        slug,
        cf.country ?? "",
        device,
        match?.key ?? "",
        referrerHost,
        hostname,
        osOf(ua),
        cf.city ?? "",
        campaignOf(url),
        abVariant,
      ],
      doubles: [1],
    });
  }

  // ANON FIRST-CLICK PING (no-signup door). For an unclaimed anonymous link, tell the
  // cloud a real visitor arrived — this is what starts the 7-day claim window. Contract
  // (cloud POST /api/events/click, always 204): fire on EVERY anon redirect, no engine
  // state — the cloud stamps firstClickAt once via conditional UPDATE, so duplicates are
  // free. Fail-safe by design: a lost ping only ever means the creator keeps MORE time
  // to claim, never less. Crawlers never reach this line (the OG branch returned above).
  // URL derives from EVENTS_URL (same cloud, same bearer as the outcome-beacon forward).
  if (link.anon && env.EVENTS_URL) {
    ctx?.waitUntil(
      fetch(env.EVENTS_URL.replace(/\/ingest$/, "/click"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(env.EVENTS_TOKEN ? { authorization: `Bearer ${env.EVENTS_TOKEN}` } : {}),
        },
        body: JSON.stringify({ slug, host: hostname }),
      }).catch(() => {
        /* fire-and-forget: a lost ping is safe (window just starts later) */
      }),
    );
  }

  if (match && isMobile(ua)) {
    return html(
      renderInterstitial(match, {
        branded: link.branded,
        homeUrl: homeUrl(env),
        assetBase: env.LANDING_URL,
        ua,
        slug,
        host: hostname,
        fbu: link.fbu,
        px: link.px,
        abVariant: abIndex,
      }),
      200,
    );
  }
  // Best-effort Android tier (flag-gated, Wave 13). No hand-verified platform owns this host,
  // but its published assetlinks yields the Android package (well-known-map.json). ANDROID ONLY —
  // iOS/desktop fall through to the normal redirect below (iOS app-open stays manual, never a
  // guessed scheme). UNMEASURED by construction: bestEffortMatch's intent falls back to the
  // DESTINATION, never the measured fb=1 hop, so it never enters the app-open funnel — the
  // interstitial's Android path records one `unmeasured` row and nothing else. A miss (host not in
  // the map) falls straight through to today's behaviour.
  if (!match && env.BEST_EFFORT_ANDROID === "1" && osOf(ua) === "android") {
    const be = bestEffortMatch(dest);
    if (be) {
      return html(
        renderInterstitial(be, {
          branded: link.branded,
          homeUrl: homeUrl(env),
          assetBase: env.LANDING_URL,
          ua,
          slug,
          host: hostname,
          fbu: link.fbu,
          px: link.px,
          abVariant: abIndex,
        }),
        200,
      );
    }
  }
  // A link with pixels can't plain-30x — the pixel JS needs a page to run in. Serve the
  // minimal pixel page instead: fire the tags, then client-side bounce to the resolved
  // destination. Crawlers never reach here (returned above) and the click point already
  // recorded once. no-store: a living link's destination is editable + pixels must re-fire.
  if (link.px) {
    return new Response(renderPixelPage(dest, link.px), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }
  // Cloud-managed (JSON) records are LIVING links — the destination is editable
  // after posting, so browsers must re-ask (302). A bare uncontrolled 301 is cached
  // forever and would pin returning visitors to the old destination. Plain-string
  // records (OSS API writes) stay 301: immutable by construction.
  const editable = raw[0] === "{";
  const status = editable ? 302 : 301;
  // A ROUTED link returns different destinations per visitor (device/geo), a SCHEDULED
  // one per moment in time, and an A/B one per random pick — never let a shared cache
  // pin one answer onto the next visitor.
  if (link.routing || link.sched || link.ab) {
    return new Response(null, { status, headers: { location: dest, "cache-control": "no-store" } });
  }
  return Response.redirect(dest, status);
}

/**
 * POST /:slug — password submission from the gate form. Verifies SHA-256(password) against
 * the stored hash; on success sets the per-slug derived-token cookie and 302s back to the
 * link (the follow-up GET carries the cookie and proceeds). On failure re-renders the gate.
 * A non-gated (or unknown) slug 404s — there's nothing to unlock.
 */
async function handlePasswordSubmit(
  slug: string,
  hostname: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const key = await resolveKey(hostname, slug, env);
  if (key === null) return html(render404(homeUrl(env), env.LANDING_URL), 404);
  const raw = await env.LINKS.get(key);
  if (!raw) return html(render404(homeUrl(env), env.LANDING_URL), 404);
  const link = parseLinkValue(raw);
  if (!link || !link.pw) return html(render404(homeUrl(env), env.LANDING_URL), 404); // nothing gated here

  let password = "";
  try {
    const form = await req.formData();
    const v = form.get("password");
    password = typeof v === "string" ? v : "";
  } catch {
    /* malformed body → treat as an empty (wrong) password */
  }

  const gateHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  if (!password || !(await verifyPassword(password, link.pw))) {
    return new Response(
      renderPasswordGate({
        slug,
        error: true,
        branded: link.branded,
        homeUrl: homeUrl(env),
        assetBase: env.LANDING_URL,
      }),
      { status: 200, headers: gateHeaders },
    );
  }

  const token = await gateToken(link.pw, slug);
  const secure = env.BASE_URL.startsWith("https") ? "; Secure" : "";
  return new Response(null, {
    status: 302,
    headers: {
      location: `/${slug}`,
      "set-cookie": `${gateCookieName(slug)}=${token}; Path=/; Max-Age=${GATE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`,
      "cache-control": "no-store",
    },
  });
}

// `unmeasured` = the tap was dispatched to the OS and its fate is structurally
// unobservable (Android intent://; see interstitial.ts). It is a real row so the blind
// spot is COUNTABLE — never in the numerator or denominator of an app-open rate.
const OUTCOMES = new Set(["opened", "browser", "broken", "unmeasured"]);

/**
 * POST /t — outcome telemetry beacon (navigator.sendBeacon from the interstitial).
 * Body: {slug, host, outcome, platformKey, sourceApp, ts}. Geo + device are derived
 * SERVER-side (from CF geo + UA) — never trusted from the client. No PII: coarse
 * country/city + device bucket + the in-app-webview name only, no IP, no identifiers.
 * Writes one Analytics Engine data point the cloud reads for per-link app-open stats;
 * it's a rate/trend signal (AE is sampled), not per-click truth. When EVENTS_URL is set,
 * the same sanitized event is also forwarded to the cloud (fire-and-forget). Always 204 —
 * a beacon must never error (there's no client to see it), and a bad body is silently
 * dropped.
 */
async function handleBeacon(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const noContent = new Response(null, { status: 204 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return noContent;
  }
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const slug = str(body.slug, 32);
  const outcome = OUTCOMES.has(body.outcome as string) ? (body.outcome as string) : "";
  if (!slug || !outcome) return noContent; // nothing worth recording

  const ua = req.headers.get("user-agent") ?? "";
  const device = deviceOf(ua);
  const cf = (req as unknown as { cf?: Record<string, unknown> }).cf ?? {};
  const country = typeof cf.country === "string" ? cf.country : "";
  const city = typeof cf.city === "string" ? cf.city : "";
  const host = str(body.host, 255);
  const sourceApp = str(body.sourceApp, 64);
  const platformKey = str(body.platformKey, 32);
  // A/B variant index the interstitial echoed back. CLIENT-SUPPLIED, so re-validate rather
  // than trust: an integer in [0, AB_MAX) — the same bound parseAb enforces on the split
  // itself, checkable without a KV read (no round-trip on the beacon path). Anything else
  // (string, float, negative, out of range) drops the field; the outcome still records.
  const av = body.abVariant;
  const abVariant =
    typeof av === "number" && Number.isInteger(av) && av >= 0 && av < AB_MAX ? av : undefined;

  recordOutcome(env, ctx, {
    slug,
    host,
    outcome,
    sourceApp,
    platformKey,
    country,
    city,
    device,
    abVariant,
    ts: typeof body.ts === "number" ? body.ts : undefined,
  });
  return noContent;
}

type OutcomeRow = {
  slug: string;
  host: string;
  outcome: string;
  sourceApp: string;
  platformKey: string;
  country: string;
  city: string;
  device: string;
  abVariant?: number;
  ts?: number;
};

/**
 * Write ONE outcome row. The single writer for the CLICKS dataset — the client beacon
 * (POST /t) and the server-observed Android fallback hop both land here, so both produce
 * byte-identical row shapes and the cloud reader has one contract to follow. Callers own
 * sanitation: every field here is already server-derived or validated.
 */
function recordOutcome(env: Env, ctx: ExecutionContext | undefined, o: OutcomeRow): void {
  env.CLICKS?.writeDataPoint({
    indexes: [o.slug],
    // Append-only, positionally read by the cloud: abVariant(9) is "" when the link has no
    // split, which is nearly every link.
    blobs: [
      o.slug,
      o.host,
      o.outcome,
      o.sourceApp,
      o.platformKey,
      o.country,
      o.city,
      o.device,
      o.abVariant === undefined ? "" : String(o.abVariant),
    ],
    doubles: [1],
  });

  // Wave 2.9: real-time app-open event stream. Forward the SAME sanitized, server-derived
  // event to the cloud — fire-and-forget: the caller responds immediately and a dead cloud
  // endpoint (or missing ctx in tests) must never surface an error.
  if (env.EVENTS_URL) {
    ctx?.waitUntil(
      fetch(env.EVENTS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.EVENTS_TOKEN ?? ""}`,
        },
        body: JSON.stringify({
          slug: o.slug,
          host: o.host,
          outcome: o.outcome,
          sourceApp: o.sourceApp,
          platformKey: o.platformKey,
          country: o.country,
          city: o.city,
          device: o.device,
          // Omitted (JSON.stringify drops undefined) on every non-A/B link, so the
          // overwhelming-majority payload is byte-identical to before this field existed.
          abVariant: o.abVariant,
          ts: o.ts,
        }),
      }).catch(() => {}),
    );
  }
}

async function createLink(req: Request, env: Env): Promise<Response> {
  if (!tokenOk(req.headers.get("authorization"), env.API_TOKEN)) {
    return json({ error: "Unauthorized" }, 401);
  }
  let body: { url?: unknown; slug?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.url !== "string" || !isHttpUrl(body.url)) {
    return json({ error: "`url` must be a valid http(s) URL" }, 400);
  }
  const url = body.url;

  let slug: string;
  if (body.slug !== undefined) {
    if (typeof body.slug !== "string" || !SLUG_RE.test(body.slug)) {
      return json({ error: "`slug` must match [a-zA-Z0-9-_]{1,32}" }, 400);
    }
    slug = body.slug;
    if (await env.LINKS.get(slug)) return json({ error: "Slug already taken" }, 409);
  } else {
    slug = await freshRandomSlug(env);
  }

  await env.LINKS.put(slug, url);
  return json(linkInfo(slug, url, env), 201);
}

async function getLinkInfo(slug: string, req: Request, env: Env): Promise<Response> {
  if (!tokenOk(req.headers.get("authorization"), env.API_TOKEN)) {
    return json({ error: "Unauthorized" }, 401);
  }
  const raw = await env.LINKS.get(slug);
  if (!raw) return json({ error: "Not found" }, 404);
  const link = parseLinkValue(raw);
  if (!link) return json({ error: "Not found" }, 404);
  return json(linkInfo(slug, link.url, env), 200);
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function linkInfo(slug: string, url: string, env: Env) {
  return {
    slug,
    url,
    shortUrl: `${env.BASE_URL.replace(/\/$/, "")}/${slug}`,
    deeplink: matchPlatform(url)?.key ?? null,
  };
}

async function freshRandomSlug(env: Env): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const s = randomSlug();
    if (!(await env.LINKS.get(s))) return s;
  }
  throw new Error("Could not allocate a free slug"); // vanishingly unlikely; surfaces as 500
}

export default {
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/t") {
      if (req.method === "POST") return handleBeacon(req, env, ctx);
      return json({ error: "Method not allowed" }, 405);
    }
    if (pathname === "/api/links") {
      if (req.method === "POST") return createLink(req, env);
      return json({ error: "Method not allowed" }, 405);
    }
    if (pathname.startsWith("/api/links/")) {
      if (req.method === "GET")
        return getLinkInfo(decodeURIComponent(pathname.slice(11)), req, env);
      return json({ error: "Method not allowed" }, 405);
    }

    // POST /:slug is a password-gate submission (the gate form posts here). Any other
    // slug POST target (/t, /api/links) was handled above.
    if (req.method === "POST") {
      const submitSlug = decodeURIComponent(pathname.slice(1));
      if (submitSlug) return handlePasswordSubmit(submitSlug, url.hostname, req, env);
      return json({ error: "Method not allowed" }, 405);
    }
    // HEAD rides the GET path — link checkers, uptime monitors, and unfurl bots
    // probe with HEAD; the runtime strips the body automatically.
    if (req.method !== "GET" && req.method !== "HEAD")
      return json({ error: "Method not allowed" }, 405);
    const slug = decodeURIComponent(pathname.slice(1));
    if (!slug) {
      // Root: the OSS core has no landing page — send humans to the marketing
      // site when one is configured, else the branded 404.
      // new URL() so the location is normalized identically on every runtime
      if (env.LANDING_URL) return Response.redirect(new URL(env.LANDING_URL).toString(), 301);
      return html(render404(homeUrl(env), env.LANDING_URL), 404);
    }
    return handleRedirect(slug, url.hostname, req, env, ctx);
  },
};
