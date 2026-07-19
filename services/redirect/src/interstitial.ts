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
//   Android  — hand the browser the intent:// URL. Chrome falls back to
//              browser_fallback_url NATIVELY (works inside Android webviews too).
//
// visibilitychange is the honest signal the app launched (the page is hidden while
// iOS switches apps); we cancel the fallback when it fires. FALLBACK_MS is the
// backstop for browsers that don't hide the page.
const FALLBACK_MS = 1500;

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

export function renderInterstitial(
  match: PlatformMatch,
  opts?: {
    branded?: boolean;
    homeUrl?: string;
    ua?: string;
    slug?: string;
    host?: string;
    /** Rich fallback page — where the automatic timeout bail lands instead of the web URL. */
    fbu?: string;
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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Opening ${esc(match.key)}…</title>
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
  ${zippyBolt()}
  <p>Opening the ${esc(match.key)} app<span class="dot"></span><span class="dot"></span><span class="dot"></span></p>
  ${escapeBtn}
  <p><a id="fallback" href="${esc(match.web)}">Continue in browser</a></p>
  ${footer}
</main>
<script>
(function(){
  var iosPrimary = ${JSON.stringify(iosPrimary)};
  var android = ${JSON.stringify(match.android)};
  var bailTo = ${JSON.stringify(opts?.fbu ?? match.web)}; // rich fallback page when entitled, else the web URL
  // Outcome telemetry (POST /t on this same short-domain origin). A rate/trend
  // signal, not per-click truth: the page going hidden = the app launched ("opened");
  // the fallback firing while still visible = stayed in the browser ("browser").
  var beaconBody = ${JSON.stringify({ slug: opts?.slug ?? "", host: opts?.host ?? "", platformKey: match.key, sourceApp: webview ?? "" })};
  function beacon(outcome){
    try {
      beaconBody.outcome = outcome; beaconBody.ts = Date.now();
      navigator.sendBeacon("/t", JSON.stringify(beaconBody));
    } catch(e){}
  }
  var done = false;
  // Register the visibility listener BEFORE the Android branch so an Android app-open
  // (intent:// hides the page) is captured as "opened" too.
  document.addEventListener("visibilitychange", function(){ if(document.hidden){ done = true; beacon("opened"); } });
  var isAndroid = /Android/i.test(navigator.userAgent);
  if (isAndroid) { window.location.replace(android); return; } // intent:// self-falls-back (webviews too)
  function bail(){ if(!done){ done = true; beacon("browser"); window.location.replace(bailTo); } }
  var t = setTimeout(bail, ${FALLBACK_MS});
  window.addEventListener("pagehide", function(){ done = true; clearTimeout(t); });
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
  ${zippyBolt()}
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

export function render404(homeUrl?: string): string {
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
<body><main>${zippyBolt(true)}<h1>404</h1><p>This link doesn't live here.</p>${home}</main></body>
</html>`;
}
