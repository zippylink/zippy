#!/usr/bin/env bash
# Deploy the Zippy redirect Worker to Cloudflare. Usage:  ./scripts/deploy.sh [--production]
#
# Prereqs (one-time): create the KV namespace + set the API_TOKEN secret, and paste
# the namespace id into services/redirect/wrangler.toml — see services/redirect/README.md.
# Auth: `wrangler login`, or CLOUDFLARE_API_TOKEN in the environment.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
