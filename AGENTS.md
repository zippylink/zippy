# Zippy — agent primer

Zippy is a URL shortener whose links open the **native app** for known platforms
instead of an in-app browser. One Cloudflare Worker, KV-backed, serverless.

## The map

This repo was scaffolded from [builders-stack](https://github.com/lonormaly/builders-stack)
and keeps its conventions, sized down to one service:

- **`services/`** — code with a URL. Here: `services/redirect`, the Worker.
- **`libs/`** — shared code, never served. None yet; add one only when two things
  need to share it (single public door: `libs/<name>/src/index.ts`, imported as
  `@zippy/<name>`, wired into `tsconfig.base.json` `paths`).

Dependencies point **down** (`services` → `libs`), never up — enforced by
`@nx/enforce-module-boundaries` (the `type:*` tag on each `package.json`).

## The core: the deeplink table

`services/redirect/src/platforms.ts` is the product. Each platform is one object:

```ts
{ key, scheme, androidPackage, hosts: [...], path: (url) => "<scheme-suffix>" | "" }
```

From `scheme` + `path` + `androidPackage` we derive all three link forms (iOS
custom scheme, Android `intent://` with a native web fallback, and the https
fallback). To add a platform: add one object + one row per URL shape to
`test/platforms.test.ts`. The web fallback is the safety net — a wrong scheme
degrades to "opens in browser", never to a broken link.

## Endpoints (the one public door: `src/index.ts`)

| Method | Path               | Auth   |
| ------ | ------------------ | ------ |
| GET    | `/:slug`           | —      | interstitial (mobile + known platform) or `301`   |
| POST   | `/api/links`       | Bearer | `{ url, slug? }` → `{ slug, shortUrl, deeplink }` |
| GET    | `/api/links/:slug` | Bearer | link info                                         |

## Working here

```bash
bun install
bun --filter @zippy/redirect dev        # wrangler dev
bun --filter @zippy/redirect test       # vitest
bunx nx run-many -t typecheck lint test # the full gate (what CI runs, affected-only)
bunx oxlint && bunx oxfmt --check .      # fast whole-repo lint + format
```

## Rules

- **No hardcoded URLs / ports / secrets.** `BASE_URL` comes from `wrangler.toml`
  `[vars]`; `API_TOKEN` is a `wrangler secret`; the KV id lives in `wrangler.toml`.
- **KV only.** No D1, no Durable Objects, no analytics in the OSS core — keep it
  serverless and ~$0.
- **Keep the API collection in sync.** A new/changed endpoint updates the Bruno
  request under `api-collection/links/` in the same change.
- **Every non-trivial change ships a test.** The vitest suite is the contract.
