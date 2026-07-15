# @zippy/redirect

The Zippy core — a single Cloudflare Worker that turns a short link into a
**native-app open** for known platforms, falling back to the web URL everywhere else.

```bash
bun --filter @zippy/redirect dev        # wrangler dev → http://localhost:8787
bun --filter @zippy/redirect test       # vitest
bun --filter @zippy/redirect typecheck
```

## Routes

| Method | Path               | Auth   | Notes                                                                   |
| ------ | ------------------ | ------ | ----------------------------------------------------------------------- |
| GET    | `/:slug`           | —      | KV lookup. Known platform + mobile → interstitial; else `301`           |
| POST   | `/api/links`       | Bearer | Create a link. Body `{ url, slug? }` → `201 {slug, shortUrl, deeplink}` |
| GET    | `/api/links/:slug` | Bearer | Link info                                                               |

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
X/Twitter, and GitHub.

### Platform notes — GitHub (verified 2026-07, Android-only benefit)

GitHub is the first **schemeless** platform: the app registers **no custom URL
scheme**, only https App Links (Android) and Universal Links (iOS). Findings, with
sources, before we shipped it:

1. **iOS custom scheme?** No. Not in GitHub's own deep-linking gist, not in curated
   known-scheme lists, and GitHub's docs describe **only** Universal Links. The live
   `github.com/apple-app-site-association` maps repo/user/issue/PR paths to app ID
   `VEKTX9H2N7.com.github.stormbreaker.prod` — a Universal Link, not a scheme.
2. **Android package + pattern?** `com.github.android` (Play Store, verified). A
   package-targeted `intent://github.com/<path>#Intent;scheme=https;package=com.github.android;S.browser_fallback_url=<web>;end`
   opens the app on that URL, and `browser_fallback_url` degrades to the browser
   natively when the app is absent — the **same mechanism the other 8 platforms already
   ship**, differing only in `scheme=https` (Chrome intent docs + Branch guide).
3. **In-app-webview escape (Zippy's whole point)?** On iOS there is **none** for GitHub:
   with no custom scheme and Universal Links that don't fire inside Instagram/LinkedIn
   webviews, a GitHub short link on iOS just lands on `github.com` in the browser —
   **no app open, no regression**. Android inherits the same intent:// behavior as every
   other platform.

**Verdict:** shipped as **Android-native-open, iOS-web-fallback**. Cost is one table
entry; Android is a real win; iOS never does worse than a plain tap. We deliberately did
**not** invent a `github://` scheme — a wrong scheme adds a redirect hop and buys nothing.
`gist.github.com` was left out (no evidence the app handles gist links). If GitHub ships a
public custom scheme, iOS becomes a one-line change. Confidence: iOS-limitation `high`,
Android-benefit `moderate-high` (device-verify the intent:// open when you can).

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

## KV key schema (multi-host)

The Worker resolves a slug's KV key from the request's `Host`, so one deployment can
serve many custom domains (the hosted cloud fronts them with Cloudflare for SaaS). The
redirect path is **tier-blind** — it reads only routing data, never subscription state.

| Key                   | Value                      | Written by              | Read on                                  |
| --------------------- | -------------------------- | ----------------------- | ---------------------------------------- |
| `<slug>`              | destination URL (string)   | OSS `POST /api/links`   | requests on the **default host**         |
| `host:<hostname>`     | `{"tenantId":"<id>"}` JSON | the cloud (routing map) | first lookup on any **non-default** host |
| `t:<tenantId>:<slug>` | destination URL (string)   | the cloud's own API     | requests on a **mapped** host            |

Resolution for `GET /:slug`:

1. **`hostname === new URL(BASE_URL).hostname`** (the default host) → key is the bare
   `<slug>`. Existing single-tenant records are untouched — full back-compat.
2. **Any other hostname** → read `host:<hostname>`. Miss (or malformed JSON) → `404`,
   never a `500`. Hit → parse `{ tenantId }`, then the key is `t:<tenantId>:<slug>`.

### Link value shape

A link value (the `<slug>` and `t:<tenantId>:<slug>` records) is **either**:

- a **plain destination URL string** (what `POST /api/links` writes — full back-compat), or
- a **JSON object** `{ "url": "https://…", "branded"?: boolean }`. A value is treated as
  JSON only when its first character is `{`. Unknown extra fields are **ignored**
  (forward-compat); missing `branded` behaves exactly like a plain string; **malformed
  JSON → `404`** (never `500`). `"branded": true` shows a small "⚡ zipped with Zippy"
  footer on the interstitial (linking to `BASE_URL`); `false`/absent shows no branding.

The cloud denormalizes resolved entitlement effects (like `branded`) into the record so the
engine stays tier-blind — it never reads subscription state at request time. The OSS
`POST /api/links` keeps writing plain URL strings; only the cloud writes the JSON shape.

`<hostname>` is the exact lowercased Host with no port and no `www.` normalization —
write the mapping under the same host Cloudflare for SaaS routes to the Worker. Tenant
namespaces are isolated: a bare `<slug>` is never visible on a custom host, and vice
versa. The OSS `/api/links` endpoints stay single-tenant (they read/write bare `<slug>`
keys on the default host); the cloud writes `host:*` and `t:*:*` with its own tooling.
