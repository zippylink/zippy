// @zippy/redirect — the Zippy core Worker (the one public door).
//
//   GET  /:slug          KV lookup → interstitial (mobile + known platform) or 301
//   POST /api/links       create a link            (Bearer API_TOKEN)
//   GET  /api/links/:slug  link info                (Bearer API_TOKEN)
//
// KV-only. No D1, no Durable Objects, no analytics. Serverless, ~$0 to run.
import { matchPlatform } from "./platforms.js";
import { renderInterstitial, render404, renderPasswordGate } from "./interstitial.js";
import { renderOgPage, type OgMeta } from "./og.js";

export interface Env {
  LINKS: KVNamespace;
  BASE_URL: string;
  /** Marketing site origin. Optional — when set, GET / 301s there and the 404
   *  page's "back to Zippy" points at it. Unset (self-host): / renders the 404. */
  LANDING_URL?: string;
  API_TOKEN?: string;
  /** Outcome telemetry sink (Analytics Engine). Optional — unbound in local dev /
   *  self-host, in which case /t is a silent no-op and the cloud shows no data. */
  CLICKS?: AnalyticsEngineDataset;
  /** Per-redirect click sink (Analytics Engine). Optional — unbound = no click stats. */
  REDIRECTS?: AnalyticsEngineDataset;
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

const isMobile = (ua: string): boolean => /Android|iPhone|iPad|iPod/i.test(ua);

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

/** SHA-256 → lowercase hex, via WebCrypto (present on Workers). */
async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
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
  routing?: RoutingRules;
  /** SHA-256 hash of the link's password (the cloud denormalizes the HASH, never the
   *  plaintext). Present = the link is gated: the engine shows a password form until the
   *  visitor proves the password. The engine never sees or stores the plaintext. */
  pw?: string;
};

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
      routing?: unknown;
      pw?: unknown;
    };
    if (typeof o.url !== "string") return null;
    return {
      url: o.url,
      branded: o.branded === true,
      og: parseOg(o.og),
      // Opaque tenant tag the cloud denormalizes in — the engine never interprets it,
      // only stamps it on the click data point so the cloud can roll up per-org.
      orgId: typeof o.orgId === "string" ? o.orgId : undefined,
      routing: parseRouting(o.routing),
      // Password hash (never plaintext) — a gate the engine enforces before any redirect.
      pw: typeof o.pw === "string" && o.pw ? o.pw : undefined,
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
): Promise<Response> {
  const key = await resolveKey(hostname, slug, env);
  if (key === null) return html(render404(homeUrl(env)), 404);
  const raw = await env.LINKS.get(key);
  if (!raw) return html(render404(homeUrl(env)), 404);
  const link = parseLinkValue(raw);
  if (!link) return html(render404(homeUrl(env)), 404);
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
        renderPasswordGate({ slug, branded: link.branded, homeUrl: homeUrl(env) }),
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
    const defaultHost = (() => {
      try {
        return new URL(env.BASE_URL).hostname;
      } catch {
        return hostname;
      }
    })();
    const origin =
      hostname === defaultHost ? env.BASE_URL.replace(/\/$/, "") : `https://${hostname}`;
    const shortUrl = `${origin}/${slug}`;
    return new Response(renderOgPage(shortUrl, link.url, link.og ?? {}), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  }

  // Resolve the effective destination — a cloud-managed link can route by device/OS + geo
  // to different destinations. CF geo is server-derived; nothing client-supplied is trusted.
  // The deeplink match runs on the RESOLVED destination, so routing + native-app spring
  // compose (iOS → App Store URL → springs the App Store app).
  const cf = (req as { cf?: { country?: string; city?: string } }).cf ?? {};
  const country = typeof cf.country === "string" ? cf.country.toUpperCase() : "";
  const dest = resolveDestination(link, ua, country);
  const match = matchPlatform(dest);

  // Click data point — one row per HUMAN redirect (crawlers returned above). Geo, device,
  // os, campaign derive server-side; nothing client-supplied is trusted. Dataset contract
  // (docs/stack/kv-schema.md): index1=orgId (opaque tenant tag from the KV record, '' for
  // self-host), blobs=[slug, country, device, platform, referrerHost, hostname, os, city,
  // campaign]. Append-only — the cloud reader is positional. Optional binding — self-host /
  // local dev without it skips analytics entirely.
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
      // finer "where are my fans" than country, campaign(9)=?ref/?utm_source attribution.
      blobs: [
        slug,
        cf.country ?? "",
        device,
        match?.key ?? "",
        referrerHost,
        hostname,
        osOf(ua),
        cf.city ?? "",
        campaignOf(new URL(req.url)),
      ],
      doubles: [1],
    });
  }

  if (match && isMobile(ua)) {
    return html(
      renderInterstitial(match, {
        branded: link.branded,
        homeUrl: homeUrl(env),
        ua,
        slug,
        host: hostname,
      }),
      200,
    );
  }
  // Cloud-managed (JSON) records are LIVING links — the destination is editable
  // after posting, so browsers must re-ask (302). A bare uncontrolled 301 is cached
  // forever and would pin returning visitors to the old destination. Plain-string
  // records (OSS API writes) stay 301: immutable by construction.
  const editable = raw[0] === "{";
  const status = editable ? 302 : 301;
  // A ROUTED link returns different destinations per visitor (device/geo) — never let a
  // shared cache pin one visitor's route onto the next. no-store only when routing is set.
  if (link.routing) {
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
  if (key === null) return html(render404(homeUrl(env)), 404);
  const raw = await env.LINKS.get(key);
  if (!raw) return html(render404(homeUrl(env)), 404);
  const link = parseLinkValue(raw);
  if (!link || !link.pw) return html(render404(homeUrl(env)), 404); // nothing gated here

  let password = "";
  try {
    const form = await req.formData();
    const v = form.get("password");
    password = typeof v === "string" ? v : "";
  } catch {
    /* malformed body → treat as an empty (wrong) password */
  }

  const gateHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  if (!password || !constEq(await sha256hex(password), link.pw)) {
    return new Response(
      renderPasswordGate({ slug, error: true, branded: link.branded, homeUrl: homeUrl(env) }),
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
      return html(render404(homeUrl(env)), 404);
    }
    return handleRedirect(slug, url.hostname, req, env);
  },
};
