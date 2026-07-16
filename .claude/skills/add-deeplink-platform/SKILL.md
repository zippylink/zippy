---
name: add-deeplink-platform
description: Add (or fix) a native-app deep-link platform to Zippy's redirect engine — EVIDENCE-FIRST. Use when someone wants Zippy to open a new app (Spotify, Amazon, Telegram, a niche app…) from a shared link, or when an existing platform's app-open stopped working. Encodes the verdict taxonomy (SHIP / ANDROID_ONLY / SKIP), the primary-source research bar (no invented schemes), the platforms.ts data contract, the test matrix, and the iOS in-app-webview escape rules. Covers single-platform and batch (many-at-once via a Workflow fan-out) modes.
---

# Add a deep-link platform (evidence-first)

Zippy's whole value is that a link tapped **inside an in-app browser** (Instagram, TikTok,
LinkedIn webviews) opens the **real native app**, not the crippled webview. Each supported
app is one row in `services/redirect/src/platforms.ts`. Adding a platform is 90% *research*
and 10% code — because the failure mode isn't a crash, it's **shipping a scheme that
doesn't exist and quietly sending everyone to the browser while claiming app-open**.

**The non-negotiable rule: never invent a scheme or a path form.** Every `scheme://` and
every path mapping must trace to a primary source or a real-device observation. A guessed
scheme is worse than no entry — the honest fallback (open the web URL) is always available.

---

## 0. The design property that makes this safe

The engine derives three link forms from each platform row, uniformly:

- **iOS** → `scheme://path` (fired via `window.location` in the interstitial; a JS timer
  falls back to the web URL if nothing handles the scheme).
- **Android** → `intent://path#Intent;scheme=…;package=…;S.browser_fallback_url=<web>;end`
  (the OS falls back to the web URL **natively** if the app is absent — no JS needed).
- **web** → the original https destination (always correct).

So a **wrong scheme degrades to "opens in browser," never to a broken link.** This is why
the research bar is "evidence the scheme opens the app on the *current* app version," not
"perfection" — and why, when unsure between a content-deep-scheme and just opening the app,
you pick `path: () => ""` (open the app home; the web fallback still lands the exact content).

---

## 1. The verdict taxonomy (decide this per platform BEFORE coding)

| Verdict | Meaning | Ships as |
|---|---|---|
| **SHIP** | The iOS app registers a **verified, current custom scheme** AND Android has a package. | Full row: iOS scheme-open + Android intent + web fallback. |
| **ANDROID_ONLY** | iOS app is **Universal-Links-only** (no custom scheme — e.g. GitHub). Android intent still opens it. | Row with `scheme` encoding the **https** form so iOS resolves to web (the engine's `hasScheme` check keys off this); Android intent opens the app; the interstitial adds the `x-safari-https://` Safari-punt + an "Open in Safari ↗" gesture button for iOS webviews. |
| **SKIP** | No reliable app-open on either OS, or the scheme can't be verified. | Nothing. Document why so the next person doesn't re-chase it. |

**Universal-Links-only is the trap.** Modern apps (GitHub, increasingly others) drop custom
schemes and rely on Universal Links — which **do not fire inside in-app webviews** (that's
the exact gap Zippy exists to close). If an app is UL-only, iOS cannot silently open it from
a webview; the honest answer is ANDROID_ONLY + the gesture-path Safari button. Don't fake it.

---

## 2. Phase 1 — RESEARCH (primary sources, dated, adversarial)

For the candidate app, answer each with evidence:

1. **Does the iOS app register a custom URL scheme in 2026?** What is it? (`spotify:`,
   `fb://`, `tg://`, `snapchat://`, `comgooglemaps://`, …)
   - Primary: the app's own deep-linking / developer docs.
   - Good secondary: **maintained** known-scheme lists — search
     `FokkeZB/url-schemes`, Tanaschita's iOS URL scheme reference, Branch/RevenueCat scheme
     tables, Adjust/AppsFlyer app-scheme references.
   - Reality check: recent (2024+) StackOverflow / dev-forum reports of the scheme
     working **or breaking**. An old blog is folklore; a dated "still works on vX" is evidence.
   - **UL-only check:** fetch the app's live `https://<host>/apple-app-site-association`
     — if it maps paths but the app publishes no scheme, it's UL-only → ANDROID_ONLY. (This
     is exactly how GitHub was pinned down.)
2. **Are the PATH FORMS right?** e.g. `open.spotify.com/track/ID → spotify:track:ID`,
   `t.me/user → tg://resolve?domain=user`, `twitter.com/u/status/N → twitter://status?id=N`.
   Only record mappings you have evidence for; everything else → `""` (open app home).
   - Watch the historically-flaky ones: **LinkedIn** (partial scheme support, path forms
     drift), **Product Hunt** (suspected UL-only — verify before trusting `producthunt://`).
3. **Android package id** — read it straight off the Play Store URL
   (`play.google.com/store/apps/details?id=com.spotify.music` → `com.spotify.music`).
4. **In-app-webview behavior** — anything special (Instagram's `ig_ib`, TikTok's webview
   quirks). Note it for the implementer.

