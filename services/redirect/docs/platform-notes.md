# Platform research notes

Evidence, verdicts, and *why* for each platform in `src/platforms.ts` — so the next person
doesn't re-chase a scheme we already verified (or already rejected). Follows the
`add-deeplink-platform` skill: **never invent a scheme or a path form**; a wrong scheme only
degrades to the web fallback, so the bar is "evidence the scheme opens the app," not perfection.

Verdict taxonomy: **SHIP** (verified custom scheme + Android package), **ANDROID_ONLY** (iOS is
Universal-Links-only, so `scheme` encodes the https form — Android intent opens the app, iOS lands
on web + the Safari punt), **SKIP** (no reliable app-open; documented so nobody re-chases it).

## Batch 2 — verified 2026-07

| Platform | Verdict | iOS scheme | Confidence | Key caveat |
|---|---|---|---|---|
| amazon | SHIP | `com.amazon.mobile.shopping.web` | moderate | community-known (not Amazon-documented); affiliate `?tag=` survives in the URL but Amazon doesn't document in-app **attribution** — recommend a test order |
| spotify | SHIP | `spotify` | high | `spotify:track:ID` triggers an iOS "Open in Spotify?" prompt (acceptable — still opens); `?si=` share token dropped |
| facebook | SHIP | `fb` | moderate | `fb://profile/<id>` needs a **numeric** id; vanity URLs use `fb://facewebmodal/f?href=<url>` (opens in the FB app's own webview) |
| pinterest | SHIP | `pinterest` | moderate | only the `pin/<id>/` lane has a verified scheme path; profiles/boards fall back to web (universal links) |
| threads | SHIP | `barcelona` | moderate | codename still the live Android package id; profile opens verified (Jul 2023 primary source), posts fall back to web. A 30s on-device tap of `barcelona://user?username=zuck` would upgrade to high |
| telegram | SHIP | `tg` | high | `tg://` is first-class in Telegram-iOS's Info.plist; `resolve?domain=` (public) + `join?invite=` (private). `t.me/s/<channel>` web-preview URLs are browser-only |
| apple-music | SHIP | `music` | high | HOST-PRESERVING (`music://music.apple.com/<path>`), not the bare-colon Spotify form; own-library playlists unsupported (catalog links unaffected) |
| discord | SHIP | `discord` | high | invite route is `discord://-/invite/<code>` — keep the literal `-/` prefix |
| google-maps | SHIP | `comgooglemapsurl` | high | uses the URL-wrapper scheme (forwards the full maps web URL) rather than structured `comgooglemaps://?q=`. Only `maps.google.com` is claimed — `google.com/maps` shares the `google.com` host, which we must not hijack |
| app-store | SHIP | `itms-apps` | high | iOS system scheme (always installed). Apple host only; Google Play is the separate `play-store` row |
| play-store | SHIP (Android) | `https` (schemeless) | high | github-pattern: `play.google.com` is an https App Link for `com.android.vending` |
| snapchat | ANDROID_ONLY | `https` (schemeless) | moderate | `snapchat://` only opens the camera — **no** add-friend custom-scheme path exists; `snapchat.com/add/<user>` is a Universal Link, so iOS → web, Android intent opens the add-friend screen |
| twitch | SHIP | `twitch` | high | all path forms first-party documented (dev.twitch.tv/docs/mobile-deeplinks): `stream/<channel>`, `video/<id>`, `game/<name>` |

### Notes on schemes that break the one-scheme-per-row model

- **app-store vs play-store split.** An `apps.apple.com` link and a `play.google.com` link point
  at *different stores* and need *different schemes per OS* (`itms-apps` on iOS vs an https
  App-Link intent on Android). One platform row = one scheme, so these are **two rows**, each
  native to its OS and correctly serving web on the other. This keeps the engine untouched.
- **amazon Android.** The generic engine reuses the iOS scheme for the Android intent
  (`scheme=com.amazon.mobile.shopping.web`). If the Android app doesn't claim that scheme, the
  intent degrades to the web URL — with the affiliate `?tag=` still intact. Acceptable; iOS is the
  win.

### Sources (consulted 2026-07)

Primary/official where it exists, maintained scheme lists otherwise. Full URLs are in the batch-2
research record; the load-bearing ones:

- **Telegram** — core.telegram.org/api/links (official); Telegram-iOS Info.plist.
- **Spotify** — developer.spotify.com iOS/Android content-linking (official).
- **Apple Music / App Store** — developer.apple.com; Google Play linking docs (official).
- **Google Maps** — developers.google.com/maps/documentation/urls/ios-urlscheme (official).
- **Discord** — support.discord.com "Discord URI Schemes for developers".
- **Amazon / Facebook / Pinterest / Threads / Snapchat** — maintained known-scheme lists
  (Tanaschita, bhagyas/app-urls, snarfed/open-in-app) + dated dev reports; each carries a
  "may change" disclaimer, hence moderate confidence — safe given the graceful web fallback.

### twitch

Initially deferred (its batch research agent hit a transient safety-classifier block), then
verified against Twitch's own first-party deeplink docs (dev.twitch.tv/docs/mobile-deeplinks) —
SHIP, high confidence. Path forms: `stream/<channel>`, `video/<id>`, `game/<name>`.
