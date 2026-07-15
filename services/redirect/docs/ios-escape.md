# iOS in-app-webview escape — evidence & technique

**Question:** when a Zippy link is tapped *inside* Instagram / TikTok / LinkedIn's
in-app browser (a `WKWebView`), how do we get the destination to open in the
**native app**, the way URLgenius / Branch / AppsFlyer do — instead of dead-ending
in the trapped webview?

This doc is the evidence behind the technique in `interstitial.ts`. Fetched 2026-07-16.

---

## 1. What URLgenius actually does (measured, not assumed)

I fetched two live URLgenius demo links under two User-Agents — an **Instagram
in-app-webview** UA and a **plain iOS Safari** UA — and diffed the served HTML/JS.

Links: `https://urlgeni.us/instagram/urlgenius` (scheme platform),
`https://urlgeni.us/linkedin/urlgenius` (scheme platform).

### The served page bakes three URLs and fires the custom scheme

```js
window.app_scheme    = "instagram://user?username=urlgenius";
window.app_store_url = "https://apps.apple.com/app/instagram/id389801252";
window.mobile_web    = "https://www.instagram.com/urlgenius/";

if (window.app_scheme) {
  window.location = window.app_scheme;          // (1) fire the custom scheme
  setTimeout(function () {
    if (window.fallback_destination === "mobile_web") {
      window.location = window.mobile_web;       // (2) 500ms → web fallback
    } else { /* reveal choice buttons */ }
  }, 500);
}
setTimeout(() => { $('#choice-section').css("display","block") }, 2000); // (3) 2s → manual buttons
```

And the manual tap targets it reveals after 2s:

```html
<a id="app-button"     href="instagram://user?username=urlgenius">Open In App</a>
<a id="browser-button" href="https://www.instagram.com/urlgenius/">Open In Browser</a>
```

### Verdict — the surprising part

**For a platform that HAS a custom scheme, URLgenius does NOT punt to Safari at all.**
It fires `instagram://…` (or `linkedin://…`) straight from inside the webview — the
custom scheme launches the app directly, no Safari hop needed. I grepped their entire
156 KB `launch.js` and the served pages: **zero** occurrences of `x-safari-https`,
`googlechrome`, `com.apple.*`, `SFSafari`, `intent://`, or any webview UA-sniff. The
whole "escape" for scheme platforms is: **fire the scheme + timed web fallback + a
manual `<a href="scheme://">` the user can tap.**

That is *already what Zippy's interstitial does* for the auto-fire — Zippy was missing
only the **manual tap-target buttons** (the gesture path for webviews that block the
silent auto-fire).

I could not find a URLgenius demo link for a **schemeless / Universal-Links-only** app
(e.g. GitHub) to observe its behavior there — all their homepage demos are scheme
platforms. So the schemeless technique below is sourced from the primary articles, not
from an observed URLgenius page.

---

## 2. The `x-safari-https://` punt — current (2026) reality

Sources:
- DEV Community, "Escaping Instagram's In-App Browser on iOS (and Why It's So Hard)"
  <https://dev.to/jplogix/escaping-instagrams-in-app-browser-on-ios-and-why-its-so-hard-58om>
- JHRUNNING, zero-dependency escape library, v1.0.0 **Nov 2025**
  <https://jhrun.com/2025/11/escape-in-app-browser-programmatically-introducing-a-zero-dependency-javascript-library/>

Findings:

- **`x-safari-https://<url>`** is a real iOS scheme that opens `<url>` in real Safari
  from inside a webview. It is **degraded, not dead**: "Modern apps like Instagram
  actively intercept and block this." It still fires in some webviews and costs nothing
  to attempt, so it stays as the *first* silent attempt for schemeless apps.
- **`googlechrome(s)://`** can punt to Chrome but triggers a system "Chrome wants to
  open another app" prompt — user-hostile, skip it.
- **Universal Links** are the most *reliable* silent path, but Instagram intercepts
  those too. There is **no 100% silent escape** anymore — it's cat-and-mouse.
- The honest reliable fallback is a **user-gesture tap target** ("Open in Safari ↗").
  A tap is a user gesture, which webviews permit to launch the escape even when they
  block the automatic one.
- Webview UA signatures (from the Nov-2025 library):
  `instagram: /Instagram/i`, `facebook: /FBAN|FBAV|FB_IAB/`, `linkedin: /LinkedInApp/i`,
  plus TikTok `musical_ly|BytedanceWebview` and Snapchat.

---

## 3. When is the Safari punt even needed?

| Platform kind | In-app webview behavior | Needs Safari punt? |
|---|---|---|
| **Has a custom scheme** (instagram, linkedin, x, tiktok, youtube, reddit, whatsapp, producthunt) | `scheme://…` fired via `window.location` **opens the app directly from inside the webview** | **No.** The scheme is the escape. |
| **Schemeless / Universal-Links only** (github) | `https://…` just navigates the webview; the UL does **not** fire inside a webview → dead-ends on the web page | **Yes** — punt to Safari so the UL can fire → app. |

So the Safari punt matters for **exactly one** platform in Zippy's table today:
**github**. The other eight already escape via their scheme.

---

## 4. Technique chosen (implemented in `interstitial.ts`)

Layered, best-to-worst, degrades to the web URL at every step (never a dead end):

- **Android, any context** → `intent://…;package=…;S.browser_fallback_url=…;end`.
  Robust *inside* Android webviews too; falls back to web natively. **Unchanged.**
- **iOS + platform HAS a scheme** → auto-fire `scheme://…` (unchanged) **+ new**: a
  visible **"Open in App"** `<a href="scheme://…">` tap target (the gesture path for
  webviews that block the silent auto-fire — this is URLgenius's `#app-button`).
- **iOS + schemeless (github) + in-app webview** → auto-attempt
  `x-safari-https://github.com/…` **+** a visible **"Open in Safari ↗"** tap target
  (gesture path). Both degrade to the web link after the fallback timer.
- **iOS + schemeless (github) + real Safari** → just navigate the https URL; its
  Universal Link fires natively → app. No punt, no extra button.
- **Desktop / real browser** → 301, no interstitial. **Unchanged.**

Signals used (no new data model):
- `hasScheme = !match.ios.startsWith("https://")` — the schemeless platforms already
  encode `ios` as an `https://` URL, so this one check separates github from the rest.
- `x-safari-` punt = `"x-safari-" + match.web` → `x-safari-https://github.com/…`.
- Webview detection: `inAppWebview(ua)` UA-sniff (Instagram/FB/TikTok/LinkedIn/Snapchat).

## 5. Honest confidence & what needs a real device

- **Scheme platforms (8): high.** Firing the scheme in-webview is exactly URLgenius's
  measured behavior; the added tap target only helps.
- **github Safari-punt: moderate.** `x-safari-https` is degraded (Instagram blocks the
  *silent* form); the **tap target is the reliable path** and is always present, so the
  worst case is "user taps once to land in Safari," never a dead end.
- A webview escape **cannot** be verified with curl/headless — curl sees the served HTML
  (which we unit-test), but only a real iPhone with the real Instagram/TikTok webview
  exercises the OS scheme handoff. See `test/manual-ios-escape.md` for the device
  checklist that the deploy smoke test runs.
