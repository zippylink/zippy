// Zippy deeplink table — THE core of the product.
//
// Each platform is ONE data object. To add or fix a platform, edit this table;
// nothing else in the Worker needs to change. Community PRs live here.
//
// The model (DRY): a platform gives us three things —
//   scheme          the app's custom URL scheme  (e.g. "twitter")
//   androidPackage  its Play Store package id     (e.g. "com.twitter.android")
//   path(url)       the scheme-specific suffix after "scheme://", best-effort,
//                   or "" to just open the app (web fallback still covers the exact content).
// From those we derive all three link forms uniformly (buildMatch):
//   iOS      → `${scheme}://${path}`                         (custom scheme, JS timer falls back)
//   Android  → `intent://${path}#Intent;scheme=…;package=…;S.browser_fallback_url=…;end`
//              (intent:// falls back to the web URL NATIVELY — no JS timer needed)
//   web      → the original https destination (always correct)
//
// Schemes drift; the web fallback is the safety net, so a wrong scheme degrades
// to "opens in browser", never to a broken link. Reference for patterns:
// github.com/enzoferey/url-to-deep-link (verified/modernized here).

export type PlatformMatch = {
  key: string;
  ios: string;
  android: string;
  web: string;
};

type Platform = {
  key: string;
  scheme: string;
  androidPackage: string;
  /** Hostnames this platform owns, lowercased, without a leading "www." */
  hosts: string[];
  /** Scheme-specific suffix after `scheme://`, or "" to open the app home. */
  path: (url: URL) => string;
};

// Path segments that are NOT usernames on the profile-at-root platforms.
const IG_RESERVED = new Set([
  "p",
  "reel",
  "reels",
  "tv",
  "explore",
  "stories",
  "accounts",
  "about",
]);
const X_RESERVED = new Set([
  "home",
  "search",
  "explore",
  "notifications",
  "messages",
  "i",
  "settings",
  "compose",
  "hashtag",
  "intent",
]);

const seg = (url: URL): string[] => url.pathname.split("/").filter(Boolean);

export const PLATFORMS: Platform[] = [
  {
    key: "linkedin",
    scheme: "linkedin",
    androidPackage: "com.linkedin.android",
    hosts: ["linkedin.com"],
    path: (url) => {
      const s = seg(url);
      if (s[0] === "in" && s[1]) return `in/${s[1]}`;
      if (s[0] === "company" && s[1]) return `company/${s[1]}`;
      return "";
    },
  },
  {
    key: "instagram",
    scheme: "instagram",
    androidPackage: "com.instagram.android",
    hosts: ["instagram.com"],
    path: (url) => {
      const s = seg(url);
      // A single, non-reserved segment is a profile. Posts/reels have no reliable
      // shortcode scheme, so they open the app and the web fallback lands the post.
      if (s.length === 1 && s[0] && !IG_RESERVED.has(s[0])) return `user?username=${s[0]}`;
      return "";
    },
  },
  {
    key: "whatsapp",
    scheme: "whatsapp",
    androidPackage: "com.whatsapp",
    hosts: ["wa.me", "api.whatsapp.com"],
    path: (url) => {
      // wa.me/<phone>  |  api.whatsapp.com/send?phone=<phone>&text=<text>
      const host = url.hostname.replace(/^www\./, "");
      const phone = (host === "wa.me" ? seg(url)[0] : url.searchParams.get("phone")) ?? "";
      const text = url.searchParams.get("text");
      if (!phone) return text ? `send?text=${encodeURIComponent(text)}` : "";
      return `send?phone=${phone}` + (text ? `&text=${encodeURIComponent(text)}` : "");
    },
  },
  {
    key: "reddit",
    scheme: "reddit",
    androidPackage: "com.reddit.frontpage",
    hosts: ["reddit.com", "old.reddit.com"],
    path: (url) => {
      const s = seg(url);
      // Subreddits, users, and posts all live under a path the app understands.
      if (s[0] === "r" || s[0] === "u" || s[0] === "user") return url.pathname.replace(/^\/+/, "");
      return "";
    },
  },
  {
    key: "producthunt",
    scheme: "producthunt", // ponytail: PH's scheme is undocumented; web fallback carries it if wrong.
    androidPackage: "com.producthunt.hunt",
    hosts: ["producthunt.com"],
    path: (url) => {
      const s = seg(url);
      if ((s[0] === "posts" || s[0] === "products") && s[1]) return `${s[0]}/${s[1]}`;
      return "";
    },
  },
  {
    key: "youtube",
    scheme: "youtube",
    androidPackage: "com.google.android.youtube",
    hosts: ["youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"],
    path: (url) => {
      const host = url.hostname.replace(/^www\./, "");
      if (host === "youtu.be") {
        const id = seg(url)[0];
        return id ? `watch?v=${id}` : "";
      }
      const s = seg(url);
      if (s[0] === "watch") {
        const v = url.searchParams.get("v");
        return v ? `watch?v=${v}` : "";
      }
      if (s[0] === "shorts" && s[1]) return `watch?v=${s[1]}`;
      if ((s[0] === "channel" || s[0] === "c") && s[1]) return url.pathname.replace(/^\/+/, "");
      return "";
    },
  },
  {
    key: "tiktok",
    scheme: "tiktok",
    androidPackage: "com.zhiliaoapp.musically",
    hosts: ["tiktok.com", "vm.tiktok.com", "m.tiktok.com"],
    path: (url) => {
      const s = seg(url);
      // /@user (profile) has a scheme; /@user/video/<id> and vm.* shortlinks open the app.
      if (s.length === 1 && s[0]?.startsWith("@")) return `user?username=${s[0].slice(1)}`;
      return "";
    },
  },
  {
    key: "x",
    scheme: "twitter",
    androidPackage: "com.twitter.android",
    hosts: ["x.com", "twitter.com", "mobile.twitter.com"],
    path: (url) => {
      const s = seg(url);
      if (s[1] === "status" && s[2]) return `status?id=${s[2]}`;
      if (s.length === 1 && s[0] && !X_RESERVED.has(s[0])) return `user?screen_name=${s[0]}`;
      return "";
    },
  },
];

function buildMatch(p: Platform, url: URL): PlatformMatch {
  const path = p.path(url);
  const web = url.toString();
  const intentBody = `intent://${path}#Intent;scheme=${p.scheme};package=${p.androidPackage};S.browser_fallback_url=${encodeURIComponent(web)};end`;
  return { key: p.key, ios: `${p.scheme}://${path}`, android: intentBody, web };
}

/**
 * Match a destination URL against the deeplink table.
 * Returns the platform's iOS / Android / web link forms, or null if no platform owns it.
 */
export function matchPlatform(destination: string): PlatformMatch | null {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const platform = PLATFORMS.find((p) => p.hosts.includes(host));
  return platform ? buildMatch(platform, url) : null;
}
