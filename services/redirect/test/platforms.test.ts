import { describe, it, expect } from "vitest";
import { matchPlatform } from "../src/platforms.js";
import { inAppWebview } from "../src/interstitial.js";

describe("inAppWebview detection", () => {
  const IG =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Mobile/15E148 Instagram 329.0.0.41.94";
  const FB = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) [FBAN/FBIOS;FBAV/450.0.0.0.0]";
  const TIKTOK = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) musical_ly_2023 BytedanceWebview/d8a21c";
  const LINKEDIN = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148 LinkedInApp";
  const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4) Version/17.4 Mobile/15E148 Safari/604.1";
  const CHROME_IOS =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) CriOS/124 Mobile/15E148 Safari/604.1";

  it("detects each trapping webview", () => {
    expect(inAppWebview(IG)).toBe("instagram");
    expect(inAppWebview(FB)).toBe("facebook");
    expect(inAppWebview(TIKTOK)).toBe("tiktok");
    expect(inAppWebview(LINKEDIN)).toBe("linkedin");
  });

  it("returns null for real browsers (Safari, Chrome-iOS)", () => {
    expect(inAppWebview(SAFARI)).toBeNull();
    expect(inAppWebview(CHROME_IOS)).toBeNull();
    expect(inAppWebview("")).toBeNull();
  });
});

