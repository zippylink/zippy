import type { PlatformMatch } from "./platforms.js";

// Minimal, self-contained HTML. No external assets — it must render instantly on
// a cold mobile connection, so everything is inline.
//
// Strategy (see docs/ios-escape.md for the evidence behind it):
//   iOS + custom scheme  — fire `scheme://…`; the scheme opens the app DIRECTLY even
//              from inside an in-app webview (Instagram/TikTok/LinkedIn). This is exactly
//              what URLgenius does — no Safari punt is needed when a scheme exists.
//   iOS + schemeless (github, Universal-Links only) IN a webview — punt to real Safari
//              via `x-safari-https://…` so the Universal Link can fire (a UL never fires
//              inside a webview). Degraded (Instagram blocks the silent form), so a
//              tap-target "Open in Safari ↗" is always shown as the user-gesture path.
//   iOS — a visible tap target re-fires the escape on tap; some webviews only allow the
//              escape on a user gesture, not the automatic one.
//   Android  — hand the browser the intent:// URL and let Chrome fall back to
//              browser_fallback_url NATIVELY. Chrome proper handles this; an Android
//              webview that swallows intent:// does NOT, which is why the copy timer runs
//              on this path too. UNMEASURED BY CONSTRUCTION — we record one `unmeasured`
//              row and no app-open outcome (see the Android branch below for why).
//
// visibilitychange is the honest signal the app launched (the page is hidden while iOS
// switches apps) — on iOS ONLY. Chrome fires it on unload too, so it does not discriminate
// there. Every app-open rate this engine produces is therefore an iOS rate.
//
// ANDROID IS UNMEASURED — and the data says so out loud.
//   We hand intent:// to the OS and it self-falls-back via S.browser_fallback_url. Good UX
//   trade, measurement dead end: Chrome fires visibilitychange->hidden as part of its
//   UNLOAD sequence, not only on backgrounding, so a tab NAVIGATING to the fallback (the
//   failure) is indistinguishable from a tab backgrounding to a launched app (the
//   success). An "opened" listener on that path would relabel failures as successes and
//   read near-100% by construction — which is exactly the bug this branch used to have,
//   because the listener sat ABOVE the branch while both "browser" emitters sat below it.
//   So Android registers NO outcome listener and writes one explicit "unmeasured" row
//   instead; sendBeacon queues before the replace, so it survives the navigation.
//   LAW FOR EVERY CONSUMER: "unmeasured" is in NEITHER the numerator NOR the denominator
//   of any rate. It is reportable only as its own count, labelled unmeasured.
//   The copy timer runs on this path too (an Android webview that swallows intent://
//   leaves the page alive AND visible, and the visitor would otherwise stare at
//   "Opening the X app…" forever). It is guarded on VISIBILITY rather than on `done`:
//   `done` is already true on Android from the unmeasured row, yet nothing has opened.
//
//   THE FLAG (index.ts ANDROID_FALLBACK_MEASURE=1) attacks the dead end from the SERVER
//   side, not from here: it aims browser_fallback_url at /:slug?fb=1 — a URL we serve — so
//   the failure hop is delivered to us and recorded as an OBSERVED "browser" row. This
//   file is deliberately identical either way. Nothing on this page can tell the two
//   Android fates apart, so nothing on this page tries; "unmeasured" still means "dispatched
//   to the OS", and with the flag on it is the observed "browser" rows that subtract from it.
//
// We do NOT navigate when the app doesn't open. An automatic redirect a second and a half
// after the tap reads as a glitch ("why am I here?"), so the page stays put, says out loud
// that the app didn't open, and hands the visitor the two real anchors already on it.
//
// UX AND MEASUREMENT ARE SEPARATE CLOCKS — they want different numbers:
//   COPY_SWAP_MS  is a UI honesty signal. It ONLY rewrites the copy, never beacons. A
//                 1.5s-slow launch is common; calling that "stayed in browser" would
//                 undercount real app opens, and worst on the retry-tap flow this UX
//                 now encourages.
//   LONGSTOP_MS   is the measurement backstop for a visitor who just sits on the page.
// "browser" is otherwise recorded on `pagehide` — the point at which it is actually true
// (they tapped "Continue in browser", or closed the tab). Net effect: a retry tap that
// lands in the app inside the long-stop window counts as "opened", which is the honest
// answer to "did this link ultimately get them into the app".
const COPY_SWAP_MS = 1500;
const LONGSTOP_MS = 9000;

