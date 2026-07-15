import type { PlatformMatch } from "./platforms.js";

// Minimal, self-contained HTML. No external assets — it must render instantly on
// a cold mobile connection, so everything is inline.
//
// Strategy:
//   iOS      — set location to the custom scheme; if we're still visible after a
//              short beat, the app didn't take over → go to the https fallback.
//   Android  — hand the browser the intent:// URL. Chrome falls back to
//              browser_fallback_url NATIVELY, so no JS timer is involved.
//
// visibilitychange is the honest signal the app launched (the page is hidden while
// iOS switches apps); we cancel the fallback when it fires. FALLBACK_MS is the
// backstop for browsers that don't hide the page.
const FALLBACK_MS = 1500;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderInterstitial(match: PlatformMatch): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Opening ${esc(match.key)}…</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f0f10;color:#f5f5f5}
  main{text-align:center;padding:2rem}
  .dot{display:inline-block;width:.6rem;height:.6rem;margin:0 .15rem;border-radius:50%;background:#f5f5f5;animation:b 1s infinite alternate}
  .dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}
  @keyframes b{to{opacity:.2}}
  a{color:#8ab4ff}
</style>
</head>
<body>
<main>
  <p>Opening the ${esc(match.key)} app<span class="dot"></span><span class="dot"></span><span class="dot"></span></p>
  <p><a id="fallback" href="${esc(match.web)}">Continue in browser</a></p>
</main>
<script>
(function(){
  var ios = ${JSON.stringify(match.ios)};
  var android = ${JSON.stringify(match.android)};
  var web = ${JSON.stringify(match.web)};
  var isAndroid = /Android/i.test(navigator.userAgent);
  if (isAndroid) { window.location.replace(android); return; } // intent:// self-falls-back
  var done = false;
  function bail(){ if(!done){ done = true; window.location.replace(web); } }
  document.addEventListener("visibilitychange", function(){ if(document.hidden){ done = true; } });
  var t = setTimeout(bail, ${FALLBACK_MS});
  window.addEventListener("pagehide", function(){ done = true; clearTimeout(t); });
  window.location.replace(ios);
})();
</script>
</body>
</html>`;
}

export function render404(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link not found</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f0f10;color:#f5f5f5;text-align:center}
</style>
</head>
<body><main><h1>404</h1><p>This short link doesn't exist.</p></main></body>
</html>`;
}
