// Zippy deeplink table — THE core of the product.
//
// This is the CANONICAL copy: it decides real redirects. It is MIRRORED (by hand) into
// Zippy Cloud's `libs/shared/src/platforms.ts`, which powers the public Deep Link Debugger
// and dashboard labels. This Worker is dependency-free and lives in a separate repo, so it
// cannot import that package — the cross-repo boundary is the one sanctioned duplication.
// EDIT HERE FIRST, then copy the file across.
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
  {
    // ponytail: GitHub is SCHEMELESS — the app registers NO custom URL scheme, only
    // https App Links (Android, com.github.android) + Universal Links (iOS,
    // com.github.stormbreaker.prod, per github.com's live apple-app-site-association).
    // So scheme="https" and path carries the FULL host: buildMatch then yields
    //   android → intent://github.com/<p>#Intent;scheme=https;package=com.github.android;…
    //             — package-targeted https VIEW intent opens the app; browser_fallback_url
    //             degrades to the browser natively (same mechanism as the other 8).  REAL win.
    //   ios     → https://github.com/<p> — i.e. the web URL. With no custom scheme there is
    //             NOTHING that escapes an in-app webview (Instagram/LinkedIn); Universal Links
    //             don't fire there. iOS therefore just lands on github.com = the web fallback.
    //             NO iOS benefit over a plain tap, by design — do NOT invent a github:// scheme.
    // We hand the app the genuine URL, so its own router decides correctness — no reserved-word
    // guard needed (unlike custom-scheme platforms), and any page it can't open falls back to web.
    // gist.github.com is intentionally OMITTED: no evidence the app handles gist links.
    key: "github",
    scheme: "https",
    androidPackage: "com.github.android",
    hosts: ["github.com"],
    path: (url) => `github.com${url.pathname.replace(/\/+$/, "")}`,
  },

  // ── Batch 2 — evidence-verified 2026-07 (sources in docs/platform-notes.md) ──
  {
    // Amazon's ".web" scheme is a "load this web URL in the app" scheme: it carries the
    // FULL amazon web URL (path + query), so an affiliate ?tag= survives into the app.
    // iOS is the win; the Android intent reuses this scheme and, if the app doesn't
    // claim it, degrades to the web URL (tag still intact) — never breaks.
    key: "amazon",
    scheme: "com.amazon.mobile.shopping.web",
    androidPackage: "com.amazon.mShop.android.shopping",
    hosts: ["amazon.com", "amzn.to", "a.co", "amzn.com"],
    path: (url) => {
      // Bare host (no www.) matches the documented form; short hosts (amzn.to) 302.
      const host = url.hostname.replace(/^www\./, "");
      return `${host}${url.pathname}${url.search}`;
    },
  },
  {
    key: "spotify",
    scheme: "spotify",
    androidPackage: "com.spotify.music",
    hosts: ["open.spotify.com", "spotify.link"],
    path: (url) => {
      const s = seg(url);
      // open.spotify.com/<type>/<id> → spotify:<type>:<id>. The id comes from the path,
      // so the ?si= share token is dropped for free. Unknown shapes open the app home.
      if (
        (s[0] === "track" || s[0] === "album" || s[0] === "artist" || s[0] === "playlist") &&
        s[1]
      )
        return `${s[0]}:${s[1]}`;
      return "";
    },
  },
  {
    // Vanity facebook.com/<name> URLs carry no numeric id and can't be resolved
    // client-side, so only genuinely-numeric ids use fb://profile/<id>; everything else
    // uses fb://facewebmodal/f?href=<url> — opens the exact page inside the FB app's own
    // webview (escapes the host social webview). Both forms are years-stable.
    key: "facebook",
    scheme: "fb",
    androidPackage: "com.facebook.katana",
    hosts: ["facebook.com", "m.facebook.com", "fb.com", "fb.me", "fb.watch"],
    path: (url) => {
      const id = url.searchParams.get("id");
      if (/^\d+$/.test(id ?? "")) return `profile/${id}`;
      const s = seg(url);
      if (s.length === 1 && /^\d+$/.test(s[0] ?? "")) return `profile/${s[0]}`;
      return `facewebmodal/f?href=${encodeURIComponent(url.toString())}`;
    },
  },
  {
    key: "pinterest",
    scheme: "pinterest",
    androidPackage: "com.pinterest",
    hosts: ["pinterest.com"],
    path: (url) => {
      const s = seg(url);
      // Only the pin lane has a verified scheme path (trailing slash is the documented
      // form); profiles/boards open via the web fallback (universal links).
      if (s[0] === "pin" && s[1]) return `pin/${s[1]}/`;
      return "";
    },
  },
  {
    // Threads' internal codename is "barcelona" (still the live Android package id), so
    // barcelona://user?username=<u> is the profile opener. Only profiles have a verified
    // scheme path; individual posts open via the web fallback.
    key: "threads",
    scheme: "barcelona",
    androidPackage: "com.instagram.barcelona",
    hosts: ["threads.net", "threads.com"],
    path: (url) => {
      const s = seg(url);
      if (s.length === 1 && s[0]?.startsWith("@")) return `user?username=${s[0].slice(1)}`;
      return "";
    },
  },
  {
    key: "telegram",
    scheme: "tg",
    androidPackage: "org.telegram.messenger",
    hosts: ["t.me", "telegram.me", "telegram.dog"],
    path: (url) => {
      const s = seg(url);
      if (!s[0]) return "";
      if (s[0] === "joinchat" && s[1]) return `join?invite=${s[1]}`;
      if (s[0].startsWith("+")) return `join?invite=${s[0].slice(1)}`;
      if (s[0] === "addstickers" && s[1]) return `addstickers?set=${s[1]}`;
      // /s/<channel> (web preview) and /share are browser-only — open the app home.
      if (s[0] === "s" || s[0] === "share") return "";
      if (s[1] && /^\d+$/.test(s[1])) return `resolve?domain=${s[0]}&post=${s[1]}`;
      return `resolve?domain=${s[0]}`;
    },
  },
  {
    // Apple Music's scheme is HOST-PRESERVING: music://music.apple.com/<path> (not the
    // bare-colon Spotify form) — a straight https→music swap on any catalog URL works.
    key: "apple-music",
    scheme: "music",
    androidPackage: "com.apple.android.music",
    hosts: ["music.apple.com"],
    path: (url) => `music.apple.com${url.pathname}${url.search}`,
  },
  {
    key: "discord",
    scheme: "discord",
    androidPackage: "com.discord",
    hosts: ["discord.com", "discord.gg", "discordapp.com"],
    path: (url) => {
      const host = url.hostname.replace(/^www\./, "");
      const s = seg(url);
      // The literal "-/" route prefix is the documented Discord form — don't drop it.
      if (host === "discord.gg") return s[0] ? `-/invite/${s[0]}` : "";
      if (s[0] === "invite" && s[1]) return `-/invite/${s[1]}`;
      if (s[0] === "channels" && s[1]) return `-/${s.join("/")}`;
      return "";
    },
  },
  {
    // comgooglemapsurl:// wraps a full maps web URL verbatim into the iOS app — ideal for
    // a shortener that receives an already-formed link. Only maps.google.com is claimed:
    // google.com/maps shares the google.com host, which we must not hijack.
    key: "google-maps",
    scheme: "comgooglemapsurl",
    androidPackage: "com.google.android.apps.maps",
    hosts: ["maps.google.com"],
    path: (url) => `${url.hostname}${url.pathname}${url.search}`,
  },
  {
    // App Store (Apple): itms-apps is an iOS SYSTEM scheme (always installed), so the
    // in-webview escape is rock-solid. Host-preserving https→itms-apps swap. Android has
    // no Apple store, so an apps.apple.com link correctly serves web there.
    key: "app-store",
    scheme: "itms-apps",
    androidPackage: "com.android.vending",
    hosts: ["apps.apple.com", "itunes.apple.com"],
    path: (url) => `${url.hostname}${url.pathname}`,
  },
  {
    // Play Store (Google): schemeless, exactly like github — play.google.com is an https
    // App Link for com.android.vending, so the package-targeted intent opens the Play
    // Store app on Android; iOS has no Play app and correctly serves web.
    // ponytail: split from app-store because one platform row = one scheme, and Apple
    // (itms-apps) vs Play (https-intent) genuinely need different schemes per OS.
    key: "play-store",
    scheme: "https",
    androidPackage: "com.android.vending",
    hosts: ["play.google.com"],
    path: (url) => `play.google.com${url.pathname}${url.search}`,
  },
  {
    // Snapchat is ANDROID_ONLY (mirrors github): the add-friend target is a Universal
    // Link — there is NO add-friend custom-scheme path (snapchat:// only opens the
    // camera). Android intent opens the app to the add-friend screen; iOS → web.
    key: "snapchat",
    scheme: "https",
    androidPackage: "com.snapchat.android",
    hosts: ["snapchat.com"],
    path: (url) => `snapchat.com${url.pathname.replace(/\/+$/, "")}`,
  },
  {
    // Twitch: all path forms are first-party documented (dev.twitch.tv/docs/mobile-deeplinks).
    key: "twitch",
    scheme: "twitch",
    androidPackage: "tv.twitch.android.app",
    hosts: ["twitch.tv", "m.twitch.tv"],
    path: (url) => {
      const s = seg(url);
      if (s[0] === "videos" && s[1]) return `video/${s[1]}`;
      if (s[0] === "directory" && s[1] === "game" && s[2]) return `game/${s[2]}`;
      if (s.length === 1 && s[0]) return `stream/${s[0]}`;
      return "";
    },
  },
];

