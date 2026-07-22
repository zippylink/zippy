// One-off QR test sheet for LinkedIn POST deep-linking — Task: fix zipthe.link/posthog
// opening the LinkedIn app HOME instead of the actual post.
//
// WHY: platforms.ts only maps linkedin /in/ (profile) and /company/. A POST URL falls
// through to "" → bare `linkedin://` → app home, post lost. LinkedIn (like Luma) may or
// may not have a scheme that opens a specific feed post — only a real device answers.
// The founder scans each QR with the iPhone camera and records whether it opened THE POST,
// the app home, or nothing. Only a confirmed-working shape gets hard-coded.
//
// Run from services/redirect:  bun scripts/gen-linkedin-testsheet.ts
// (qrcode is borrowed from the sibling zippy-cloud node_modules — build-time tooling only.)
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/Users/shaisnir/Development/zippy-org/zippy-cloud/node_modules/");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCode = require("qrcode");

// The real post behind zipthe.link/posthog — its share/activity id.
const ID = "7475895728721182721";
const WEB = `https://www.linkedin.com/feed/update/urn:li:activity:${ID}/`;

const candidates = [
  {
    label: "A — activity URN (most likely)",
    url: `linkedin://feed/update/urn:li:activity:${ID}`,
    note: "LinkedIn's documented in-app feed-update route. Best bet for opening the post.",
  },
  {
    label: "B — share URN variant",
    url: `linkedin://feed/update/urn:li:share:${ID}`,
    note: "Same route, share URN instead of activity — the id in the URL is a share id.",
  },
  {
    label: "C — bare post path",
    url: `linkedin://post/${ID}`,
    note: "Simplest guess; many apps accept a flat /post/<id>.",
  },
  {
    label: "D — host-preserving (the Luma trick)",
    url: `linkedin://www.linkedin.com/feed/update/urn:li:activity:${ID}/`,
    note: "The shape that fixed Luma: scheme + full https host+path. Try if A–C fail.",
  },
  {
    label: "E — CONTROL: Universal Link (https)",
    url: WEB,
    note: "Scanning this opens Safari → LinkedIn Universal Link. If THIS opens the post but A–D don't, the fix is: for posts, punt to the Universal Link instead of a bare scheme.",
  },
  {
    label: "F — BASELINE: what we ship today (the bug)",
    url: "linkedin://",
    note: "Bare scheme, no path — this is exactly what a post gets now. Expect: app HOME, post lost. Confirms the bug.",
  },
];

const svgs = await Promise.all(
  candidates.map((c) => QRCode.toString(c.url, { type: "svg", margin: 1, width: 200 })),
);

const cards = candidates
  .map(
    (c, i) => `
  <div class="card">
    <div class="qr">${svgs[i]}</div>
    <h3>${c.label}</h3>
    <code>${c.url.length > 60 ? c.url.slice(0, 60) + "…" : c.url}</code>
    <p class="note">${c.note}</p>
    <div class="verdicts" data-key="${c.label}">
      <button data-v="post">✅ opened the POST</button>
      <button data-v="home">🏠 app home only</button>
      <button data-v="nothing">❌ nothing</button>
    </div>
  </div>`,
  )
  .join("\n");

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Zippy — LinkedIn post deep-link test</title>
<style>
 body{font-family:-apple-system,sans-serif;background:#FAF7F2;color:#1A1033;margin:24px;max-width:900px}
 h1{font-size:22px} .lead{font-size:14px;line-height:1.5}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin-top:16px}
 .card{border:2px solid #1A1033;border-radius:10px;background:#fff;padding:14px;text-align:center}
 .card h3{margin:8px 0 4px;font-size:14px} .card code{font-size:11px;word-break:break-all;color:#333}
 .note{font-size:11px;color:#666;margin:6px 0;text-align:left}
 .verdicts{display:flex;flex-wrap:wrap;gap:4px;justify-content:center;margin-top:6px}
 .verdicts button{padding:5px 9px;border:2px solid #1A1033;border-radius:999px;background:#fff;cursor:pointer;font-size:11px}
 .verdicts button.on{background:#EEFF00;font-weight:bold}
 .qr svg{width:170px;height:170px}
 #bar{position:sticky;top:0;background:#FAF7F2;padding:10px 0;display:flex;gap:12px;align-items:center;z-index:2}
 #export{padding:8px 14px;border:2px solid #1A1033;border-radius:999px;background:#EEFF00;font-weight:bold;cursor:pointer}
</style></head><body>
<h1>⚡ LinkedIn post deep-link test</h1>
<p class="lead"><b>Post under test:</b> your <code>zipthe.link/posthog</code> → <code>…/feed/update/urn:li:activity:${ID}</code>.<br>
Scan each QR with the <b>iPhone camera</b> (LinkedIn app installed). Tap through, then mark whether it opened <b>the actual post</b>, only the app <b>home</b>, or <b>nothing</b>. We hard-code only a shape that opens the post. Results save locally — export when done.</p>
<div id="bar"><button id="export">Export results JSON</button><span id="count"></span></div>
<div class="grid">${cards}</div>
<script>
 const KEY="zippy-linkedin-verdicts";
 const state=JSON.parse(localStorage.getItem(KEY)||"{}");
 function paint(){document.querySelectorAll(".verdicts").forEach(v=>{const k=v.dataset.key;v.querySelectorAll("button").forEach(b=>b.classList.toggle("on",state[k]===b.dataset.v))});
  document.getElementById("count").textContent=Object.keys(state).length+" / ${candidates.length} recorded";}
 document.querySelectorAll(".verdicts button").forEach(b=>b.addEventListener("click",()=>{const k=b.parentElement.dataset.key;state[k]=b.dataset.v;localStorage.setItem(KEY,JSON.stringify(state));paint();}));
 document.getElementById("export").addEventListener("click",()=>{const blob=new Blob([JSON.stringify(state,null,1)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="linkedin-verdicts.json";a.click();});
 paint();
</script></body></html>`;

writeFileSync(new URL("./linkedin-testsheet.html", import.meta.url), html);
console.log(`linkedin-testsheet.html written — ${candidates.length} QR cards for activity ${ID}`);
