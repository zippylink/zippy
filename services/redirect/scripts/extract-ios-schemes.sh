#!/usr/bin/env bash
# Extract iOS custom URL schemes from the App Store, at scale — Task #72 Phase 1.
#
# WHY THIS EXISTS: device testing can only verify apps the tester has installed, which
# caps the registry at a handful. An app's own Info.plist declares every scheme it
# registers (CFBundleURLTypes/CFBundleURLSchemes) — FIRST-PARTY evidence, available for
# any app whether or not it is installed. That is the discovery half.
#
# WHAT IT DOES NOT ANSWER: whether `scheme://<host>/<path>` preserves the CONTENT or dumps
# the visitor on the app's home screen. Only a device answers that (proven 2026-07-21:
# luma://event/<slug> opened Luma's HOME and lost the event, while the host-preserving
# form opened it). So this script produces CANDIDATES; the QR sheet promotes them.
#
# AUTH (once, by a human — never by an agent):
#   ipatool auth login --email <your-apple-id>
# Use an Apple ID that HAS trusted devices: the 2FA code arrives as a push on your Mac or
# iPhone. A brand-new throwaway account has no trusted device, falls back to SMS, and the
# code frequently never arrives — that failure cost us a session.
#
# Then:  bun services/redirect/scripts/extract-ios-schemes.sh        (all misses)
#        APPS="Spotify,SoundCloud" bash …/extract-ios-schemes.sh      (named subset)
#
# Downloads are free apps only, paced, and the .ipa is deleted right after its plist is
# read — we keep the metadata, never the binary.
set -uo pipefail
cd "$(dirname "$0")"

OUT="ios-schemes-extracted.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! ipatool auth info >/dev/null 2>&1; then
  echo "✗ ipatool is not authenticated. Run this yourself first (it prompts for 2FA):"
  echo "    ipatool auth login --email <your-apple-id>"
  echo "  Use an Apple ID with trusted devices — the code arrives as a push, not SMS."
  exit 1
fi

# The apps worth extracting: everything in the harvest that has NO candidate scheme yet.
# ios-scheme-candidates.json already covers 33; the other 67 are why this script exists.
mapfile -t TARGETS < <(
  if [ -n "${APPS:-}" ]; then
    tr ',' '\n' <<<"$APPS"
  else
    python3 -c "
import json
cands = {c['appName'] for c in json.load(open('ios-scheme-candidates.json')) if c.get('schemes')}
apps = json.load(open('app-domains.json'))
for a in apps:
    if a['name'] not in cands:
        print(a['name'])
" 2>/dev/null | head -80
  fi
)

echo "→ ${#TARGETS[@]} apps to extract"
echo "[" > "$OUT.tmp"
first=1

for name in "${TARGETS[@]}"; do
  [ -z "$name" ] && continue
  bundle=$(ipatool search "$name" --limit 1 --format json 2>/dev/null \
           | python3 -c "import json,sys;a=json.load(sys.stdin).get('apps',[]);print(a[0]['bundleID'] if a else '')" 2>/dev/null)
  [ -z "$bundle" ] && { echo "  – $name: no App Store match"; continue; }

  ( cd "$WORK" && ipatool download -b "$bundle" --purchase -o app.ipa >/dev/null 2>&1 ) || {
    echo "  – $name ($bundle): download failed (paid/region-locked/unavailable)"; continue; }

  schemes=$( cd "$WORK" && unzip -o -q app.ipa 'Payload/*.app/Info.plist' 2>/dev/null && \
    plutil -convert json -o - Payload/*.app/Info.plist 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print('[]'); raise SystemExit
out=[]
for t in d.get('CFBundleURLTypes',[]) or []:
    for s in t.get('CFBundleURLSchemes',[]) or []:
        # Drop the noise every app ships: fb/google/twitter SDK callbacks and the
        # bundle-id scheme, none of which open CONTENT.
        if s.startswith(('fb','com.googleusercontent','twitterkit','bundle')): continue
        out.append(s)
print(json.dumps(sorted(set(out))))
" )
  rm -rf "$WORK/Payload" "$WORK/app.ipa" 2>/dev/null

  [ -z "$schemes" ] && schemes="[]"
  [ $first -eq 0 ] && echo "," >> "$OUT.tmp"; first=0
  printf '{"appName":%s,"bundleId":%s,"schemes":%s,"evidence":"info-plist","extractedAt":"%s"}' \
    "$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$name")" \
    "$(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$bundle")" \
    "$schemes" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT.tmp"
  echo "  ✓ $name ($bundle): $schemes"
  sleep 2   # be a polite client
done

echo "]" >> "$OUT.tmp" && mv "$OUT.tmp" "$OUT"
echo "→ wrote $OUT"
echo "  NEXT: these are CANDIDATES (a registered scheme, not a proven path shape)."
echo "  Regenerate the QR sheet and device-verify the shapes:  bun scripts/gen-scheme-testsheet.ts"
