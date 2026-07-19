# Manual real-device checklist — iOS in-app-webview escape

A webview escape **cannot** be verified with curl or a headless browser: curl only sees
the served HTML (unit-tested in `worker.test.ts`), but only a real iPhone running the
real Instagram/TikTok/LinkedIn webview exercises the OS scheme/Universal-Link handoff.
This is the device procedure the deploy smoke test runs. Background: `docs/ios-escape.md`.

## What IS driven locally (already green)

- `inAppWebview()` UA detection matrix — `test/platforms.test.ts`.
- Per-context primary action baked into the served HTML — `test/worker.test.ts`
  ("iOS in-app-webview escape (technique matrix)"): scheme-fire vs `x-safari-` punt vs
  plain-web vs Android `intent://`.
- Served-HTML byte size per context (2.8–3.1 KB, all under 6 KB).

Optional: assert the served HTML per UA against a deployed Worker with curl —

```bash
BASE=https://zipthe.link            # or the preview URL
IG='Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 329.0.0.41.94 (iPhone14,5; iOS 17_4; en_US)'
SAFARI='Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'

# github link inside the IG webview MUST contain the Safari punt:
curl -s "$BASE/<github-slug>" -A "$IG" | grep -c 'x-safari-https://github.com'   # expect 1
# same github link in real Safari MUST NOT punt (the UL fires natively):
curl -s "$BASE/<github-slug>" -A "$SAFARI" | grep -c 'x-safari-'                 # expect 0
```

## Device procedure (the part only a phone can prove)

Create two test links (needs `API_TOKEN`):

```bash
# 1) scheme platform (LinkedIn) — should open the LinkedIn app directly from a webview
curl -s -XPOST "$BASE/api/links" -H "authorization: Bearer $API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.linkedin.com/in/adimoyal"}'

# 2) Universal-Links-only platform (GitHub) — should punt to Safari, then open the GitHub app
curl -s -XPOST "$BASE/api/links" -H "authorization: Bearer $API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://github.com/vercel/next.js"}'
```

Then, on a **real iPhone** with the LinkedIn app **and** the GitHub app installed:

| # | Steps | Pass criterion |
|---|---|---|
| 1 | DM the **LinkedIn** short link to yourself in **Instagram**. Tap it (opens IG's webview). | The **LinkedIn app** opens on the profile (scheme fired in-webview). |
| 2 | Same link, but tap **"Open in the linkedin app"** button instead of waiting. | LinkedIn app opens (gesture path works). |
| 3 | DM the **GitHub** short link in **Instagram**. Tap it. | Page tries the Safari punt; **Safari** opens and the **GitHub app** takes over (Universal Link). If the silent punt is blocked, the **"Open in Safari ↗"** button must do it on tap. |
| 4 | Repeat #1 and #3 inside **TikTok** and **LinkedIn** webviews. | Same outcomes. |
| 5 | Open either link in **real Safari** (paste in address bar). | App opens (scheme / UL); no dead end. |
| 6 | On any link, if no app is installed, wait ~1.5 s. | The page **stays put** and the copy changes to "Welp — the &lt;app&gt; app didn't open. Pick your fighter 👇". No automatic redirect. |
| 7 | From that state, tap **"Continue in browser"**. | Lands on the correct web page (the rich fallback page when the link has one) — never a dead end. |

## Honest confidence

- **Scheme platforms (#1, #2, #4-scheme): high** — mirrors URLgenius's measured behavior.
- **GitHub Safari punt (#3): moderate** — `x-safari-https` is degraded (Instagram blocks
  the *silent* form); the **"Open in Safari ↗"** tap target is the reliable path and is
  always present, so the worst case is one extra tap, never a dead end.

## Batch 2 platforms (2026-07) — real-device spot checks

Same webview + real-Safari matrix as above. Prioritise the moderate-confidence schemes.

| # | Link to shorten | Device / context | Pass criterion |
|---|---|---|---|
| 7 | `https://open.spotify.com/track/4oktVvRuO1In9B7Hz0xm0a` | iPhone, Instagram webview | Spotify app opens the track (an "Open in Spotify?" prompt is acceptable) |
| 8 | `https://www.amazon.com/dp/B01N05APQY?tag=YOURID-20` | iPhone, Instagram webview | Amazon app opens the product **and** `?tag=` is present. Then place a **test order** and confirm the tag in Associates reporting (attribution is Amazon's black box) |
| 9 | `https://t.me/durov` | iPhone, TikTok webview | Telegram app opens the channel |
| 10 | `https://threads.net/@zuck` | iPhone, Instagram webview | Threads app opens the profile (upgrades `barcelona://` from moderate → high once seen live) |
| 11 | `https://discord.gg/<a-real-invite>` | iPhone, Instagram webview | Discord app opens the invite (the `-/invite/` route) |
| 12 | `https://snapchat.com/add/<user>` | **Android**, Instagram webview | Snapchat opens the add-friend screen. On **iOS** it correctly lands on the web page (ANDROID_ONLY, like GitHub) |
| 13 | `https://apps.apple.com/us/app/instagram/id389801252` | iPhone, any webview | App Store app opens the listing (`itms-apps` system scheme) |
| 14 | `https://play.google.com/store/apps/details?id=com.spotify.music` | **Android**, any webview | Play Store app opens the listing; on **iOS** → web (no Play app) |

### Facebook — verify the two lanes
- `https://www.facebook.com/profile.php?id=<numeric>` → FB app opens that profile.
- `https://www.facebook.com/<vanity-name>` → opens the page inside the FB app's own webview
  (`facewebmodal`) — an in-app webview, not a fresh native screen, but it escapes the host social
  webview, which is the win.