// URL in → expected iOS scheme + Android intent shape + web fallback, per platform.
const cases: Array<{ name: string; url: string; key: string; ios: string; pkg: string }> = [
  {
    name: "linkedin profile",
    url: "https://www.linkedin.com/in/adimoyal",
    key: "linkedin",
    ios: "linkedin://in/adimoyal",
    pkg: "com.linkedin.android",
  },
  {
    name: "linkedin company",
    url: "https://linkedin.com/company/anthropic",
    key: "linkedin",
    ios: "linkedin://company/anthropic",
    pkg: "com.linkedin.android",
  },
  {
    // The "copy link" share URL (device-verified: share urn opens the post).
    name: "linkedin post (share URL)",
    url: "https://www.linkedin.com/posts/shaisnir_slug-share-7475895728721182721-EUw9/",
    key: "linkedin",
    ios: "linkedin://feed/update/urn:li:share:7475895728721182721",
    pkg: "com.linkedin.android",
  },
  {
    name: "linkedin post (explicit share urn)",
    url: "https://www.linkedin.com/feed/update/urn:li:share:7475895728721182721/",
    key: "linkedin",
    ios: "linkedin://feed/update/urn:li:share:7475895728721182721",
    pkg: "com.linkedin.android",
  },
  {
    name: "instagram profile",
    url: "https://instagram.com/nasa",
    key: "instagram",
    ios: "instagram://user?username=nasa",
    pkg: "com.instagram.android",
  },
  {
    name: "instagram post (app-open)",
    url: "https://www.instagram.com/p/ABC123/",
    key: "instagram",
    ios: "instagram://",
    pkg: "com.instagram.android",
  },
  {
    name: "instagram reel (app-open)",
    url: "https://www.instagram.com/reel/XYZ/",
    key: "instagram",
    ios: "instagram://",
    pkg: "com.instagram.android",
  },
  {
    name: "wa.me phone",
    url: "https://wa.me/15551234567",
    key: "whatsapp",
    ios: "whatsapp://send?phone=15551234567",
    pkg: "com.whatsapp",
  },
  {
    name: "wa.me with text",
    url: "https://wa.me/15551234567?text=hi%20there",
    key: "whatsapp",
    ios: "whatsapp://send?phone=15551234567&text=hi%20there",
    pkg: "com.whatsapp",
  },
  {
    name: "api.whatsapp send",
    url: "https://api.whatsapp.com/send?phone=15551234567",
    key: "whatsapp",
    ios: "whatsapp://send?phone=15551234567",
    pkg: "com.whatsapp",
  },
  {
    name: "reddit subreddit",
    url: "https://www.reddit.com/r/pics",
    key: "reddit",
    ios: "reddit://r/pics",
    pkg: "com.reddit.frontpage",
  },
  {
    name: "reddit post",
    url: "https://www.reddit.com/r/pics/comments/abc/title/",
    key: "reddit",
    ios: "reddit://r/pics/comments/abc/title/",
    pkg: "com.reddit.frontpage",
  },
  {
    name: "producthunt post",
    url: "https://www.producthunt.com/posts/zippy",
    key: "producthunt",
    ios: "producthunt://posts/zippy",
    pkg: "com.producthunt.hunt",
  },
  {
    name: "youtube watch",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    key: "youtube",
    ios: "youtube://watch?v=dQw4w9WgXcQ",
    pkg: "com.google.android.youtube",
  },
  {
    name: "youtu.be short",
    url: "https://youtu.be/dQw4w9WgXcQ",
    key: "youtube",
    ios: "youtube://watch?v=dQw4w9WgXcQ",
    pkg: "com.google.android.youtube",
  },
  {
    name: "youtube shorts",
    url: "https://www.youtube.com/shorts/abc123",
    key: "youtube",
    ios: "youtube://watch?v=abc123",
    pkg: "com.google.android.youtube",
  },
  {
    name: "tiktok profile",
    url: "https://www.tiktok.com/@nasa",
    key: "tiktok",
    ios: "tiktok://user?username=nasa",
    pkg: "com.zhiliaoapp.musically",
  },
  {
    name: "tiktok video (app-open)",
    url: "https://www.tiktok.com/@nasa/video/12345",
    key: "tiktok",
    ios: "tiktok://",
    pkg: "com.zhiliaoapp.musically",
  },
  {
    name: "x tweet",
    url: "https://x.com/nasa/status/12345",
    key: "x",
    ios: "twitter://status?id=12345",
    pkg: "com.twitter.android",
  },
  {
    name: "twitter profile",
    url: "https://twitter.com/nasa",
    key: "x",
    ios: "twitter://user?screen_name=nasa",
    pkg: "com.twitter.android",
  },
  // GitHub is schemeless: scheme=https, iOS "scheme" IS the web URL (no in-app-webview
  // escape by design), Android intent:// package-targets com.github.android.
  {
    name: "github repo",
    url: "https://github.com/vercel/next.js",
    key: "github",
    ios: "https://github.com/vercel/next.js",
    pkg: "com.github.android",
  },
  {
    name: "github user",
    url: "https://github.com/torvalds",
    key: "github",
    ios: "https://github.com/torvalds",
    pkg: "com.github.android",
  },
  {
    name: "github issue",
    url: "https://github.com/facebook/react/issues/123",
    key: "github",
    ios: "https://github.com/facebook/react/issues/123",
    pkg: "com.github.android",
  },
  {
    name: "github pull request",
    url: "https://github.com/facebook/react/pull/456",
    key: "github",
    ios: "https://github.com/facebook/react/pull/456",
    pkg: "com.github.android",
  },
  {
    name: "github home (trailing slash stripped)",
    url: "https://github.com/",
    key: "github",
    ios: "https://github.com",
    pkg: "com.github.android",
  },
  // ── Batch 2 ──
  {
    name: "amazon product keeps affiliate tag",
    url: "https://www.amazon.com/dp/B01N05APQY?tag=me-20",
    key: "amazon",
    ios: "com.amazon.mobile.shopping.web://amazon.com/dp/B01N05APQY?tag=me-20",
    pkg: "com.amazon.mShop.android.shopping",
  },
  {
    name: "amazon short link (a.co) passthrough",
    url: "https://a.co/d/abc123",
    key: "amazon",
    ios: "com.amazon.mobile.shopping.web://a.co/d/abc123",
    pkg: "com.amazon.mShop.android.shopping",
  },
  {
    name: "spotify track (si token dropped)",
    url: "https://open.spotify.com/track/4oktVvRuO1In9B7Hz0xm0a?si=abc",
    key: "spotify",
    ios: "spotify://track:4oktVvRuO1In9B7Hz0xm0a",
    pkg: "com.spotify.music",
  },
  {
    name: "spotify playlist",
    url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
    key: "spotify",
    ios: "spotify://playlist:37i9dQZF1DXcBWIGoYBM5M",
    pkg: "com.spotify.music",
  },
  {
    name: "facebook numeric profile → fb://profile",
    url: "https://www.facebook.com/profile.php?id=240995729348595",
    key: "facebook",
    ios: "fb://profile/240995729348595",
    pkg: "com.facebook.katana",
  },
  {
    name: "facebook vanity page → facewebmodal",
    url: "https://www.facebook.com/SomePage",
    key: "facebook",
    ios: "fb://facewebmodal/f?href=https%3A%2F%2Fwww.facebook.com%2FSomePage",
    pkg: "com.facebook.katana",
  },
  {
    name: "pinterest pin (trailing slash)",
    url: "https://www.pinterest.com/pin/285063851385287883/",
    key: "pinterest",
    ios: "pinterest://pin/285063851385287883/",
    pkg: "com.pinterest",
  },
  {
    name: "pinterest profile (app-open)",
    url: "https://www.pinterest.com/nasa",
    key: "pinterest",
    ios: "pinterest://",
    pkg: "com.pinterest",
  },
  {
    name: "threads profile",
    url: "https://www.threads.net/@zuck",
    key: "threads",
    ios: "barcelona://user?username=zuck",
    pkg: "com.instagram.barcelona",
  },
  {
    name: "threads post (app-open)",
    url: "https://www.threads.com/@zuck/post/ABC123",
    key: "threads",
    ios: "barcelona://",
    pkg: "com.instagram.barcelona",
  },
  {
    name: "telegram username",
    url: "https://t.me/durov",
    key: "telegram",
    ios: "tg://resolve?domain=durov",
    pkg: "org.telegram.messenger",
  },
  {
    name: "telegram channel post",
    url: "https://t.me/durov/123",
    key: "telegram",
    ios: "tg://resolve?domain=durov&post=123",
    pkg: "org.telegram.messenger",
  },
  {
    name: "telegram joinchat invite",
    url: "https://t.me/joinchat/AAAAAEraZ0",
    key: "telegram",
    ios: "tg://join?invite=AAAAAEraZ0",
    pkg: "org.telegram.messenger",
  },
  {
    name: "telegram +invite",
    url: "https://t.me/+AbCdEf",
    key: "telegram",
    ios: "tg://join?invite=AbCdEf",
    pkg: "org.telegram.messenger",
  },
  {
    name: "apple music album",
    url: "https://music.apple.com/us/album/thriller/269572838",
    key: "apple-music",
    ios: "music://music.apple.com/us/album/thriller/269572838",
    pkg: "com.apple.android.music",
  },
  {
    name: "apple music song highlight (?i preserved)",
    url: "https://music.apple.com/us/album/thriller/269572838?i=269573364",
    key: "apple-music",
    ios: "music://music.apple.com/us/album/thriller/269572838?i=269573364",
    pkg: "com.apple.android.music",
  },
  {
    name: "discord gg invite",
    url: "https://discord.gg/abc123",
    key: "discord",
    ios: "discord://-/invite/abc123",
    pkg: "com.discord",
  },
  {
    name: "discord.com invite",
    url: "https://discord.com/invite/abc123",
    key: "discord",
    ios: "discord://-/invite/abc123",
    pkg: "com.discord",
  },
  {
    name: "discord channel",
    url: "https://discord.com/channels/111/222",
    key: "discord",
    ios: "discord://-/channels/111/222",
    pkg: "com.discord",
  },
  {
    name: "google maps place",
    url: "https://maps.google.com/maps/place/Eiffel+Tower",
    key: "google-maps",
    ios: "comgooglemapsurl://maps.google.com/maps/place/Eiffel+Tower",
    pkg: "com.google.android.apps.maps",
  },
  {
    name: "apple app store (https → itms-apps swap)",
    url: "https://apps.apple.com/us/app/instagram/id389801252",
    key: "app-store",
    ios: "itms-apps://apps.apple.com/us/app/instagram/id389801252",
    pkg: "com.android.vending",
  },
  // play-store is schemeless (github-style): iOS "scheme" IS the web URL.
  {
    name: "google play app (schemeless, https)",
    url: "https://play.google.com/store/apps/details?id=com.spotify.music",
    key: "play-store",
    ios: "https://play.google.com/store/apps/details?id=com.spotify.music",
    pkg: "com.android.vending",
  },
  // snapchat is ANDROID_ONLY (github pattern): iOS "scheme" IS the web URL, no escape.
  {
    name: "snapchat add-friend (schemeless, https)",
    url: "https://www.snapchat.com/add/team.snapchat",
    key: "snapchat",
    ios: "https://snapchat.com/add/team.snapchat",
    pkg: "com.snapchat.android",
  },
  // Luma — DEVICE-VERIFIED 2026-07-21 (see the platforms.ts entry for the full QR matrix).
  // Host-preserving on purpose: luma://event/<slug> opened the app HOME and lost the event,
  // so the shipped shape carries host+path verbatim and works for any Luma URL shape.
  {
    name: "luma event (the device-verified shape)",
    url: "https://luma.com/cjhtl6rb",
    key: "luma",
    ios: "luma://luma.com/cjhtl6rb",
    pkg: "com.luma.mobile",
  },
  {
    name: "luma short host lu.ma",
    url: "https://lu.ma/cjhtl6rb",
    key: "luma",
    ios: "luma://lu.ma/cjhtl6rb",
    pkg: "com.luma.mobile",
  },
  {
    name: "luma keeps a query string (utm etc.)",
    url: "https://luma.com/cjhtl6rb?utm_source=zippy",
    key: "luma",
    ios: "luma://luma.com/cjhtl6rb?utm_source=zippy",
    pkg: "com.luma.mobile",
  },
  {
    name: "twitch channel",
    url: "https://www.twitch.tv/shroud",
    key: "twitch",
    ios: "twitch://stream/shroud",
    pkg: "tv.twitch.android.app",
  },
  {
    name: "twitch video",
    url: "https://www.twitch.tv/videos/123456789",
    key: "twitch",
    ios: "twitch://video/123456789",
    pkg: "tv.twitch.android.app",
  },
  {
    name: "twitch directory game",
    url: "https://www.twitch.tv/directory/game/Chess",
    key: "twitch",
    ios: "twitch://game/Chess",
    pkg: "tv.twitch.android.app",
  },
];

