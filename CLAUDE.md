@AGENTS.md

# Zippy — working notes

- **The deeplink table is the product.** `services/redirect/src/platforms.ts`.
  Every platform is one data object; changes there are small and test-backed.
- **DRY, and no hardcoded URLs/ports/secrets** — `BASE_URL` via `wrangler.toml`,
  `API_TOKEN` via `wrangler secret`, KV id in `wrangler.toml`.
- **Test before declaring done.** Run `bun --filter @zippy/redirect test` and
  `bunx nx run-many -t typecheck`.
- **Keep it lazy.** KV only. No database, no queues, no analytics in the OSS core.
