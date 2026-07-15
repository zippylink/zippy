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
  opts?: { branded?: boolean; homeUrl?: string },
): string {
  // Branding footer only when the record says so (the cloud bakes in this effect).
  const footer = opts?.branded
    ? `<p style="margin-top:1.5rem;font-size:.7rem;opacity:.6"><a href="${esc(opts.homeUrl ?? "")}">⚡ zipped with Zippy</a></p>`
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
  <p><a id="fallback" href="${esc(match.web)}">Continue in browser</a></p>
  ${footer}
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