describe("matchPlatform", () => {
  for (const c of cases) {
    it(c.name, () => {
      const m = matchPlatform(c.url);
      expect(m, `${c.url} should match a platform`).not.toBeNull();
      expect(m!.key).toBe(c.key);
      expect(m!.ios).toBe(c.ios);
      // Android intent reuses scheme + package and self-falls-back to the web URL.
      expect(m!.android).toContain(`;package=${c.pkg};`);
      expect(m!.android).toContain(`S.browser_fallback_url=${encodeURIComponent(m!.web)}`);
      expect(m!.android.startsWith("intent://")).toBe(true);
      expect(m!.web).toBe(new URL(c.url).toString());
    });
  }

  it("github uses a schemeless (https) android intent, not a custom scheme", () => {
    // The github app has no custom scheme; the intent must package-target it over https.
    const m = matchPlatform("https://github.com/vercel/next.js");
    expect(m!.android).toContain("scheme=https;");
    expect(m!.android).toContain("intent://github.com/vercel/next.js#Intent;");
    expect(m!.android).toContain(";package=com.github.android;");
  });

  it("snapchat is ANDROID_ONLY: schemeless https intent, iOS lands on web", () => {
    // Like github — no add-friend custom scheme, so iOS "scheme" is the https URL and
    // the android intent package-targets the app over https.
    const m = matchPlatform("https://snapchat.com/add/team.snapchat");
    expect(m!.ios.startsWith("https://")).toBe(true); // no custom scheme → web on iOS
    expect(m!.android).toContain("scheme=https;");
    expect(m!.android).toContain("intent://snapchat.com/add/team.snapchat#Intent;");
    expect(m!.android).toContain(";package=com.snapchat.android;");
  });

  it("play-store is schemeless https (Play app opens via App Link intent)", () => {
    const m = matchPlatform("https://play.google.com/store/apps/details?id=com.foo");
    expect(m!.ios.startsWith("https://")).toBe(true); // no Play app on iOS → web
    expect(m!.android).toContain("scheme=https;");
    expect(m!.android).toContain(";package=com.android.vending;");
  });

  it("google.com (non-maps) is NOT hijacked by google-maps", () => {
    // google-maps only claims maps.google.com; the shared google.com host stays unmatched.
    expect(matchPlatform("https://www.google.com/search?q=hi")).toBeNull();
  });

  it("returns null for unknown hosts", () => {
    expect(matchPlatform("https://example.com/foo")).toBeNull();
  });

  it("returns null for non-http(s) and malformed input", () => {
    expect(matchPlatform("ftp://x.com")).toBeNull();
    expect(matchPlatform("not a url")).toBeNull();
    expect(matchPlatform("javascript:alert(1)")).toBeNull();
  });

  it("strips www and lowercases the host", () => {
    expect(matchPlatform("https://WWW.X.COM/nasa")?.key).toBe("x");
  });
});
