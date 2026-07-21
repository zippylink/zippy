// Best-effort Android app-open — the assetlinks/AASA tier (Wave 13).
//
// A hand-verified platform in platforms.ts is a data object a human confirmed. This tier is the
// OPPOSITE trust level: it is DERIVED, at build time, from what a domain PUBLISHES about itself
// at /.well-known/assetlinks.json (its Android package) and apple-app-site-association (its iOS
// appID). The generated evidence lives in ./well-known-map.json (produced by
// scripts/build-well-known-map.ts — build-time only, never shipped). This module is the runtime
// read side and stays dependency-free like the rest of the Worker.
//
// WHAT IT BUYS — the Android half, at scale. An intent:// needs only the package name, and a
// site's assetlinks publishes exactly that under `delegate_permission/common.handle_all_urls`,
// which means "this app handles ALL my https URLs". So we pin the package and hand the app the
// ORIGINAL https URL as the intent data: the app's OWN link router resolves the path (or the OS
// falls back to the web URL). We NEVER guess a scheme path — a wrong guessed path opens the app
// at its home screen with the content lost, which is worse for the visitor than the browser.
// (This is exactly the schemeless github/snapchat pattern in platforms.ts, applied at scale.)
//
// WHAT IT DOESN'T — iOS. Custom schemes are published nowhere and Universal Links never fire
// from inside a webview, so iOS stays MANUAL (the hand-verified table only). Android-only by
// design; `ios` below is the plain web URL so the interstitial just serves web on iOS.
//
// HONESTY — a best-effort open is UNMEASURED by construction: the intent's browser_fallback_url
// is the destination web URL, never our measured /:slug?fb=1 hop, so a failed open never comes
// back to us and nothing here can be counted as a verified app-open. The interstitial's Android
// path already records exactly one `unmeasured` row. Creator-facing surfaces LABEL these
// best-effort and exclude them from verified app-open claims (zippy-cloud libs/shared + apps/web).

import { PLATFORMS, type PlatformMatch } from "./platforms.js";
import rawMap from "./well-known-map.json";

export type WellKnownRow = {
  domain: string;
  androidPackage?: string;
  iosAppId?: string;
  fetchedAt: string;
  source: "assetlinks" | "aasa";
};

// Hosts a hand-verified platform already owns. Excluded from the best-effort lookup so this tier
// can NEVER override or shadow a verified platform, even if the generated map accidentally lists
// one. (The caller also only invokes us on a matchPlatform() miss — this is defense in depth.)
const VERIFIED_HOSTS = new Set<string>(PLATFORMS.flatMap((p) => p.hosts));

// domain → row, only for rows that actually carry an Android package (the sole best-effort
// signal) and are not already hand-verified.
const BY_DOMAIN = new Map<string, WellKnownRow>(
  (rawMap as WellKnownRow[])
    .filter((r) => r.androidPackage && !VERIFIED_HOSTS.has(r.domain))
    .map((r) => [r.domain, r]),
);

/** Number of usable best-effort domains loaded. Exposed for the cloud parity check / tests. */
export const bestEffortDomainCount = (): number => BY_DOMAIN.size;

// Display label from the host: the registrable domain's main label ("open.spotify.com" →
// "spotify", "netflix.com" → "netflix"). ponytail: naive last-two-labels; a multi-part TLD
// (bbc.co.uk → "co") mislabels, but this is cosmetic interstitial copy only.
function label(host: string): string {
  const p = host.split(".");
  return p.length >= 2 ? (p[p.length - 2] ?? host) : host;
}

/**
 * Best-effort deeplink for a destination whose host is NOT hand-verified but publishes an
 * Android package. Returns a PlatformMatch (so it flows through the same interstitial) or null.
 * Android intent = the ORIGINAL url handed to the app, package pinned, falling back to the
 * destination web URL. iOS = the web URL (no app-open — stays manual). NEVER guesses a path.
 */
export function bestEffortMatch(destination: string): PlatformMatch | null {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const row = BY_DOMAIN.get(host);
  if (!row?.androidPackage) return null;
  const web = url.toString();
  // Schemeless https App-Link intent: pin the package, hand the app the original url, fallback to
  // the destination (NOT a measured hop). Same mechanism as github/snapchat in platforms.ts.
  const dataPath = `${host}${url.pathname}${url.search}`;
  const android = `intent://${dataPath}#Intent;scheme=https;package=${row.androidPackage};S.browser_fallback_url=${encodeURIComponent(web)};end`;
  return { key: label(host), ios: web, android, web };
}
