// @zippy/redirect — the Zippy core Worker (the one public door).
//
//   GET  /:slug          KV lookup → interstitial (mobile + known platform) or 301
//   POST /api/links       create a link            (Bearer API_TOKEN)
//   GET  /api/links/:slug  link info                (Bearer API_TOKEN)
//
// KV-only. No D1, no Durable Objects, no analytics. Serverless, ~$0 to run.
import { matchPlatform } from "./platforms.js";
import { renderInterstitial, render404 } from "./interstitial.js";
import { renderOgPage, type OgMeta } from "./og.js";

export interface Env {
  LINKS: KVNamespace;
  BASE_URL: string;
  API_TOKEN?: string;
  /** Outcome telemetry sink (Analytics Engine). Optional — unbound in local dev /
   *  self-host, in which case /t is a silent no-op and the cloud shows no data. */
  CLICKS?: AnalyticsEngineDataset;
}

const SLUG_RE = /^[a-zA-Z0-9-_]{1,32}$/;
const NANOID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const NANOID_LEN = 6;

const html = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const isMobile = (ua: string): boolean => /Android|iPhone|iPad|iPod/i.test(ua);

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

/** Constant-time-ish token compare (avoids leaking length-independent timing on the secret). */
function tokenOk(header: string | null, expected?: string): boolean {
  if (!expected) return false; // no token configured → writes are closed, not open
  const provided = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
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

type LinkValue = { url: string; branded: boolean; og?: OgMeta };

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
    const o = JSON.parse(raw) as { url?: unknown; branded?: unknown; og?: unknown };
    if (typeof o.url !== "string") return null;
    return { url: o.url, branded: o.branded === true, og: parseOg(o.og) };
  } catch {
    return null; // malformed record → unroutable, never 500 a visitor
  }
}

async function handleRedirect(
  slug: string,
  hostname: string,
  req: Request,
  env: Env,
): Promise<Response> {
  const key = await resolveKey(hostname, slug, env);
  if (key === null) return html(render404(env.BASE_URL), 404);
  const raw = await env.LINKS.get(key);
  if (!raw) return html(render404(env.BASE_URL), 404);
  const link = parseLinkValue(raw);
  if (!link) return html(render404(env.BASE_URL), 404);
  const ua = req.headers.get("user-agent") ?? "";

  // Social crawler → serve the unfurl card instead of redirecting. Humans fall
  // through to the normal interstitial/301 below (link preview never breaks the
  // real click). Cache briefly so a platform's repeat crawls are cheap.
  if (isSocialCrawler(ua)) {
    const shortUrl = `${env.BASE_URL.replace(/\/$/, "")}/${slug}`;
    return new Response(renderOgPage(shortUrl, link.url, link.og ?? {}), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  }

  const match = matchPlatform(link.url);
  if (match && isMobile(ua)) {
    return html(
      renderInterstitial(match, {
        branded: link.branded,
        homeUrl: env.BASE_URL,
        ua,
        slug,
        host: hostname,
      }),
      200,
    );
  }
  return Response.redirect(link.url, 301);
}

const OUTCOMES = new Set(["opened", "browser", "broken"]);

/**
 * POST /t — outcome telemetry beacon (navigator.sendBeacon from the interstitial).
 * Body: {slug, host, outcome, platformKey, sourceApp, ts}. Geo + device are derived
 * SERVER-side (from CF geo + UA) — never trusted from the client. No PII: coarse
 * country/city + device bucket + the in-app-webview name only, no IP, no identifiers.
 * Writes one Analytics Engine data point the cloud reads for per-link app-open stats;
 * it's a rate/trend signal (AE is sampled), not per-click truth. Always 204 — a beacon
 * must never error (there's no client to see it), and a bad body is silently dropped.
 */
async function handleBeacon(req: Request, env: Env): Promise<Response> {
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
  const device = /iPad|Tablet/i.test(ua)
    ? "tablet"
    : /Android|iPhone|iPod|Mobile/i.test(ua)
      ? "mobile"
      : "desktop";
  const cf = (req as unknown as { cf?: Record<string, unknown> }).cf ?? {};
  const country = typeof cf.country === "string" ? cf.country : "";
  const city = typeof cf.city === "string" ? cf.city : "";

  env.CLICKS?.writeDataPoint({
    indexes: [slug],
    blobs: [
      slug,
      str(body.host, 255),
      outcome,
      str(body.sourceApp, 64),
      str(body.platformKey, 32),
      country,
      city,
      device,
    ],
    doubles: [1],
  });
  return noContent;
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
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/t") {
      if (req.method === "POST") return handleBeacon(req, env);
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

    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    const slug = decodeURIComponent(pathname.slice(1));
    if (!slug) return html(render404(env.BASE_URL), 404); // root has no landing in the OSS core
    return handleRedirect(slug, url.hostname, req, env);
  },
};
