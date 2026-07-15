#!/usr/bin/env bash
# Deploy Zippy to Cloudflare. Two targets:
#
#   ./scripts/deploy.sh [--production]   the redirect Worker (default target)
#   ./scripts/deploy.sh docs             the docs site (static export → CF Pages)
#
# Prereqs (Worker): create the KV namespace + set the API_TOKEN secret, and paste
# the namespace id into services/redirect/wrangler.toml — see services/redirect/README.md.
# Auth: `wrangler login`, or CLOUDFLARE_API_TOKEN in the environment.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── docs target: build the static export and upload out/ to Cloudflare Pages ──
if [[ "${1:-}" == "docs" ]]; then
  echo "→ Build @zippy/docs (static export)"
  bun --filter @zippy/docs build
  echo "→ Deploy docs to Cloudflare Pages"
  # Project name is config, not hardcoded — override with PAGES_PROJECT.
  bunx wrangler pages deploy "$ROOT/apps/docs/out" --project-name="${PAGES_PROJECT:-zippy-docs}"
  echo "✓ Docs deployed."
  exit 0
fi

# ── default target: the redirect Worker ──
cd "$ROOT/services/redirect"

if grep -q "REPLACE_WITH_KV" wrangler.toml; then
  echo "✗ wrangler.toml still has a placeholder KV id. Create the namespace and paste it first:" >&2
  echo "    bunx wrangler kv namespace create LINKS" >&2
  exit 1
fi

echo "→ Typecheck"
bun run typecheck

echo "→ Deploy zippy-redirect"
if [[ "${1:-}" == "--production" ]]; then
  bunx wrangler deploy --env production
else
  bunx wrangler deploy
fi

echo "✓ Deployed."
