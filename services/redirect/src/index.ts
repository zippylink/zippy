// @zippy/redirect — the Zippy core Worker (the one public door).
//
//   GET  /:slug          KV lookup → interstitial (mobile + known platform) or 301
//   POST /api/links       create a link            (Bearer API_TOKEN)
//   GET  /api/links/:slug  link info                (Bearer API_TOKEN)
//
// KV-only. No D1, no Durable Objects, no analytics. Serverless, ~$0 to run.
import { matchPlatform } from "./platforms.js";
import { renderInterstitial, render404 } from "./interstitial.js";

export interface Env {
  LINKS: KVNamespace;
  BASE_URL: string;
  API_TOKEN?: string;
}

const SLUG_RE = /^[a-zA-Z0-9-_]{1,32}$/;
const NANOID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const NANOID_LEN = 6;

const html = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const isMobile = (ua: string): boolean => /Android|iPhone|iPad|iPod/i.test(ua);

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

async function handleRedirect(slug: string, req: Request, env: Env): Promise<Response> {
  const dest = await env.LINKS.get(slug);
  if (!dest) return html(render404(), 404);
  const match = matchPlatform(dest);
  if (match && isMobile(req.headers.get("user-agent") ?? "")) {
    return html(renderInterstitial(match), 200);
  }
  return Response.redirect(dest, 301);
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
  const dest = await env.LINKS.get(slug);
  if (!dest) return json({ error: "Not found" }, 404);
  return json(linkInfo(slug, dest, env), 200);
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
    if (!slug) return html(render404(), 404); // root has no landing in the OSS core
    return handleRedirect(slug, req, env);
  },
};
