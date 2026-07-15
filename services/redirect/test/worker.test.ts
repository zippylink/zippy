import { describe, it, expect } from "vitest";
import worker, { type Env } from "../src/index.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
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
