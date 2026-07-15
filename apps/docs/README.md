# @zippy/docs

The Zippy documentation site — [Fumadocs](https://fumadocs.dev) + Next.js, content in
`content/docs/*.mdx`, built as a **static export** and deployed to Cloudflare Pages.

```bash
bun --filter @zippy/docs dev      # next dev → http://localhost:3000
bun --filter @zippy/docs build    # static export → out/
bun --filter @zippy/docs typecheck
```

## Layout

- `content/docs/**.mdx` — the docs. Nav order per folder lives in `meta.json`.
- `source.config.ts` — fumadocs-mdx config (generates the git-ignored `.source/`).
- `lib/source.ts` — the content source, served under `/docs`.
- `app/` — the Next app: root layout + theme (`global.css`), the docs layout and
  `[[...slug]]` page, the static Orama search route, and a minimal `(home)` landing.

## Theme

Light-only, Zippy 80s brand: paper `#FAF7F2`, ink `#1A1033`, volt `#EEFF00`, magenta
`#FF3E8A`, cyan `#22D8FF`; fonts Bungee (display) / Outfit (body) / Space Mono (labels),
self-hosted via `next/font`. Tokens live in `app/global.css`.

## Deploy

`output: 'export'` produces a fully static `out/` — no Node server. Ship it with:

```bash
./scripts/deploy.sh docs
```

which builds and uploads `out/` to Cloudflare Pages.

## Editing docs

Add a page: create `content/docs/<path>.mdx` with `title` + `description` frontmatter, and
add its slug to the folder's `meta.json`. Document only what the Worker actually does —
`services/redirect/src` is the source of truth.
