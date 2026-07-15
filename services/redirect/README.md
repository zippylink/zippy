# @zippy/redirect

The Zippy core — a single Cloudflare Worker that turns a short link into a
**native-app open** for known platforms, falling back to the web URL everywhere else.

```bash
bun --filter @zippy/redirect dev        # wrangler dev → http://localhost:8787
bun --filter @zippy/redirect test       # vitest
bun --filter @zippy/redirect typecheck
```

## Routes

| Method | Path              | Auth   | Notes                                                          |
| ------ | ----------------- | ------ | ------------------------------------------------------------- |
| GET    | `/:slug`          | —      | KV lookup. Known platform + mobile → interstitial; else `301` |
| POST   | `/api/links`      | Bearer | Create a link. Body `{ url, slug? }` → `201 {slug, shortUrl, deeplink}` |
| GET    | `/api/links/:slug`| Bearer | Link info                                                     |

Auth is `Authorization: Bearer <API_TOKEN>` against the `API_TOKEN` secret. With
no token configured, writes return `401` (closed, never open).

## How a redirect resolves

1. `GET /:slug` looks the slug up in KV (`LINKS`). Miss → `404` page.
2. Hit → the destination is matched against the deeplink table (`src/platforms.ts`).
3. **Known platform + mobile UA** → a tiny inline interstitial that attempts the
   native app (iOS custom scheme with a `visibilitychange`-aware ~1.5s fallback;
   Android `intent://`, which falls back to the web URL natively).
4. Otherwise → plain `301` to the destination.

## The deeplink table

`src/platforms.ts` is the core IP and where community PRs land. Each platform is
one object: `scheme`, `androidPackage`, the `hosts` it owns, and a `path(url)`
that returns the scheme-specific suffix (or `""` to just open the app). iOS,
Android-intent, and web-fallback link forms are derived from those uniformly.
Ships with LinkedIn, Instagram, WhatsApp, Reddit, Product Hunt, YouTube, TikTok,
and X/Twitter.

## Setup (KV + secret + domain)

```bash
bunx wrangler kv namespace create LINKS            # prints an id
bunx wrangler kv namespace create LINKS --preview  # prints a preview_id
# → paste both into wrangler.toml [[kv_namespaces]]
bunx wrangler secret put API_TOKEN                 # the create/read bearer token
```

`BASE_URL` (a `[vars]` value) builds the `shortUrl` in API responses — set it per
environment; the code never hardcodes a domain. The custom-domain (`zipthe.link`)
route is commented in `wrangler.toml`.
