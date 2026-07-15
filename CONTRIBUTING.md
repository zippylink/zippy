# Contributing to Zippy

Thanks for helping make short links open the right app. The most valuable
contribution is usually **a new or fixed platform deep link**.

## Add or fix a platform

1. Edit [`services/redirect/src/platforms.ts`](./services/redirect/src/platforms.ts).
   Add one object to `PLATFORMS`: `key`, `scheme`, `androidPackage`, the `hosts`
   it owns, and a `path(url)` that returns the scheme-specific suffix (or `""` to
   just open the app — the web fallback still lands the exact content).
2. Add a row per URL shape to `test/platforms.test.ts` (URL in → expected iOS
   scheme + package + web fallback).
3. Verify the scheme on a real device if you can. When in doubt, prefer `""`
   (open the app) over a guessed content scheme — the https fallback is the safety
   net, and a wrong scheme is a worse experience than a browser open.

## Dev setup

```bash
bun install
bun --filter @zippy/redirect dev     # wrangler dev → http://localhost:8787
bun --filter @zippy/redirect test    # vitest
```

## Before you open a PR

```bash
bunx nx run-many -t typecheck lint test   # the gate CI runs
bunx oxlint && bunx oxfmt --check .        # lint + format
```

- Keep changes small and focused. The core is deliberately tiny; new dependencies,
  a database, or analytics belong in a separate proposal, not the OSS core.
- Any API change updates the Bruno request under `api-collection/links/` too.
- By contributing you agree your work is licensed under **AGPL-3.0**.
