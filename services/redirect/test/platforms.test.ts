import { describe, it, expect } from "vitest";
import { matchPlatform } from "../src/platforms.js";

// URL in → expected iOS scheme + Android intent shape + web fallback, per platform.
const cases: Array<{ name: string; url: string; key: string; ios: string; pkg: string }> = [
  { name: "linkedin profile", url: "https://www.linkedin.com/in/adimoyal", key: "linkedin", ios: "linkedin://in/adimoyal", pkg: "com.linkedin.android" },
  { name: "linkedin company", url: "https://linkedin.com/company/anthropic", key: "linkedin", ios: "linkedin://company/anthropic", pkg: "com.linkedin.android" },
  { name: "instagram profile", url: "https://instagram.com/nasa", key: "instagram", ios: "instagram://user?username=nasa", pkg: "com.instagram.android" },
  { name: "instagram post (app-open)", url: "https://www.instagram.com/p/ABC123/", key: "instagram", ios: "instagram://", pkg: "com.instagram.android" },
  { name: "instagram reel (app-open)", url: "https://www.instagram.com/reel/XYZ/", key: "instagram", ios: "instagram://", pkg: "com.instagram.android" },
  { name: "wa.me phone", url: "https://wa.me/15551234567", key: "whatsapp", ios: "whatsapp://send?phone=15551234567", pkg: "com.whatsapp" },
  { name: "wa.me with text", url: "https://wa.me/15551234567?text=hi%20there", key: "whatsapp", ios: "whatsapp://send?phone=15551234567&text=hi%20there", pkg: "com.whatsapp" },
  { name: "api.whatsapp send", url: "https://api.whatsapp.com/send?phone=15551234567", key: "whatsapp", ios: "whatsapp://send?phone=15551234567", pkg: "com.whatsapp" },
  { name: "reddit subreddit", url: "https://www.reddit.com/r/pics", key: "reddit", ios: "reddit://r/pics", pkg: "com.reddit.frontpage" },
  { name: "reddit post", url: "https://www.reddit.com/r/pics/comments/abc/title/", key: "reddit", ios: "reddit://r/pics/comments/abc/title/", pkg: "com.reddit.frontpage" },
  { name: "producthunt post", url: "https://www.producthunt.com/posts/zippy", key: "producthunt", ios: "producthunt://posts/zippy", pkg: "com.producthunt.hunt" },
  { name: "youtube watch", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", key: "youtube", ios: "youtube://watch?v=dQw4w9WgXcQ", pkg: "com.google.android.youtube" },
  { name: "youtu.be short", url: "https://youtu.be/dQw4w9WgXcQ", key: "youtube", ios: "youtube://watch?v=dQw4w9WgXcQ", pkg: "com.google.android.youtube" },
  { name: "youtube shorts", url: "https://www.youtube.com/shorts/abc123", key: "youtube", ios: "youtube://watch?v=abc123", pkg: "com.google.android.youtube" },
  { name: "tiktok profile", url: "https://www.tiktok.com/@nasa", key: "tiktok", ios: "tiktok://user?username=nasa", pkg: "com.zhiliaoapp.musically" },
  { name: "tiktok video (app-open)", url: "https://www.tiktok.com/@nasa/video/12345", key: "tiktok", ios: "tiktok://", pkg: "com.zhiliaoapp.musically" },
  { name: "x tweet", url: "https://x.com/nasa/status/12345", key: "x", ios: "twitter://status?id=12345", pkg: "com.twitter.android" },
  { name: "twitter profile", url: "https://twitter.com/nasa", key: "x", ios: "twitter://user?screen_name=nasa", pkg: "com.twitter.android" },
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
