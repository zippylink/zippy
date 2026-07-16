// Social-crawler unfurl page. When a social crawler (not a human) hits a short
// link we serve THIS instead of redirecting — a tiny HTML doc carrying Open-Graph
// + Twitter-Card meta so the link unfurls into a rich preview in the feed/DM.
//
// The OG fields are denormalized onto the KV record by the cloud (never scraped at
// request time — the redirect path stays KV-only and instant). Missing fields are
// omitted, never fabricated: a link with no stored OG serves a minimal card.
export type OgMeta = { title?: string; description?: string; image?: string };

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A crawler that follows meta refresh / JS won't; but some (Slack, Telegram) fetch
// the final URL too — so we still point a <meta http-equiv> + canonical at the
// destination. Humans never reach this branch (see isSocialCrawler in index.ts).
export function renderOgPage(shortUrl: string, destination: string, og: OgMeta): string {
  const title = og.title ?? new URL(destination).hostname.replace(/^www\./, "");
  const tags: string[] = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${esc(shortUrl)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:card" content="${og.image ? "summary_large_image" : "summary"}">`,
  ];
  if (og.description) {
    tags.push(`<meta property="og:description" content="${esc(og.description)}">`);
    tags.push(`<meta name="twitter:description" content="${esc(og.description)}">`);
  }
  if (og.image) {
    tags.push(`<meta property="og:image" content="${esc(og.image)}">`);
    tags.push(`<meta name="twitter:image" content="${esc(og.image)}">`);
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
${tags.join("\n")}
<link rel="canonical" href="${esc(destination)}">
</head>
<body><a href="${esc(destination)}">${esc(title)}</a></body>
</html>`;
}
