import { describe, it, expect } from "vitest";
import worker, { type Env } from "../src/index.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
const IPHONE_IG =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 329.0.0.41.94 (iPhone14,5; iOS 17_4; en_US)";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124 Mobile";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const TOKEN = "test-secret-token";

function mockKV(init: Record<string, string> = {}): KVNamespace {
  const m = new Map(Object.entries(init));
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
  } as unknown as KVNamespace;
}

function env(init: Record<string, string> = {}): Env {
  return { LINKS: mockKV(init), BASE_URL: "https://zipthe.link", API_TOKEN: TOKEN };
}

const req = (path: string, init?: RequestInit) => new Request(`https://zipthe.link${path}`, init);
const reqOn = (host: string, path: string, init?: RequestInit) =>
  new Request(`https://${host}${path}`, init);

describe("redirect", () => {
  it("301s a plain (non-platform) destination", async () => {
    const res = await worker.fetch(req("/abc"), env({ abc: "https://example.com/page" }));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://example.com/page");
  });

  it("serves the interstitial for a platform URL on mobile", async () => {
    const res = await worker.fetch(
      req("/tw", { headers: { "user-agent": IPHONE } }),
      env({ tw: "https://x.com/nasa/status/999" }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("twitter://status?id=999");
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("301s a platform URL on desktop (no interstitial)", async () => {
    const res = await worker.fetch(
      req("/tw", { headers: { "user-agent": DESKTOP } }),
      env({ tw: "https://x.com/nasa/status/999" }),
    );
    expect(res.status).toBe(301);
  });

  it("404s an unknown slug", async () => {
    const res = await worker.fetch(req("/nope"), env());
    expect(res.status).toBe(404);
  });
});

describe("multi-host resolution", () => {
  // Default host (BASE_URL's host = zipthe.link) reads the bare `<slug>` key — the
  // existing single-tenant records are untouched by the tenant-prefix scheme.
  it("default host resolves the bare slug key (back-compat)", async () => {
    const res = await worker.fetch(req("/abc"), env({ abc: "https://example.com/page" }));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://example.com/page");
  });

  // A mapped custom domain: host:<hostname> → { tenantId } routes the slug into that
  // tenant's namespace `t:<tenantId>:<slug>`.
  it("mapped custom host resolves via host:<hostname> → t:<tenantId>:<slug>", async () => {
    const res = await worker.fetch(
      reqOn("acme.com", "/promo"),
      env({
        "host:acme.com": JSON.stringify({ tenantId: "t_123" }),
        "t:t_123:promo": "https://example.com/acme-promo",
      }),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://example.com/acme-promo");
  });

  // The tenant namespace is isolated: a bare `<slug>` record is NOT visible on a custom host.
  it("does not fall back to the bare slug key on a custom host", async () => {
    const res = await worker.fetch(
      reqOn("acme.com", "/promo"),
      env({
        "host:acme.com": JSON.stringify({ tenantId: "t_123" }),
        promo: "https://example.com/leaked",
      }),
    );
    expect(res.status).toBe(404);
  });

  it("404s a host with no mapping record", async () => {
    const res = await worker.fetch(reqOn("unknown.com", "/promo"), env({ promo: "https://x.com" }));
    expect(res.status).toBe(404);
  });

  it("404s a host whose mapping record is malformed (never 500s)", async () => {
    const res = await worker.fetch(
      reqOn("acme.com", "/promo"),
      env({ "host:acme.com": "not-json", "t::promo": "https://example.com" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("JSON link values", () => {
  const TOKEN_H = { authorization: `Bearer ${TOKEN}` };

  it("plain string value is unchanged (back-compat)", async () => {
    const res = await worker.fetch(req("/abc"), env({ abc: "https://example.com/page" }));
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://example.com/page");
  });

  it("JSON value resolves the url and redirects", async () => {
    const res = await worker.fetch(
      req("/j"),
      env({ j: JSON.stringify({ url: "https://example.com/deep" }) }),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://example.com/deep");
  });

  it("ignores unknown extra fields (forward-compat)", async () => {
    const res = await worker.fetch(
      req("/j"),
      env({ j: JSON.stringify({ url: "https://example.com/x", plan: "pro", future: 1 }) }),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://example.com/x");
  });

  it("branded:true renders the Zippy footer on the interstitial", async () => {
    const res = await worker.fetch(
      req("/j", { headers: { "user-agent": IPHONE } }),
      env({ j: JSON.stringify({ url: "https://x.com/nasa/status/999", branded: true }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("zipped with Zippy");
  });

  it("branded absent/false shows no branding chrome", async () => {
    const res = await worker.fetch(
      req("/j", { headers: { "user-agent": IPHONE } }),
      env({ j: JSON.stringify({ url: "https://x.com/nasa/status/999" }) }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("zipped with Zippy");
  });

  it("malformed JSON value → 404 (never 500)", async () => {
    const res = await worker.fetch(req("/bad"), env({ bad: "{not valid json" }));
    expect(res.status).toBe(404);
  });

  it("GET /api/links/:slug resolves a JSON value's url", async () => {
    const res = await worker.fetch(
      req("/api/links/j", { headers: TOKEN_H }),
      env({ j: JSON.stringify({ url: "https://x.com/nasa", branded: true }) }),
    );
    expect(res.status).toBe(200);
    const info = (await res.json()) as { url: string; deeplink: string | null };
    expect(info.url).toBe("https://x.com/nasa");
    expect(info.deeplink).toBe("x");
  });
});

describe("Zippy mascot chrome", () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;

  it("interstitial carries the code-drawn Zippy bolt and stays under 6KB", async () => {
    const res = await worker.fetch(
      req("/tw", { headers: { "user-agent": IPHONE } }),
      env({ tw: "https://x.com/nasa/status/999" }),
    );
    const body = await res.text();
    expect(body).toContain('class="z"'); // the pulsing bolt SVG
    expect(body).toContain("#EEFF00"); // volt body — inline, no external asset
    expect(body).not.toContain("http://"); // no external requests
    expect(bytes(body)).toBeLessThan(6144);
  });

  it("404 shows the sad bolt + a link home, under 6KB", async () => {
    const res = await worker.fetch(req("/nope"), env());
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('class="z"');
    expect(body).toContain("doesn't live here");
    expect(body).toContain("https://zipthe.link"); // BASE_URL home link
    expect(bytes(body)).toBeLessThan(6144);
  });
});

// The iOS in-app-webview escape: per-context primary action baked into the served HTML.
// A webview escape can't be verified headless (see docs/ios-escape.md) — these assert the
// server hands the RIGHT technique to each context; the real handoff needs a device.
describe("iOS in-app-webview escape (technique matrix)", () => {
  const serve = (ua: string, url: string) =>
    worker
      .fetch(req("/e", { headers: { "user-agent": ua } }), env({ e: url }))
      .then((r) => r.text());

  it("scheme platform on iOS Safari → fires the custom scheme + Open-in-App tap target", async () => {
    const body = await serve(IPHONE, "https://instagram.com/nasa");
    expect(body).toContain("instagram://user?username=nasa"); // auto-fire
    expect(body).toContain('id="escape"'); // manual gesture path (URLgenius's #app-button)
    expect(body).not.toContain("x-safari-"); // scheme needs no Safari punt
  });

  it("scheme platform inside Instagram webview → same scheme fire (scheme escapes in-webview)", async () => {
    const body = await serve(IPHONE_IG, "https://x.com/nasa/status/1");
    expect(body).toContain("twitter://status?id=1");
    expect(body).toContain('id="escape"');
    expect(body).not.toContain("x-safari-");
  });

  it("github (schemeless) inside a webview → punts to real Safari via x-safari-https + tap target", async () => {
    const body = await serve(IPHONE_IG, "https://github.com/vercel/next.js");
    expect(body).toContain("x-safari-https://github.com/vercel/next.js"); // the punt
    expect(body).toContain("Open in Safari"); // gesture path label
  });

  it("github (schemeless) on real iOS Safari → no punt, just the UL-firing https URL", async () => {
    const body = await serve(IPHONE, "https://github.com/vercel/next.js");
    expect(body).not.toContain("x-safari-"); // UL fires natively in Safari
    expect(body).toContain("https://github.com/vercel/next.js");
  });

  it("Android webview → intent:// (self-falls-back), no iOS escape chrome", async () => {
    const body = await serve(ANDROID, "https://github.com/vercel/next.js");
    expect(body).toContain("intent://github.com/vercel/next.js");
    expect(body).not.toContain("x-safari-");
    expect(body).not.toContain('id="escape"'); // escape button is iOS-only
  });
});

describe("POST /api/links auth", () => {
  const body = JSON.stringify({ url: "https://example.com" });

  it("rejects a missing token", async () => {
    const res = await worker.fetch(req("/api/links", { method: "POST", body }), env());
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const res = await worker.fetch(
      req("/api/links", { method: "POST", body, headers: { authorization: "Bearer wrong" } }),
      env(),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/links", () => {
  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  it("creates a link with a random slug + reports the deeplink platform", async () => {
    const res = await worker.fetch(
      req("/api/links", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ url: "https://x.com/nasa" }),
      }),
      env(),
    );
    expect(res.status).toBe(201);
    const j = (await res.json()) as { slug: string; shortUrl: string; deeplink: string | null };
    expect(j.slug).toMatch(/^[a-zA-Z0-9-_]{6}$/);
    expect(j.shortUrl).toBe(`https://zipthe.link/${j.slug}`);
    expect(j.deeplink).toBe("x");
  });

  it("honors a valid custom slug and returns null deeplink for a plain URL", async () => {
    const res = await worker.fetch(
      req("/api/links", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ url: "https://example.com", slug: "my_link-1" }),
      }),
      env(),
    );
    expect(res.status).toBe(201);
    const j = (await res.json()) as { slug: string; deeplink: string | null };
    expect(j.slug).toBe("my_link-1");
    expect(j.deeplink).toBeNull();
  });

  it("rejects an invalid slug", async () => {
    const res = await worker.fetch(
      req("/api/links", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ url: "https://example.com", slug: "bad slug!" }),
      }),
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a non-http url", async () => {
    const res = await worker.fetch(
      req("/api/links", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ url: "javascript:alert(1)" }),
      }),
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("409s on a slug collision", async () => {
    const res = await worker.fetch(
      req("/api/links", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ url: "https://example.com", slug: "taken" }),
      }),
      env({ taken: "https://already.here" }),
    );
    expect(res.status).toBe(409);
  });
});

describe("GET /api/links/:slug", () => {
  it("returns link info with a valid token", async () => {
    const res = await worker.fetch(
      req("/api/links/abc", { headers: { authorization: `Bearer ${TOKEN}` } }),
      env({ abc: "https://x.com/nasa" }),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { url: string; deeplink: string | null };
    expect(j.url).toBe("https://x.com/nasa");
    expect(j.deeplink).toBe("x");
  });

  it("401s without a token", async () => {
    const res = await worker.fetch(req("/api/links/abc"), env({ abc: "https://x.com/nasa" }));
    expect(res.status).toBe(401);
  });

  it("404s an unknown slug", async () => {
    const res = await worker.fetch(
      req("/api/links/ghost", { headers: { authorization: `Bearer ${TOKEN}` } }),
      env(),
    );
    expect(res.status).toBe(404);
  });
});
