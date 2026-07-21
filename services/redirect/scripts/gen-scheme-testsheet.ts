// Generates scheme-testsheet.html — a self-contained QR test sheet for Task #72 Phase 2.
// One card per candidate scheme: a QR encoding the RAW scheme:// URL (passthrough example
// when the harvest recorded one, bare scheme otherwise), plus three verdict buttons that
// persist to localStorage and export as JSON — the founder scans with an iPhone camera,
// taps a verdict per card, exports, and the JSON promotes candidates into platforms.ts.
// Run: bun scripts/gen-scheme-testsheet.ts  (from services/redirect; qrcode comes from
// the sibling zippy-cloud workspace's node_modules — build-time tooling only).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/Users/shaisnir/Development/zippy-org/zippy-cloud/node_modules/");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const QRCode = require("qrcode");

type Candidate = {
  domain: string;
  appName: string;
  schemes: { scheme: string; evidence: string; urlPassthroughClaim?: string }[];
};

const candidates: Candidate[] = JSON.parse(
  readFileSync(new URL("./ios-scheme-candidates.json", import.meta.url), "utf8"),
);

const cards: { app: string; domain: string; scheme: string; url: string; evidence: string }[] = [];
for (const c of candidates) {
  for (const s of c.schemes ?? []) {
    const url = s.urlPassthroughClaim ?? `${s.scheme}://`;
    cards.push({ app: c.appName, domain: c.domain, scheme: s.scheme, url, evidence: s.evidence });
  }
}

const svgs = await Promise.all(
  cards.map((c) => QRCode.toString(c.url, { type: "svg", margin: 1, width: 160 })),
);

const cardHtml = cards
  .map(
    (c, i) => `
  <div class="card" id="card-${i}">
    <div class="qr">${svgs[i]}</div>
    <h3>${c.app}</h3>
    <code>${c.url.length > 48 ? c.url.slice(0, 48) + "…" : c.url}</code>
    <p class="ev">${c.evidence}</p>
    <div class="verdicts" data-key="${c.domain}|${c.scheme}">
      <button data-v="content">✅ content</button>
      <button data-v="home">🏠 home only</button>
      <button data-v="nothing">❌ nothing</button>
    </div>
  </div>`,
  )
  .join("\n");

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Zippy iOS scheme test sheet (${cards.length} QRs)</title>
<style>
 body{font-family:-apple-system,sans-serif;background:#FAF7F2;color:#1A1033;margin:24px}
 h1{font-size:22px} .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
 .card{border:2px solid #1A1033;border-radius:10px;background:#fff;padding:12px;text-align:center}
 .card h3{margin:8px 0 2px;font-size:14px} .card code{font-size:10px;word-break:break-all}
 .ev{font-size:10px;color:#777;margin:4px 0}
 .verdicts button{margin:2px;padding:4px 8px;border:2px solid #1A1033;border-radius:999px;background:#fff;cursor:pointer;font-size:11px}
 .verdicts button.on{background:#EEFF00}
 .qr svg{width:140px;height:140px}
 #bar{position:sticky;top:0;background:#FAF7F2;padding:8px 0;display:flex;gap:12px;align-items:center}
 #export{padding:8px 14px;border:2px solid #1A1033;border-radius:999px;background:#EEFF00;font-weight:bold;cursor:pointer}
</style></head><body>
<h1>⚡ Zippy iOS scheme test — scan each QR with the iPhone camera</h1>
<p>Tap the banner iOS shows. Then record: did the app open <b>with the content</b>, only to its <b>home screen</b>, or <b>nothing</b> happened? Results save locally; export when done.</p>
<div id="bar"><button id="export">Export results JSON</button><span id="count"></span></div>
<div class="grid">${cardHtml}</div>
<script>
 const KEY="zippy-scheme-verdicts";
 const state=JSON.parse(localStorage.getItem(KEY)||"{}");
 function paint(){document.querySelectorAll(".verdicts").forEach(v=>{const k=v.dataset.key;v.querySelectorAll("button").forEach(b=>b.classList.toggle("on",state[k]===b.dataset.v))});
  document.getElementById("count").textContent=Object.keys(state).length+" / ${cards.length} recorded";}
 document.querySelectorAll(".verdicts button").forEach(b=>b.addEventListener("click",()=>{const k=b.parentElement.dataset.key;state[k]=b.dataset.v;localStorage.setItem(KEY,JSON.stringify(state));paint();}));
 document.getElementById("export").addEventListener("click",()=>{const blob=new Blob([JSON.stringify(state,null,1)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="scheme-verdicts.json";a.click();});
 paint();
</script></body></html>`;

writeFileSync(new URL("./scheme-testsheet.html", import.meta.url), html);
console.log(`scheme-testsheet.html written — ${cards.length} QR cards`);