function buildMatch(p: Platform, url: URL, fallbackUrl?: string): PlatformMatch {
  const path = p.path(url);
  const web = url.toString();
  // browser_fallback_url is where Chrome sends the visitor when the intent finds no app.
  // Aimed at the DESTINATION (the default) that hop never touches us, so a failed open and
  // a successful one are indistinguishable from here — which is why Android is unmeasured.
  // A caller that passes a URL IT serves gets the failure hop delivered to itself instead,
  // and can record it as an OBSERVED `browser` outcome. See index.ts's fb= short-circuit.
  const intentBody = `intent://${path}#Intent;scheme=${p.scheme};package=${p.androidPackage};S.browser_fallback_url=${encodeURIComponent(fallbackUrl ?? web)};end`;
  return { key: p.key, ios: `${p.scheme}://${path}`, android: intentBody, web };
}

/**
 * Match a destination URL against the deeplink table.
 * Returns the platform's iOS / Android / web link forms, or null if no platform owns it.
 * `fallbackUrl` overrides the Android intent's browser_fallback_url; omitted, it stays the
 * destination (the historical behaviour).
 */
export function matchPlatform(destination: string, fallbackUrl?: string): PlatformMatch | null {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const platform = PLATFORMS.find((p) => p.hosts.includes(host));
  return platform ? buildMatch(platform, url, fallbackUrl) : null;
}