// In-app webviews that trap taps on iOS. Best-effort UA sniff — used only to pick the
// iOS escape technique + button copy; a miss degrades to the plain web link, never a
// dead end. Signatures per the Nov-2025 escape-library survey (see docs/ios-escape.md).
const WEBVIEW_UA: Array<[string, RegExp]> = [
  ["instagram", /Instagram/i],
  ["facebook", /FBAN|FBAV|FB_IAB/],
  ["tiktok", /musical_ly|BytedanceWebview|TikTok/i],
  ["linkedin", /LinkedInApp/i],
  ["snapchat", /Snapchat/i],
];

/** Name of the in-app webview this UA belongs to, or null for a real browser. */
export function inAppWebview(ua: string): string | null {
  for (const [name, re] of WEBVIEW_UA) if (re.test(ua)) return name;
  return null;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Any value → a JS literal safe to inline in a <script> block.
 *
 * SECURITY: bare JSON.stringify is NOT safe here. JSON is not a subset of HTML — a
 * "</script>" inside any string value closes the tag early and everything after it is
 * parsed as markup (XSS). Escaping "<" to < is inert in JS and can't break out.
 * Applies to objects too, so every inline literal goes through this one door — the engine
 * is self-hostable and self-hosters write KV records directly, so it must NOT rely on the
 * cloud's slug/URL validation to stay safe.
 */
const jsLit = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c");

// ---------------------------------------------------------------------------
// Retargeting pixels (Wave 2.8). The cloud denormalizes `px` into the KV record;
// ids reach here ONLY after parseLinkValue's whitelist (/^[A-Za-z0-9_-]{1,32}$/) —
// that charset is the injection guard for the inline interpolation below.
// ---------------------------------------------------------------------------
export type PixelTag = { t: "meta" | "tiktok" | "gtm"; id: string };

// Canonical minimal loaders: Meta Pixel base + PageView, TikTok base + page, GTM gtm.js.
const PIXEL_TEMPLATES: Record<PixelTag["t"], (id: string) => string> = {
  meta: (id) =>
    `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${id}');fbq('track','PageView');</script>`,
  tiktok: (id) =>
    `<script>!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=i,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};var o=document.createElement("script");o.type="text/javascript",o.async=!0,o.src=i+"?sdkid="+e+"&lib="+t;var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};ttq.load('${id}');ttq.page();}(window,document,'ttq');</script>`,
  gtm: (id) =>
    `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${id}');</script>`,
};

/** Inline loader snippets for the link's validated pixel tags ("" when none). */
export function pixelSnippets(px?: PixelTag[]): string {
  if (!px?.length) return "";
  return px.map((p) => PIXEL_TEMPLATES[p.t](p.id)).join("\n");
}

/**
 * Minimal pixel page for links that would otherwise plain-30x (desktop / no platform
 * match) but carry `px`: fire the pixels, then bounce to the destination. Functional,
 * unbranded on purpose — beauty is cloud-only.
 */
export function renderPixelPage(dest: string, px: PixelTag[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Redirecting…</title>
${pixelSnippets(px)}
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#FAF7F2;color:#1A1033;text-align:center}
  a{color:#FF3E8A}
</style>
</head>
<body>
<main>
  <p>zipping you along…</p>
  <p><a href="${esc(dest)}">Continue</a></p>
</main>
<script>setTimeout(function(){window.location.replace(${jsLit(dest)})},400)</script>
</body>
</html>`;
}

// Code-drawn Zippy, inline SVG only — the worker HTML must stay tiny (no external
// requests, no PNGs). On brand: chunky volt #EEFF00 bolt, darker volt #C7D400 side
// edge (the flat fake-3D), thick ink #1A1033 outline, two dot eyes + a mouth,
// magenta/cyan sparks. No limbs (bolt body + face only). `sad` droops it for the 404.
const BOLT = "64,20 150,20 108,120 150,120 86,262 104,150 64,150";
function zippyBolt(sad = false): string {
  const eyeY = sad ? 66 : 60;
  const mouth = sad
    ? `<path d="M84,94 Q100,82 116,94" fill="none" stroke="#1A1033" stroke-width="5" stroke-linecap="round"/>`
    : `<path d="M84,80 Q100,94 116,80" fill="none" stroke="#1A1033" stroke-width="5" stroke-linecap="round"/>`;
  const brows = sad
    ? `<path d="M80,52 l14,4" stroke="#1A1033" stroke-width="4" stroke-linecap="round" fill="none"/><path d="M124,50 l-14,4" stroke="#1A1033" stroke-width="4" stroke-linecap="round" fill="none"/>`
    : "";
  return (
    `<svg class="z" viewBox="0 0 200 280" width="92" height="128" aria-hidden="true">` +
    `<polygon points="${BOLT}" fill="#C7D400" transform="translate(8,7)"/>` +
    `<polygon points="${BOLT}" fill="#EEFF00" stroke="#1A1033" stroke-width="9" stroke-linejoin="round"/>` +
    brows +
    `<circle cx="90" cy="${eyeY}" r="7" fill="#1A1033"/>` +
    `<circle cx="118" cy="${eyeY - 3}" r="7" fill="#1A1033"/>` +
    mouth +
    `<path d="M30,58 l-11,13 8,1 -9,12" fill="none" stroke="#FF3E8A" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="M172,50 l11,13 -8,1 9,12" fill="none" stroke="#22D8FF" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>` +
    `</svg>`
  );
}

// The mascot. FOUNDER CALL 2026-07-22: wherever an asset base is configured (LANDING_URL —
// the hosted product), the approved 3D-sticker PNGs from the landing's /brand replace the
// code-drawn SVG sketch, which the founder ruled off-model for user-facing surfaces. The
// SVG stays ONLY as the dependency-free fallback for self-hosters with no LANDING_URL —
// their interstitial keeps working with zero external requests, exactly as before.
type MascotMood = "zoom" | "happy" | "sad" | "detective";
const MASCOT_FILE: Record<MascotMood, string> = {
  zoom: "zippy-sticker-zoom.png", //   "opening…" — Zippy zooming to the app
  happy: "zippy-sticker-happy.png", // password gate
  sad: "zippy-sad.png", //             the welp state (app didn't open)
  detective: "zippy-detective.png", // 404 — hunting the missing link
};
/** PNG url for a mood, or null when no asset base is configured (SVG fallback). */
const mascotSrc = (assetBase: string | undefined, mood: MascotMood): string | null =>
  assetBase ? `${assetBase.replace(/\/$/, "")}/brand/${MASCOT_FILE[mood]}` : null;
function mascot(assetBase: string | undefined, mood: MascotMood, id?: string): string {
  const src = mascotSrc(assetBase, mood);
  if (!src) return zippyBolt(mood === "sad" || mood === "detective");
  return `<img${id ? ` id="${id}"` : ""} class="z" src="${esc(src)}" alt="" width="128" height="128" style="object-fit:contain">`;
}

export function renderInterstitial(
  match: PlatformMatch,
  opts?: {
    branded?: boolean;
    homeUrl?: string;
    /** Base URL serving /brand sticker PNGs (the landing). Unset → inline-SVG mascot. */
    assetBase?: string;
    ua?: string;
    slug?: string;
    host?: string;
    /** Rich fallback page — where "Continue in browser" points instead of the web URL. */
    fbu?: string;
    /** Validated retargeting pixel tags — injected into the head, fire on the creator's behalf. */
    px?: PixelTag[];
    /** Index of the A/B variant this visitor was routed to. Undefined on the overwhelming
     *  majority of links (no split) — JSON.stringify then drops it and the beacon body is
     *  byte-identical to a non-A/B link's. Re-validated server-side in handleBeacon. */
    abVariant?: number;
  },
): string {
  // Branding footer only when the record says so (the cloud bakes in this effect).
  const footer = opts?.branded
    ? `<p style="margin-top:1.5rem;font-size:.7rem;opacity:.6"><a href="${esc(opts.homeUrl ?? "")}">⚡ zipped with Zippy</a></p>`
    : "";

  // Escape plan (iOS). The schemeless platforms encode `ios` as an https:// URL, so this
  // one check separates github (Universal-Links only) from the eight scheme platforms —
  // no new data model needed.
  const ua = opts?.ua ?? "";
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const webview = inAppWebview(ua);
  const hasScheme = !match.ios.startsWith("https://");
  const safariPunt = "x-safari-" + match.web; // → x-safari-https://<dest>, punts to real Safari
  // iOS auto-navigation target: the scheme, or (github-in-webview) the Safari punt, else web.
  const iosPrimary = hasScheme ? match.ios : webview ? safariPunt : match.web;
  // Visible tap target = the user-gesture path (some webviews only escape on a tap).
  const escape = isIOS
    ? hasScheme
      ? { href: match.ios, label: `Open in the ${esc(match.key)} app` }
      : webview
        ? { href: safariPunt, label: "Open in Safari ↗" }
        : null
    : null;
  const escapeBtn = escape
    ? `<p><a id="escape" href="${esc(escape.href)}" style="display:inline-block;margin-bottom:.6rem;padding:.7rem 1.4rem;border-radius:12px;background:#1A1033;color:#EEFF00;text-decoration:none;font-weight:700">${escape.label}</a></p>`
    : "";
  // "Continue in browser" = the rich fallback page when the record carries one, else the
  // plain web URL. Nothing else routes there any more, so this anchor IS that surface's door.
  const fallbackHref = opts?.fbu ?? match.web;
  // Swapped in once the copy timer says the app hasn't opened — the page stops pretending.
  const noAppMsg = `Welp — the ${match.key} app didn't open. Pick your fighter 👇`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Opening ${esc(match.key)}…</title>
${pixelSnippets(opts?.px)}
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#FAF7F2;color:#1A1033}
  main{text-align:center;padding:2rem}
  .z{transform-origin:center;animation:z 1.15s cubic-bezier(.34,1.56,.64,1) infinite}
  @keyframes z{50%{transform:scale(1.08)}}
  .dot{display:inline-block;width:.55rem;height:.55rem;margin:0 .15rem;border-radius:50%;background:#1A1033;animation:b 1s infinite alternate}
  .dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}
  @keyframes b{to{opacity:.2}}
  a{color:#FF3E8A}
  @media(prefers-reduced-motion:reduce){.z{animation:none}}
</style>
</head>
<body>
<main>
  ${mascot(opts?.assetBase, "zoom", "zm")}
  <p id="status">Opening the ${esc(match.key)} app<span class="dot"></span><span class="dot"></span><span class="dot"></span></p>
  ${escapeBtn}
  <p><a id="fallback" href="${esc(fallbackHref)}">Continue in browser</a></p>
  ${footer}
</main>
<script>
(function(){
  var iosPrimary = ${jsLit(iosPrimary)};
  var android = ${jsLit(match.android)};
  // Outcome telemetry (POST /t on this same short-domain origin). A rate/trend
  // signal, not per-click truth: the page going hidden = the app launched ("opened");
  // the timer firing while still visible = stayed in the browser ("browser").
  var beaconBody = ${jsLit({ slug: opts?.slug ?? "", host: opts?.host ?? "", platformKey: match.key, sourceApp: webview ?? "", abVariant: opts?.abVariant })};
  function beacon(outcome){
    try {
      beaconBody.outcome = outcome; beaconBody.ts = Date.now();
      navigator.sendBeacon("/t", JSON.stringify(beaconBody));
    } catch(e){}
  }
  // ONE outcome per click, ever. Every send routes through this guard — the page now
  // outlives the timers (nothing navigates away), so an unguarded second beacon would
  // double-count exactly the flow this UX invites: time out, tap retry, app opens late.
  var done = false;
  function send(o){ if(done) return; done = true; beacon(o); }
  // UX clock — copy only, NO beacon. Above the Android branch on purpose; visibility-
  // guarded, not done-guarded. See ANDROID IS UNMEASURED in the file header.
  setTimeout(function(){
    if(document.visibilityState !== "visible") return;
    var s = document.getElementById("status");
    if(s) s.textContent = ${jsLit(noAppMsg)}; // textContent also drops the "…" dots
    var zm = document.getElementById("zm"), sad = ${jsLit(mascotSrc(opts?.assetBase, "sad"))};
    if(zm && zm.tagName === "IMG" && sad) zm.setAttribute("src", sad);
  }, ${COPY_SWAP_MS});
  // Android: one unmeasured row, hand off, register NOTHING. File header says why.
  var isAndroid = /Android/i.test(navigator.userAgent);
  if (isAndroid) { send("unmeasured"); window.location.replace(android); return; }
  // iOS only below. Safari does not fire visibilitychange on unload; Chrome does.
  document.addEventListener("visibilitychange", function(){ if(document.hidden) send("opened"); });
  // Measurement clock — "browser" recorded only where it's true: they left the page
  // (tapped "Continue in browser" / closed the tab), or they sat here past the long stop.
  // ORDER MATTERS: backgrounding to a launched app fires visibilitychange BEFORE pagehide,
  // so "opened" always claims the single send first and this listener no-ops on that path.
  window.addEventListener("pagehide", function(){ send("browser"); });
  setTimeout(function(){ send("browser"); }, ${LONGSTOP_MS});
  window.location.replace(iosPrimary); // scheme opens the app; x-safari punts github to Safari
})();
</script>
</body>
</html>`;
}

/**
 * Password gate — shown before a protected link's destination is ever revealed. The
 * owner set a password in the cloud; the engine stores only its SHA-256 hash (never the
 * plaintext) and compares here. Minimal, self-contained, on brand — a single form that
 * POSTs the password back to this same short URL. `error` re-renders after a wrong try.
 */
export function renderPasswordGate(opts: {
  slug: string;
  error?: boolean;
  branded?: boolean;
  homeUrl?: string;
  /** Base URL serving /brand sticker PNGs (the landing). Unset → inline-SVG mascot. */
  assetBase?: string;
}): string {
  const err = opts.error
    ? `<p style="margin:.25rem 0 0;color:#FF3E8A;font-weight:700">Nope — wrong password. Try again.</p>`
    : "";
  const footer = opts.branded
    ? `<p style="margin-top:1.5rem;font-size:.7rem;opacity:.6"><a href="${esc(opts.homeUrl ?? "")}">⚡ zipped with Zippy</a></p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Locked link</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#FAF7F2;color:#1A1033}
  main{text-align:center;padding:2rem;max-width:22rem}
  h1{margin:.5rem 0 .25rem;font-size:1.6rem}
  p{margin:.25rem 0}
  form{margin-top:1.25rem;display:flex;flex-direction:column;gap:.6rem}
  input{padding:.75rem .9rem;border:3px solid #1A1033;border-radius:12px;font-size:1rem;background:#fff;color:#1A1033}
  input:focus{outline:none;box-shadow:4px 4px 0 0 #22D8FF}
  button{padding:.75rem 1.4rem;border:3px solid #1A1033;border-radius:12px;background:#EEFF00;color:#1A1033;font-weight:800;font-size:1rem;cursor:pointer;box-shadow:4px 4px 0 0 #1A1033}
  button:active{transform:translate(2px,2px);box-shadow:2px 2px 0 0 #1A1033}
  a{color:#FF3E8A}
</style>
</head>
<body>
<main>
  ${mascot(opts.assetBase, "happy")}
  <h1>This link is locked</h1>
  <p>Enter the password to keep going.</p>
  <form method="POST" action="/${esc(opts.slug)}">
    <input type="password" name="password" placeholder="Password" autofocus autocomplete="off" aria-label="Password" required>
    <button type="submit">Unlock ⚡</button>
    ${err}
  </form>
  ${footer}
</main>
</body>
</html>`;
}

export function render404(homeUrl?: string, assetBase?: string): string {
  const home = homeUrl
    ? `<p style="margin-top:1.25rem;font-size:.8rem"><a href="${esc(homeUrl)}">← back to Zippy</a></p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link not found</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#FAF7F2;color:#1A1033;text-align:center}
  main{padding:2rem}
  h1{margin:.5rem 0 .25rem;font-size:2.5rem}
  a{color:#FF3E8A}
</style>
</head>
<body><main>${mascot(assetBase, "detective")}<h1>404</h1><p>This link doesn't live here.</p>${home}</main></body>
</html>`;
}