**What urlgenius actually does (measured, so you don't over-engineer):** for custom-scheme
platforms it simply **fires `scheme://` from inside the webview** (which opens the app) +
a manual tap button + a timed web fallback. **No `x-safari` punt for scheme platforms** — the
Safari punt is only for UL-only apps. Zippy already does the scheme-fire; match that, don't
gold-plate.

Write the finding into `services/redirect/docs/` (append to the platform notes) — sources,
dates, verdict, and *why*. The SKIP reasons matter as much as the SHIP ones.

### Batch mode (researching many apps at once)

Fan out one research agent per candidate via a **Workflow** with `parallel()` and a
**structured-output schema** (verdict / confidence / iosScheme / universalLinksOnly /
androidPackage / pathForms / hosts / sources / notes). Prompt each agent with the rules
above. Collect the results into a table, review the evidence quality yourself (reject
low-confidence "SHIP"s that cite only folklore), THEN implement the winners in one pass.
See the run that added the first batch: it verified 12 apps ICP-first (Amazon → Spotify →
Facebook → …). One agent per app keeps each verdict independently sourced.

---

## 3. Phase 2 — IMPLEMENT (`services/redirect/src/platforms.ts`)

Add ONE object to `PLATFORMS`:

```ts
{
  key: "spotify",
  scheme: "spotify",                 // SHIP: the verified scheme. ANDROID_ONLY: the https form (see below).
  androidPackage: "com.spotify.music",
  hosts: ["spotify.com", "open.spotify.com"],   // lowercased, no leading www.
  path: (url) => {
    const s = url.pathname.split("/").filter(Boolean);
    if (s[0] === "track" && s[1]) return `track:${s[1]}`;   // spotify:track:ID
    if (s[0] === "album" && s[1]) return `album:${s[1]}`;
    if (s[0] === "artist" && s[1]) return `artist:${s[1]}`;
    return "";                        // unknown shape → open the app home; web fallback lands it
  },
},
```

- **SHIP** → `scheme` is the custom scheme; the engine builds `scheme://` + intent + web.
- **ANDROID_ONLY** → encode the row so the derived iOS form is the **https** URL (mirror
  how `github` is done — read that entry). The engine's `hasScheme =
  !match.ios.startsWith("https://")` check then routes iOS to web + the Safari-punt gesture,
  Android to intent. Don't hand-roll interstitial logic; the row + the existing engine handle it.
- Reserved-path sets (like `IG_RESERVED`, `X_RESERVED`) exist for profile-at-root apps where
  the first path segment might be a username OR a reserved route — add one if your app needs it.
- Keep the `path()` pure and total (always returns a string; never throws).

**Never** touch the interstitial, the KV layer, or add a dependency for a platform add. If a
platform seems to need engine changes, it's either ANDROID_ONLY (already handled) or a SKIP.

---

## 4. Phase 3 — TEST (`test/platforms.test.ts`)

One assertion block per verified URL shape. For each: URL in → expected `ios`, `android`
(intent string w/ scheme+package+encoded fallback), `web`. Mirror the existing platform
tests exactly. For ANDROID_ONLY, assert iOS = the https URL and the webview escape behavior
in `worker.test.ts` (the github tests are the template). **All existing tests stay green** —
run `bun --filter @zippy/redirect test` and confirm the count went UP, not sideways.

Drive whatever's live-checkable with the running worker:

```bash
bun --filter @zippy/redirect dev    # :8787
# create a link, then curl with platform UAs:
curl -s -A "…iPhone… Instagram" http://localhost:8787/<slug> | grep -oE 'spotify://[^"]*'
curl -s -A "…Android… Chrome Mobile" http://localhost:8787/<slug> | grep -oE 'intent://[^"]*'
```

A webview→app handoff can **only** be fully verified on a real device (curl sees the served
HTML, not the OS action). Add the platform to the real-device checklist in
`services/redirect/test/manual-ios-escape.md`.

---

## 5. Phase 4 — DOCS (keep the count honest)

- `apps/docs/content/docs/reference/platforms.mdx` — add the row; mark iOS behavior
  truthfully (SHIP = "opens app"; ANDROID_ONLY = "Android opens app, iOS → Safari").
- `README.md` + any "N platforms" count — bump it.
- `CONTRIBUTING.md` already points here; if you learned a new gotcha, add it to §2 above.

---

## 6. Checklist (all must hold before the PR)

- [ ] Every scheme + path form traces to a **primary source or real-device test** (no folklore).
- [ ] Verdict is explicit (SHIP / ANDROID_ONLY / SKIP) and the reason is documented.
- [ ] UL-only apps shipped as ANDROID_ONLY, never faked as SHIP.
- [ ] `path()` is pure, total, returns `""` for unknown shapes.
- [ ] Tests added per URL shape; full suite green; count increased.
- [ ] Android package id copied from the Play Store URL (not guessed).
- [ ] Docs + platform count updated honestly; real-device checklist appended.
- [ ] No engine/interstitial/dependency changes snuck in with a platform add.

The bar is not "it probably works." The bar is "here's the evidence it opens the app, and
here's exactly what happens when it doesn't." That honesty *is* the product.
