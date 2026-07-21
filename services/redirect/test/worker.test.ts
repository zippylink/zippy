import { describe, it, expect } from "vitest";
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import worker, { type Env } from "../src/index.js";
import { bestEffortMatch, bestEffortDomainCount } from "../src/best-effort.js";

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
/** Attach a Cloudflare geo (`cf.country`) to a request, like the CF runtime does. */
const withCf = (request: Request, country: string): Request => {
  (request as unknown as { cf: { country: string } }).cf = { country };
  return request;
};

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

  it("301s root to LANDING_URL when configured", async () => {
    const res = await worker.fetch(req("/"), { ...env(), LANDING_URL: "https://www.zipthe.link" });
    expect(res.status).toBe(301);
    // Response.redirect normalizes the URL (adds the trailing slash)
    expect(res.headers.get("location")).toBe("https://www.zipthe.link/");
  });

  it("404s root when LANDING_URL is unset (self-host default)", async () => {
    const res = await worker.fetch(req("/"), env());
    expect(res.status).toBe(404);
  });

  it("points the 404 home link at LANDING_URL when configured", async () => {
    const res = await worker.fetch(req("/nope"), {
      ...env(),
      LANDING_URL: "https://www.zipthe.link",
    });
    expect(await res.text()).toContain('href="https://www.zipthe.link"');
  });
});

describe("click data point (REDIRECTS binding)", () => {
  function capturingSink() {
    const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
    return {
      sink: { writeDataPoint: (p: (typeof points)[number]) => void points.push(p) },
      points,
    };
  }

  it("writes one point per human redirect with the KV record's orgId", async () => {
    const { sink, points } = capturingSink();
    const e = {
      ...env({ abc: JSON.stringify({ url: "https://x.com/nasa/status/9", orgId: "org_1" }) }),
      REDIRECTS: sink as unknown as AnalyticsEngineDataset,
    };
    await worker.fetch(
      req("/abc", {
        headers: { "user-agent": DESKTOP, referer: "https://news.ycombinator.com/item" },
      }),
      e,
    );
    expect(points).toHaveLength(1);
    expect(points[0]?.indexes).toEqual(["org_1"]);
    expect(points[0]?.blobs?.[0]).toBe("abc"); // slug
    expect(points[0]?.blobs?.[2]).toBe("desktop");
    expect(points[0]?.blobs?.[3]).toBe("x"); // platform key
    expect(points[0]?.blobs?.[4]).toBe("news.ycombinator.com"); // referrer host
  });

  it("captures os (ios/android split) and campaign (?ref / ?utm_source)", async () => {
    const { sink, points } = capturingSink();
    const e = {
      ...env({ drop: JSON.stringify({ url: "https://example.com/x", orgId: "org_2" }) }),
      REDIRECTS: sink as unknown as AnalyticsEngineDataset,
    };
    const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
    await worker.fetch(req("/drop?ref=Instagram", { headers: { "user-agent": IPHONE } }), e);
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs?.[6]).toBe("ios"); // os bucket
    expect(points[0]?.blobs?.[8]).toBe("instagram"); // campaign, lowercased from ?ref
  });

  it("does not count crawlers and tolerates a missing binding", async () => {
    const { sink, points } = capturingSink();
    const e = {
      ...env({ abc: "https://example.com" }),
      REDIRECTS: sink as unknown as AnalyticsEngineDataset,
    };
    await worker.fetch(req("/abc", { headers: { "user-agent": "Twitterbot/1.0" } }), e);
    expect(points).toHaveLength(0);
    // no binding at all → still redirects fine
    const res = await worker.fetch(req("/abc"), env({ abc: "https://example.com" }));
    expect(res.status).toBe(301);
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
    // JSON records are cloud-managed LIVING links → 302 so edits propagate (301 is cached forever)
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/deep");
  });

  it("ignores unknown extra fields (forward-compat)", async () => {
    const res = await worker.fetch(
      req("/j"),
      env({ j: JSON.stringify({ url: "https://example.com/x", plan: "pro", future: 1 }) }),
    );
    expect(res.status).toBe(302); // JSON record = living link
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

  it("snapchat (ANDROID_ONLY) inside a webview → Safari punt + tap target, like github", async () => {
    const body = await serve(IPHONE_IG, "https://snapchat.com/add/team.snapchat");
    expect(body).toContain("x-safari-https://snapchat.com/add/team.snapchat"); // the punt
    expect(body).toContain("Open in Safari"); // gesture path label
  });

  it("snapchat (ANDROID_ONLY) on Android → intent:// opens the app to add-friend", async () => {
    const body = await serve(ANDROID, "https://snapchat.com/add/team.snapchat");
    expect(body).toContain("intent://snapchat.com/add/team.snapchat");
    expect(body).toContain(";package=com.snapchat.android;");
    expect(body).not.toContain("x-safari-");
  });

  it("amazon (custom scheme) inside a webview → fires the scheme, no Safari punt", async () => {
    const body = await serve(IPHONE_IG, "https://www.amazon.com/dp/B01N05APQY?tag=me-20");
    expect(body).toContain("com.amazon.mobile.shopping.web://amazon.com/dp/B01N05APQY?tag=me-20");
    expect(body).not.toContain("x-safari-");
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

// A social crawler hitting a short link gets an OG/Twitter-card unfurl page instead
// of a redirect; every human UA still redirects. The OG fields are denormalized onto
// the KV value by the cloud (never scraped at request time).
describe("crawler-OG unfurl", () => {
  const FBBOT = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
  const TWBOT = "Twitterbot/1.0";
  const withOg = (url: string) =>
    JSON.stringify({
      url,
      og: {
        title: "Zippy",
        description: "Deeplinks that open the real app",
        image: "https://cdn/x.png",
      },
    });

  it("serves OG + Twitter meta to a crawler (no redirect)", async () => {
    const res = await worker.fetch(
      req("/p", { headers: { "user-agent": FBBOT } }),
      env({ p: withOg("https://x.com/nasa/status/1") }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('property="og:title" content="Zippy"');
    expect(body).toContain('property="og:image" content="https://cdn/x.png"');
    expect(body).toContain('name="twitter:card" content="summary_large_image"');
    expect(body).toContain('<link rel="canonical" href="https://x.com/nasa/status/1">');
  });

  it("falls back to the destination hostname as title when no OG stored", async () => {
    const res = await worker.fetch(
      req("/p", { headers: { "user-agent": TWBOT } }),
      env({ p: "https://example.com/page" }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('content="example.com"');
    expect(body).toContain('name="twitter:card" content="summary"'); // no image → small card
  });

  it("a human UA still redirects (crawler path never breaks a real click)", async () => {
    const res = await worker.fetch(
      req("/p", { headers: { "user-agent": DESKTOP } }),
      env({ p: withOg("https://example.com/page") }),
    );
    expect(res.status).toBe(302); // JSON record = living link
    expect(res.headers.get("location")).toBe("https://example.com/page");
  });
});

// POST /t — outcome telemetry beacon. Records one Analytics Engine data point per
// app-open/browser outcome; always 204 (a beacon has no client to see an error).
describe("outcome telemetry beacon (/t)", () => {
  function capturingEnv(): { e: Env; points: AnalyticsEngineDataPoint[] } {
    const points: AnalyticsEngineDataPoint[] = [];
    const e = {
      ...env(),
      CLICKS: { writeDataPoint: (p: AnalyticsEngineDataPoint) => points.push(p) },
    } as unknown as Env;
    return { e, points };
  }
  const post = (body: string, headers: Record<string, string> = {}) =>
    req("/t", { method: "POST", body, headers });

  it("writes a data point with the outcome + server-derived device, returns 204", async () => {
    const { e, points } = capturingEnv();
    const res = await worker.fetch(
      post(
        JSON.stringify({
          slug: "abc",
          host: "zipthe.link",
          outcome: "opened",
          platformKey: "instagram",
          sourceApp: "instagram",
        }),
        { "user-agent": IPHONE },
      ),
      e,
    );
    expect(res.status).toBe(204);
    expect(points).toHaveLength(1);
    const p = points[0]!;
    expect(p.indexes).toEqual(["abc"]);
    // blobs = [slug, host, outcome, sourceApp, platformKey, country, city, device]
    expect(p.blobs?.slice(0, 5)).toEqual([
      "abc",
      "zipthe.link",
      "opened",
      "instagram",
      "instagram",
    ]);
    expect(p.blobs?.[7]).toBe("mobile"); // derived from the iPhone UA, not the client
  });

  it("drops an unknown outcome without writing (204)", async () => {
    const { e, points } = capturingEnv();
    const res = await worker.fetch(post(JSON.stringify({ slug: "abc", outcome: "hacked" })), e);
    expect(res.status).toBe(204);
    expect(points).toHaveLength(0);
  });

  it("never throws on a malformed body (204)", async () => {
    const { e, points } = capturingEnv();
    const res = await worker.fetch(post("{not json"), e);
    expect(res.status).toBe(204);
    expect(points).toHaveLength(0);
  });

  it("no-ops silently when CLICKS is unbound (self-host / local dev)", async () => {
    const res = await worker.fetch(
      post(JSON.stringify({ slug: "abc", outcome: "browser" })),
      env(),
    );
    expect(res.status).toBe(204);
  });

  it("405s a GET on /t", async () => {
    const res = await worker.fetch(req("/t"), env());
    expect(res.status).toBe(405);
  });
});

// Wave 2.9 — cloud event stream: when EVENTS_URL is set, each recorded beacon is also
// forwarded as a fire-and-forget JSON POST. Off entirely when unset (self-host / local).
describe("beacon event forwarding (EVENTS_URL)", () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    req("/t", { method: "POST", body, headers });
  const eventsEnv = (): Env => ({
    ...env(),
    EVENTS_URL: "https://cloud.example/events",
    EVENTS_TOKEN: "evt-token",
  });
  const validBeacon = JSON.stringify({
    slug: "abc",
    host: "zipthe.link",
    outcome: "opened",
    platformKey: "instagram",
    sourceApp: "instagram",
    ts: 1234,
  });

  /** Minimal ExecutionContext: collects waitUntil promises so tests can await them. */
  function stubCtx() {
    const waits: Promise<unknown>[] = [];
    return {
      waits,
      ctx: {
        waitUntil: (p: Promise<unknown>) => void waits.push(p),
      } as unknown as ExecutionContext,
    };
  }

  /** Swap globalThis.fetch for a recording stub; callers must restore() in finally. */
  function stubFetch(
    impl: () => Promise<Response> = async () => new Response(null, { status: 202 }),
  ) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const real = globalThis.fetch;
    // The worker only ever calls fetch(EVENTS_URL, init) — a string URL.
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return impl();
    }) as unknown as typeof fetch;
    return { calls, restore: () => void (globalThis.fetch = real) };
  }

  it("forwards the sanitized event once with the bearer header (still 204)", async () => {
    const f = stubFetch();
    try {
      const { waits, ctx } = stubCtx();
      const res = await worker.fetch(post(validBeacon, { "user-agent": IPHONE }), eventsEnv(), ctx);
      expect(res.status).toBe(204);
      await Promise.all(waits);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]!.url).toBe("https://cloud.example/events");
      const headers = f.calls[0]!.init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer evt-token");
      // Server-derived fields (device/geo) come from the request, never the client body.
      expect(JSON.parse(f.calls[0]!.init?.body as string)).toEqual({
        slug: "abc",
        host: "zipthe.link",
        outcome: "opened",
        sourceApp: "instagram",
        platformKey: "instagram",
        country: "",
        city: "",
        device: "mobile",
        ts: 1234,
      });
    } finally {
      f.restore();
    }
  });

  // A/B variant on the outcome beacon — the differentiator: per-variant APP-OPEN rate.
  // Client-supplied (it round-trips through the interstitial), so it is re-validated here.
  const beaconWith = (abVariant: unknown) =>
    JSON.stringify({
      slug: "abc",
      host: "zipthe.link",
      outcome: "opened",
      platformKey: "instagram",
      sourceApp: "instagram",
      abVariant,
      ts: 1234,
    });

  const forwardedBody = async (body: string) => {
    const f = stubFetch();
    try {
      const { waits, ctx } = stubCtx();
      const res = await worker.fetch(post(body, { "user-agent": IPHONE }), eventsEnv(), ctx);
      expect(res.status).toBe(204); // a beacon NEVER errors, whatever the body says
      await Promise.all(waits);
      return f.calls[0]!.init?.body as string;
    } finally {
      f.restore();
    }
  };

  it("forwards a valid variant index", async () => {
    expect(JSON.parse(await forwardedBody(beaconWith(2))).abVariant).toBe(2);
    expect(JSON.parse(await forwardedBody(beaconWith(0))).abVariant).toBe(0);
  });

  it("drops an out-of-range, non-integer, or non-number variant (rest still forwards)", async () => {
    for (const bad of [4, 99, -1, 1.5, "1", null, {}, NaN]) {
      const parsed = JSON.parse(await forwardedBody(beaconWith(bad)));
      expect(parsed).not.toHaveProperty("abVariant");
      expect(parsed.outcome).toBe("opened"); // the outcome still records
    }
  });

  it("is byte-identical to the pre-A/B payload when the beacon carries no variant", async () => {
    // The overwhelming majority of links have no split — those payloads must not change.
    expect(await forwardedBody(validBeacon)).toBe(
      JSON.stringify({
        slug: "abc",
        host: "zipthe.link",
        outcome: "opened",
        sourceApp: "instagram",
        platformKey: "instagram",
        country: "",
        city: "",
        device: "mobile",
        ts: 1234,
      }),
    );
  });

  it("does not forward when EVENTS_URL is unset (self-host / local)", async () => {
    const f = stubFetch();
    try {
      const { waits, ctx } = stubCtx();
      const res = await worker.fetch(post(validBeacon), env(), ctx);
      expect(res.status).toBe(204);
      await Promise.all(waits);
      expect(f.calls).toHaveLength(0);
    } finally {
      f.restore();
    }
  });

  it("does not forward a dropped (invalid) beacon", async () => {
    const f = stubFetch();
    try {
      const { waits, ctx } = stubCtx();
      const res = await worker.fetch(post(JSON.stringify({ slug: "abc" })), eventsEnv(), ctx);
      expect(res.status).toBe(204);
      await Promise.all(waits);
      expect(f.calls).toHaveLength(0);
    } finally {
      f.restore();
    }
  });

  it("still 204s when the forward fetch rejects (failure is swallowed)", async () => {
    const f = stubFetch(() => Promise.reject(new Error("cloud down")));
    try {
      const { waits, ctx } = stubCtx();
      const res = await worker.fetch(post(validBeacon), eventsEnv(), ctx);
      expect(res.status).toBe(204);
      await Promise.all(waits); // resolves — the rejection never escapes waitUntil
      expect(f.calls).toHaveLength(1);
    } finally {
      f.restore();
    }
  });
});

// The interstitial wires the beacon: it POSTs to /t on visibility/pagehide outcomes.
describe("interstitial telemetry wiring", () => {
  it("embeds the /t beacon with the slug + platform", async () => {
    const body = await worker
      .fetch(
        req("/tw", { headers: { "user-agent": IPHONE } }),
        env({ tw: "https://x.com/nasa/status/9" }),
      )
      .then((r) => r.text());
    expect(body).toContain('navigator.sendBeacon("/t"');
    // Both outcomes route through the single-send guard, hence send() not beacon().
    expect(body).toContain('send("opened")'); // app-launched signal
    expect(body).toContain('send("browser")'); // stayed-in-browser signal
    expect(body).toContain('"slug":"tw"');
  });
});

// Rich no-app fallback (fbu): a cloud-entitled record carries `fbu`, the absolute https
// URL of a cloud-hosted fallback page. The interstitial no longer auto-navigates anywhere
// when the app doesn't open, so the visible "Continue in browser" anchor is the ONLY door
// to that page — it must target the fbu when present, else the plain web URL.
describe("rich fallback (fbu)", () => {
  const FBU = "https://cloud.zipthe.link/f/tw";
  const WEB = "https://x.com/nasa/status/999";
  const serve = (record: object) =>
    worker
      .fetch(req("/tw", { headers: { "user-agent": IPHONE } }), env({ tw: JSON.stringify(record) }))
      .then((r) => r.text());

  it("points the visible 'Continue in browser' anchor at the fbu (its only door now)", async () => {
    const body = await serve({ url: WEB, fbu: FBU });
    expect(body).toContain(`<a id="fallback" href="${FBU}">`);
    expect(body).not.toContain(`<a id="fallback" href="${WEB}">`);
  });

  it("without fbu the fallback anchor targets the web URL exactly as before", async () => {
    const body = await serve({ url: WEB });
    expect(body).toContain(`<a id="fallback" href="${WEB}">`);
    expect(body).not.toContain("cloud.zipthe.link");
  });

  it("ignores a non-string or non-https fbu", async () => {
    for (const fbu of [42, "http://insecure.example.com/f", "ftp://x", { u: FBU }]) {
      const body = await serve({ url: WEB, fbu });
      expect(body).toContain(`<a id="fallback" href="${WEB}">`); // defensively dropped
    }
  });
});

// The founder call: the automatic timeout redirect was "too fast and confusing". The
// instant app-open stays; when it doesn't land, the visitor stays put and chooses.
describe("no-app timeout: measures, never navigates", () => {
  const WEB = "https://x.com/nasa/status/999";
  const FBU = "https://cloud.zipthe.link/f/tw";
  const serve = (record: object) =>
    worker
      .fetch(req("/tw", { headers: { "user-agent": IPHONE } }), env({ tw: JSON.stringify(record) }))
      .then((r) => r.text());

  it("still fires the instant app-open", async () => {
    expect(await serve({ url: WEB })).toContain("window.location.replace(iosPrimary)");
  });

  it("no longer auto-navigates to the fallback on the timer", async () => {
    const body = await serve({ url: WEB, fbu: FBU });
    expect(body).not.toContain("bailTo"); // the old automatic bail target is gone
    // The ONLY location.replace left is the app-open (Android's intent:// self-falls-back).
    expect(body.match(/window\.location\.replace\(/g)).toEqual([
      "window.location.replace(",
      "window.location.replace(",
    ]);
    expect(body).toContain("window.location.replace(android)");
  });

  it("still records a 'browser' outcome — app-open rate must survive", async () => {
    expect(await serve({ url: WEB })).toContain('send("browser")');
  });

  it("swaps the copy so the page stops pretending it's still opening", async () => {
    const body = await serve({ url: WEB });
    expect(body).toContain(`<p id="status">Opening the x app`); // before
    expect(body).toContain(`s.textContent = "Welp — the x app didn't open.`); // after
    expect(body).toContain('document.getElementById("status")');
    expect(body).toContain(`<a id="escape" href="twitter://status?id=999"`); // retry is a real anchor
  });
});

// Because nothing navigates away any more, the page OUTLIVES its own timers — so a second
// beacon is now reachable on the very flow the new UX invites (time out → tap retry → app
// opens late). One click must still produce exactly one outcome, and the truest one.
describe("one outcome per click (single-send guard)", () => {
  const WEB = "https://x.com/nasa/status/999";
  const serve = () =>
    worker
      .fetch(
        req("/tw", { headers: { "user-agent": IPHONE } }),
        env({ tw: JSON.stringify({ url: WEB }) }),
      )
      .then((r) => r.text());

  // Executes the page's inline <script> against a fake DOM so the ORDERING of real events
  // is exercised, not just the source text. Returns every outcome the page tried to send.
  const runScript = async (ua = IPHONE) => {
    const body = await serve();
    const src = body.slice(body.lastIndexOf("<script>") + 8, body.lastIndexOf("</script>"));
    const sent: string[] = [];
    const listeners: Record<string, Array<() => void>> = {};
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const status = { textContent: "Opening the x app..." };
    const replaced: string[] = [];
    const on = (k: string, f: () => void) => (listeners[k] ??= []).push(f);
    const doc = {
      hidden: false,
      // A real document always has this; the copy-swap timer reads it so a page that
      // backgrounded to a launched app never comes back saying "the app didn't open".
      visibilityState: "visible",
      addEventListener: on,
      getElementById: (id: string) => (id === "status" ? status : null),
    };
    // Deliberate: `src` is the interstitial WE just rendered, and executing it is the
    // whole point — event ORDERING (visibilitychange before pagehide) is what regressed,
    // and no amount of string-matching the source can catch that. Not attacker input.
    // oxlint-disable-next-line typescript/no-implied-eval
    const fn = new Function(
      "document",
      "window",
      "navigator",
      "setTimeout",
      "clearTimeout",
      src,
    ) as (...a: unknown[]) => void;
    fn(
      doc,
      {
        addEventListener: on,
        location: {
          replace(u: string) {
            replaced.push(u);
          },
        },
      },
      {
        userAgent: ua,
        sendBeacon: (_u: string, b: string) => sent.push(JSON.parse(b).outcome),
      },
      (f: () => void, ms: number) => timers.push({ fn: f, ms }),
      () => {},
    );
    const fire = (k: string) => (listeners[k] ?? []).forEach((f) => f());
    const listenerCount = (k: string) => (listeners[k] ?? []).length;
    // Timers are registered copy-swap first, long-stop second (see interstitial.ts).
    return {
      sent,
      status,
      doc,
      fire,
      listenerCount,
      replaced,
      tick: (i: number) => timers[i]?.fn(),
      timers,
    };
  };

  it("the copy-swap timer rewrites the copy and emits NO beacon", async () => {
    const p = await runScript();
    p.tick(0);
    expect(p.status.textContent).toContain("didn't open");
    expect(p.sent).toEqual([]); // a slow launch is not a 'browser' outcome
  });

  it("an app-open AFTER the copy swap records 'opened' and never also 'browser'", async () => {
    const p = await runScript();
    p.tick(0); // 1.5s: copy swaps, still no outcome
    p.doc.hidden = true;
    p.fire("visibilitychange"); // they tapped retry and the app launched late
    p.tick(1); // long-stop fires anyway
    p.fire("pagehide"); // and so does pagehide
    expect(p.sent).toEqual(["opened"]); // exactly one, and the true one
  });

  it("pagehide with no app-open records 'browser' exactly once", async () => {
    const p = await runScript();
    p.fire("pagehide");
    p.fire("pagehide");
    p.tick(1);
    expect(p.sent).toEqual(["browser"]);
  });

  it("the long-stop timer records 'browser' when the visitor just sits there", async () => {
    const p = await runScript();
    p.tick(0);
    expect(p.sent).toEqual([]);
    p.tick(1);
    expect(p.sent).toEqual(["browser"]);
  });

  it("the long-stop is well after the copy swap, not the same clock", async () => {
    const p = await runScript();
    expect(p.timers[0]!.ms).toBe(1500);
    expect(p.timers[1]!.ms).toBeGreaterThanOrEqual(8000);
  });

  // ── ANDROID IS UNMEASURED, AND SAYS SO ──────────────────────────────────────────────
  // The bug this locks shut: the "opened" listener used to be registered ABOVE the Android
  // branch while both "browser" emitters sat below it. The branch returns, so on Android
  // the ONLY reachable outcome was "opened" — a failure could not be recorded as a failure
  // and the published Android rate read near-100% by construction.

  it("Android records exactly one 'unmeasured' outcome and never a success", async () => {
    const p = await runScript(ANDROID);
    expect(p.sent).toEqual(["unmeasured"]);
    // And it really did hand off to the OS — the row is not a substitute for the redirect.
    expect(p.replaced).toHaveLength(1);
    expect(p.replaced[0]).toContain("intent://");
  });

  it("Android registers NO outcome listener — the structural fix, not just the ordering", async () => {
    const p = await runScript(ANDROID);
    // Zero listeners is the guarantee: with none registered, no later event can relabel
    // this tap. Chrome fires visibilitychange->hidden on UNLOAD as well as on
    // backgrounding, so an "opened" listener here would score the fallback navigation
    // (the failure) as an app open.
    expect(p.listenerCount("visibilitychange")).toBe(0);
    expect(p.listenerCount("pagehide")).toBe(0);
    // Fire them anyway: even a stray event cannot add an outcome.
    p.doc.hidden = true;
    p.fire("visibilitychange");
    p.fire("pagehide");
    expect(p.sent).toEqual(["unmeasured"]);
  });

  it("Android still gets the copy swap — an intent:// a webview swallows leaves the page up", async () => {
    const p = await runScript(ANDROID);
    expect(p.status.textContent).not.toContain("didn't open");
    p.tick(0);
    expect(p.status.textContent).toContain("didn't open");
    expect(p.sent).toEqual(["unmeasured"]); // copy is UX; it never adds an outcome
  });

  it("the copy swap stays silent on a backgrounded page (it did open)", async () => {
    const p = await runScript(ANDROID);
    p.doc.visibilityState = "hidden"; // the app launched; we are in the background
    p.tick(0);
    expect(p.status.textContent).not.toContain("didn't open");
  });

  it("iOS is untouched by the Android branch — it still measures both outcomes", async () => {
    const opened = await runScript();
    opened.doc.hidden = true;
    opened.fire("visibilitychange");
    expect(opened.sent).toEqual(["opened"]);
    const stuck = await runScript();
    stuck.fire("pagehide");
    expect(stuck.sent).toEqual(["browser"]);
    // And iOS never writes the Android row.
    expect(stuck.sent).not.toContain("unmeasured");
  });

  it("routes every send through the guard — no bare beacon() call sites remain", async () => {
    const body = await serve();
    expect(body).toContain("function send(o){ if(done) return; done = true; beacon(o); }");
    // beacon() appears exactly twice: its own definition, and the single call inside
    // send(). Any new bare call site breaks this and the double-count is caught here.
    expect(body.match(/beacon\(/g)).toEqual(["beacon(", "beacon("]);
    expect(body).not.toContain('done = true; beacon("opened")'); // the old unguarded assign
  });
});

// Inline <script> injection: every value the interstitial bakes into a <script> block goes
// through jsLit, which escapes "<" to <. Bare JSON.stringify is NOT enough — JSON is
// not a subset of HTML, so a "</script>" inside a string closes the tag early and the rest
// is parsed as markup. These records are what a SELF-HOSTER can write straight into KV,
// bypassing every cloud-side validator — the engine has to be safe on its own.
describe("inline-script injection (jsLit)", () => {
  const BREAKOUT = "</script><script>alert(1)</script>";
  const serve = (record: object, slug = "x") =>
    worker
      .fetch(
        req(`/${slug}`, { headers: { "user-agent": IPHONE } }),
        env({ [slug]: JSON.stringify(record) }),
      )
      .then((r) => r.text());

  // A perfectly valid https URL can still carry "</script>" in its path — so this vector
  // survives an "is it https?" check and is not self-host-only. fbu now lands in the
  // "Continue in browser" href rather than the <script>, so `esc` is the guard.
  it("a breakout in fbu can't close the script tag", async () => {
    const body = await serve({
      url: "https://x.com/nasa",
      fbu: `https://evil.example.com/${BREAKOUT}`,
    });
    expect(body).not.toContain("</script><script>alert(1)");
    expect(body).toContain("&lt;/script&gt;"); // escaped, inert inside the href attribute
  });

  it("a breakout in the destination URL can't close the script tag", async () => {
    const body = await serve({ url: `https://x.com/${BREAKOUT}` });
    expect(body).not.toContain("</script><script>alert(1)");
  });

  it("a breakout in the slug can't close the script tag via the beacon body", async () => {
    const body = await serve({ url: "https://x.com/nasa" }, `a${BREAKOUT}`);
    expect(body).not.toContain("</script><script>alert(1)");
  });

  it("ordinary records are unaffected — no stray escaping", async () => {
    const body = await serve({ url: "https://x.com/nasa/status/999" });
    expect(body).toContain(JSON.stringify("https://x.com/nasa/status/999"));
  });
});

describe("routing (geo + device/OS)", () => {
  // A cloud-managed JSON record with routing rules under slug `r`, default `https://default.com`.
  const routed = (routing: object, url = "https://default.com") =>
    env({ r: JSON.stringify({ url, routing }) });

  it("routes iOS to the ios destination (302 + no-store)", async () => {
    const res = await worker.fetch(
      req("/r", { headers: { "user-agent": IPHONE } }),
      routed({ ios: "https://ios.example.com", android: "https://play.example.com" }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://ios.example.com");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("routes Android to the android destination", async () => {
    const res = await worker.fetch(
      req("/r", { headers: { "user-agent": ANDROID } }),
      routed({ ios: "https://ios.example.com", android: "https://play.example.com" }),
    );
    expect(res.headers.get("location")).toBe("https://play.example.com");
  });

  it("routes by country when no device rule matches", async () => {
    const res = await worker.fetch(
      withCf(req("/r", { headers: { "user-agent": DESKTOP } }), "US"),
      routed({ geo: { US: "https://us.example.com" } }),
    );
    expect(res.headers.get("location")).toBe("https://us.example.com");
  });

  it("device/OS beats geo (both set, iOS visitor from US → ios)", async () => {
    const res = await worker.fetch(
      withCf(req("/r", { headers: { "user-agent": IPHONE } }), "US"),
      routed({ ios: "https://ios.example.com", geo: { US: "https://us.example.com" } }),
    );
    expect(res.headers.get("location")).toBe("https://ios.example.com");
  });

  it("falls back to the default url when nothing matches", async () => {
    const res = await worker.fetch(
      withCf(req("/r", { headers: { "user-agent": DESKTOP } }), "FR"),
      routed({ ios: "https://ios.example.com", geo: { US: "https://us.example.com" } }),
    );
    expect(res.headers.get("location")).toBe("https://default.com");
  });
});

describe("scheduled destinations (sched)", () => {
  const now = Math.floor(Date.now() / 1000);
  // A cloud-managed JSON record with a schedule under slug `s`, default `https://default.com`.
  const sched = (entries: unknown, extra: object = {}) =>
    env({ s: JSON.stringify({ url: "https://default.com", sched: entries, ...extra }) });

  it("a past entry replaces the default (302 + no-store)", async () => {
    const res = await worker.fetch(
      req("/s", { headers: { "user-agent": DESKTOP } }),
      sched([{ from: now - 100, url: "https://live.example.com" }]),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://live.example.com");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("a future entry is ignored (default stands, still no-store)", async () => {
    const res = await worker.fetch(
      req("/s", { headers: { "user-agent": DESKTOP } }),
      sched([{ from: now + 100, url: "https://later.example.com" }]),
    );
    expect(res.headers.get("location")).toBe("https://default.com");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("the latest of two past entries wins", async () => {
    const res = await worker.fetch(
      req("/s", { headers: { "user-agent": DESKTOP } }),
      sched([
        { from: now - 50, url: "https://second.example.com" },
        { from: now - 200, url: "https://first.example.com" },
      ]),
    );
    expect(res.headers.get("location")).toBe("https://second.example.com");
  });

  it("composes with routing — sched sets the default, an ios rule still beats it", async () => {
    const e = sched([{ from: now - 100, url: "https://live.example.com" }], {
      routing: { ios: "https://ios.example.com" },
    });
    const ios = await worker.fetch(req("/s", { headers: { "user-agent": IPHONE } }), e);
    expect(ios.headers.get("location")).toBe("https://ios.example.com");
    const desktop = await worker.fetch(req("/s", { headers: { "user-agent": DESKTOP } }), e);
    expect(desktop.headers.get("location")).toBe("https://live.example.com");
  });

  it("drops malformed entries (bad from, non-https url) and keeps the good one", async () => {
    const res = await worker.fetch(
      req("/s", { headers: { "user-agent": DESKTOP } }),
      sched([
        { from: "soon", url: "https://bad.example.com" },
        { from: now - 100, url: "http://insecure.example.com" },
        { from: Infinity, url: "https://bad.example.com" },
        "junk",
        { from: now - 100, url: "https://good.example.com" },
      ]),
    );
    expect(res.headers.get("location")).toBe("https://good.example.com");
  });

  it("an all-malformed sched behaves like no sched (302, no no-store)", async () => {
    const res = await worker.fetch(
      req("/s", { headers: { "user-agent": DESKTOP } }),
      sched(["junk", { from: -5, url: "https://bad.example.com" }]),
    );
    // Emitted verbatim — the runtime no longer appends a trailing slash to a bare origin.
    expect(res.headers.get("location")).toBe("https://default.com/"); // Response.redirect canonicalizes bare origins with a trailing slash
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("plain-string records are unchanged (301, no no-store)", async () => {
    const res = await worker.fetch(
      req("/p", { headers: { "user-agent": DESKTOP } }),
      env({ p: "https://example.com/page" }),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("password gate", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const PW = "hunter2";
  const HASH = sha(PW);
  // Same derivation as the engine's gateToken — the cookie carries this, not the raw hash.
  const cookieToken = (slug: string) => sha(`${HASH}:${slug}:zippy-gate`);
  // A cloud-managed record gated by `pw` (the password HASH, never plaintext).
  const gated = (extra: object = {}) =>
    env({ p: JSON.stringify({ url: "https://secret.example.com", pw: HASH, ...extra }) });

  it("shows the gate (no redirect, no destination) for a protected link", async () => {
    const res = await worker.fetch(req("/p"), gated());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("This link is locked");
    expect(body).toContain('name="password"');
    expect(body).not.toContain("secret.example.com"); // destination never leaks
  });

  it("does NOT unfurl a protected link to social crawlers (no OG leak)", async () => {
    const res = await worker.fetch(
      req("/p", { headers: { "user-agent": "facebookexternalhit/1.1" } }),
      gated({ og: { title: "Secret drop" } }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("This link is locked");
    expect(body).not.toContain("Secret drop");
    expect(body).not.toContain("secret.example.com");
  });

  it("re-renders the gate with an error on the wrong password", async () => {
    const res = await worker.fetch(
      req("/p", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "password=wrong",
      }),
      gated(),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("wrong password");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("302s back with a cookie on the correct password", async () => {
    const res = await worker.fetch(
      req("/p", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `password=${PW}`,
      }),
      gated(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/p");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`zpw_p=${cookieToken("p")}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure"); // BASE_URL is https
  });

  it("proceeds to the redirect once the gate cookie is present", async () => {
    const res = await worker.fetch(
      req("/p", { headers: { cookie: `zpw_p=${cookieToken("p")}` } }),
      gated(),
    );
    // A cloud-managed JSON record is a living link → 302 (editable), not a 301.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://secret.example.com/"); // Response.redirect canonicalizes bare origins with a trailing slash
  });

  it("rejects a forged / mismatched gate cookie (still shows the gate)", async () => {
    const res = await worker.fetch(req("/p", { headers: { cookie: "zpw_p=deadbeef" } }), gated());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("This link is locked");
  });

  it("404s a password POST to a non-gated slug (nothing to unlock)", async () => {
    const res = await worker.fetch(
      req("/plain", { method: "POST", body: "password=x" }),
      env({ plain: "https://example.com" }),
    );
    expect(res.status).toBe(404);
  });

  // The cloud stores a slow, salted PBKDF2 hash; the engine (WebCrypto PBKDF2) must verify
  // the same bytes Node's pbkdf2Sync produced. This proves cross-impl parity.
  it("verifies a PBKDF2-hashed password (the format the cloud writes)", async () => {
    const salt = randomBytes(16);
    const iters = 100_000;
    const dk = pbkdf2Sync(PW, salt, iters, 32, "sha256").toString("hex");
    const stored = `pbkdf2$${iters}$${salt.toString("hex")}$${dk}`;
    const e = env({ p: JSON.stringify({ url: "https://secret.example.com", pw: stored }) });
    // wrong password → gate with error, no cookie
    const wrong = await worker.fetch(
      req("/p", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "password=nope",
      }),
      e,
    );
    expect(wrong.headers.get("set-cookie")).toBeNull();
    // correct password → 302 + cookie
    const ok = await worker.fetch(
      req("/p", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `password=${PW}`,
      }),
      env({ p: JSON.stringify({ url: "https://secret.example.com", pw: stored }) }),
    );
    expect(ok.status).toBe(302);
    expect(ok.headers.get("set-cookie") ?? "").toContain("zpw_p=");
  });
});

// Wave 2.8 — retargeting pixels. `px` entries survive only the strict whitelist
// (t ∈ meta|tiktok|gtm, id ∈ /^[A-Za-z0-9_-]{1,32}$/) — the charset IS the injection
// guard, since ids are interpolated into inline HTML/JS.
describe("retargeting pixels (px)", () => {
  const withPx = (px: unknown, url = "https://example.com/page") => JSON.stringify({ url, px });

  it("serves the pixel page (not a 30x) for a plain link with px on desktop", async () => {
    const res = await worker.fetch(
      req("/p", { headers: { "user-agent": DESKTOP } }),
      env({ p: withPx([{ t: "meta", id: "123456789" }]) }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("fbq('init','123456789')");
    expect(body).toContain('window.location.replace("https://example.com/page")');
    expect(body).toContain('href="https://example.com/page"'); // visible fallback link
  });

  it("embeds the snippet in the interstitial for a platform link on mobile", async () => {
    const res = await worker.fetch(
      req("/tw", { headers: { "user-agent": IPHONE } }),
      env({ tw: withPx([{ t: "tiktok", id: "ABC_tt-1" }], "https://x.com/nasa/status/999") }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("ttq.load('ABC_tt-1')"); // pixel fired
    expect(body).toContain("twitter://status?id=999"); // interstitial itself unchanged
  });

  it("drops invalid entries — malicious ids never reach any response", async () => {
    const evil = `x');fetch('//evil.com');//`;
    const res = await worker.fetch(
      req("/p", { headers: { "user-agent": DESKTOP } }),
      env({
        p: withPx([
          { t: "hotjar", id: "123" }, // bad type
          { t: "meta", id: evil }, // quotes/script chars
          { t: "gtm", id: "A".repeat(33) }, // > 32 chars
          { t: "meta", id: "GOOD_id-1" }, // the one survivor
        ]),
      }),
    );
    const body = await res.text();
    expect(body).not.toContain(evil);
    expect(body).not.toContain("A".repeat(33));
    expect(body).toContain("fbq('init','GOOD_id-1')");
  });

  it("all-invalid px behaves as no px (plain 302, no pixel page)", async () => {
    const res = await worker.fetch(
      req("/p", { headers: { "user-agent": DESKTOP } }),
      env({ p: withPx([{ t: "meta", id: "<script>alert(1)</script>" }]) }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/page");
  });

  it("a record without px behaves exactly as before", async () => {
    const res = await worker.fetch(
      req("/p", { headers: { "user-agent": DESKTOP } }),
      env({ p: JSON.stringify({ url: "https://example.com/page" }) }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/page");
  });

  it("crawlers get the OG card, never pixels", async () => {
    const res = await worker.fetch(
      req("/p", { headers: { "user-agent": "Twitterbot/1.0" } }),
      env({ p: withPx([{ t: "meta", id: "123456789" }]) }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("og:"); // unfurl card
    expect(body).not.toContain("fbq");
    expect(body).not.toContain("123456789");
  });

  it("caps at 5 entries", async () => {
    const px = Array.from({ length: 7 }, (_, i) => ({ t: "meta", id: `id${i}` }));
    const res = await worker.fetch(
      req("/p", { headers: { "user-agent": DESKTOP } }),
      env({ p: withPx(px) }),
    );
    const body = await res.text();
    expect(body).toContain("fbq('init','id4')");
    expect(body).not.toContain("id5");
    expect(body).not.toContain("id6");
  });
});

describe("A/B destination split (ab)", () => {
  // A cloud-managed JSON record with an A/B split under slug `ab`, default `https://default.com`.
  const split = (ab: unknown, extra: object = {}) =>
    env({ ab: JSON.stringify({ url: "https://default.com", ab, ...extra }) });
  const A = "https://a.example.com";
  const B = "https://b.example.com";

  function capturingSink() {
    const points: Array<{ blobs?: string[] }> = [];
    return {
      sink: { writeDataPoint: (p: (typeof points)[number]) => void points.push(p) },
      points,
    };
  }

  it("degenerate weights [1,0] always pick A and record variant blob '0' (302 + no-store)", async () => {
    const { sink, points } = capturingSink();
    const e = {
      ...split([
        { u: A, w: 1 },
        { u: B, w: 0 },
      ]),
      REDIRECTS: sink as unknown as AnalyticsEngineDataset,
    };
    for (let i = 0; i < 20; i++) {
      const res = await worker.fetch(req("/ab", { headers: { "user-agent": DESKTOP } }), e);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(A);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(points).toHaveLength(20);
    for (const p of points) expect(p.blobs?.[9]).toBe("0");
  });

  it("degenerate weights [0,1] always pick B and record variant blob '1'", async () => {
    const { sink, points } = capturingSink();
    const e = {
      ...split([
        { u: A, w: 0 },
        { u: B, w: 1 },
      ]),
      REDIRECTS: sink as unknown as AnalyticsEngineDataset,
    };
    for (let i = 0; i < 20; i++) {
      const res = await worker.fetch(req("/ab", { headers: { "user-agent": DESKTOP } }), e);
      expect(res.headers.get("location")).toBe(B);
    }
    for (const p of points) expect(p.blobs?.[9]).toBe("1");
  });

  // The whole point of threading the variant to the OUTCOME beacon: "variant B opened the
  // app more often", not just "variant B got more clicks". The interstitial learns it the
  // same way it learns slug/platformKey — server-serialized into the beacon body.
  it("bakes the picked variant into the interstitial's beacon body", async () => {
    const e = split([
      { u: "https://instagram.com/a", w: 0 },
      { u: "https://instagram.com/b", w: 1 },
    ]);
    const res = await worker.fetch(req("/ab", { headers: { "user-agent": IPHONE } }), e);
    const body = await res.text();
    expect(body).toContain('"abVariant":1');
  });

  it("omits abVariant from the beacon body when the link has no split", async () => {
    const e = env({ ab: JSON.stringify({ url: "https://instagram.com/nasa" }) });
    const res = await worker.fetch(req("/ab", { headers: { "user-agent": IPHONE } }), e);
    expect(await res.text()).not.toContain("abVariant");
  });

  it("a 50/50 split lands both variants over ~200 taps", async () => {
    const e = split([
      { u: A, w: 1 },
      { u: B, w: 1 },
    ]);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const res = await worker.fetch(req("/ab", { headers: { "user-agent": DESKTOP } }), e);
      seen.add(res.headers.get("location") ?? "");
    }
    expect(seen).toEqual(new Set([A, B]));
  });

  it("ignores the whole split on any invalid entry (http url, negative weight, single entry, all-zero)", async () => {
    const bad = [
      [
        { u: "http://insecure.example.com", w: 1 },
        { u: B, w: 1 },
      ],
      [
        { u: A, w: -1 },
        { u: B, w: 1 },
      ],
      [{ u: A, w: 1 }],
      [
        { u: A, w: 0 },
        { u: B, w: 0 },
      ],
    ];
    for (const ab of bad) {
      const res = await worker.fetch(req("/ab", { headers: { "user-agent": DESKTOP } }), split(ab));
      // no ab → plain living-link redirect; the bare origin is emitted verbatim
      expect(res.headers.get("location")).toBe("https://default.com/"); // Response.redirect canonicalizes bare origins with a trailing slash
    }
  });

  it("routing wins when both routing and ab are present — ab is ignored", async () => {
    const { sink, points } = capturingSink();
    const e = {
      ...split(
        [
          { u: A, w: 0 },
          { u: B, w: 1 },
        ],
        { routing: { ios: "https://ios.example.com" } },
      ),
      REDIRECTS: sink as unknown as AnalyticsEngineDataset,
    };
    const ios = await worker.fetch(req("/ab", { headers: { "user-agent": IPHONE } }), e);
    expect(ios.headers.get("location")).toBe("https://ios.example.com");
    const desktop = await worker.fetch(req("/ab", { headers: { "user-agent": DESKTOP } }), e);
    expect(desktop.headers.get("location")).toBe("https://default.com");
    for (const p of points) expect(p.blobs?.[9]).toBe(""); // no ab pick recorded
  });

  it("a platform variant serves the interstitial with the picked deeplink", async () => {
    const res = await worker.fetch(
      req("/ab", { headers: { "user-agent": IPHONE } }),
      split([
        { u: "https://x.com/nasa/status/999", w: 1 },
        { u: B, w: 0 },
      ]),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("twitter://status?id=999");
  });

  it("crawlers get the OG card, no ab pick recorded", async () => {
    const { sink, points } = capturingSink();
    const e = {
      ...split(
        [
          { u: A, w: 1 },
          { u: B, w: 1 },
        ],
        { og: { title: "Split" } },
      ),
      REDIRECTS: sink as unknown as AnalyticsEngineDataset,
    };
    const res = await worker.fetch(req("/ab", { headers: { "user-agent": "Twitterbot/1.0" } }), e);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Split");
    expect(points).toHaveLength(0);
  });
});

describe("Android intent fallback measurement (ANDROID_FALLBACK_MEASURE)", () => {
  const DEST = "https://x.com/nasa/status/999";
  const fbOf = (intentBody: string): string =>
    decodeURIComponent(/S\.browser_fallback_url=([^;]*);/.exec(intentBody)?.[1] ?? "");
  /** The `android` intent string the interstitial embedded, straight out of the page. */
  const intentFrom = (html: string): string =>
    JSON.parse(/var android = ("(?:[^"\\]|\\.)*");/.exec(html)?.[1] ?? '""');

  function capturing(kv: Record<string, string>, extra: Partial<Env> = {}) {
    const clicks: Array<{ indexes?: string[]; blobs?: string[] }> = [];
    const redirects: Array<{ blobs?: string[] }> = [];
    const e = {
      ...env(kv),
      CLICKS: { writeDataPoint: (p: (typeof clicks)[number]) => void clicks.push(p) },
      REDIRECTS: { writeDataPoint: (p: (typeof redirects)[number]) => void redirects.push(p) },
      ...extra,
    } as unknown as Env;
    return { e, clicks, redirects };
  }

  it("flag ON: browser_fallback_url is OUR short URL carrying the marker", async () => {
    const { e } = capturing({ tw: DEST }, { ANDROID_FALLBACK_MEASURE: "1" });
    const res = await worker.fetch(req("/tw", { headers: { "user-agent": ANDROID } }), e);
    expect(fbOf(intentFrom(await res.text()))).toBe("https://zipthe.link/tw?fb=1");
  });

  it("flag ON on a custom domain: the fallback stays on the host that resolves the slug", async () => {
    const { e } = capturing(
      { "host:go.acme.com": JSON.stringify({ tenantId: "t_1" }), "t:t_1:tw": DEST },
      { ANDROID_FALLBACK_MEASURE: "1" },
    );
    const res = await worker.fetch(
      reqOn("go.acme.com", "/tw", { headers: { "user-agent": ANDROID } }),
      e,
    );
    expect(fbOf(intentFrom(await res.text()))).toBe("https://go.acme.com/tw?fb=1");
  });

  it("flag OFF (default): the fallback is still the destination — Android stays unmeasured", async () => {
    const { e } = capturing({ tw: DEST });
    const res = await worker.fetch(req("/tw", { headers: { "user-agent": ANDROID } }), e);
    const body = await res.text();
    expect(fbOf(intentFrom(body))).toBe(DEST);
    expect(body).toContain('send("unmeasured")');
    // and an unrecognised flag value is OFF, not ON
    const { e: e2 } = capturing({ tw: DEST }, { ANDROID_FALLBACK_MEASURE: "true" });
    const res2 = await worker.fetch(req("/tw", { headers: { "user-agent": ANDROID } }), e2);
    expect(fbOf(intentFrom(await res2.text()))).toBe(DEST);
  });

  it("the marked request records an observed 'browser' outcome and 302s to the destination", async () => {
    const { e, clicks } = capturing({ tw: DEST }, { ANDROID_FALLBACK_MEASURE: "1" });
    const res = await worker.fetch(req("/tw?fb=1", { headers: { "user-agent": ANDROID } }), e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(DEST);
    // uncacheable, or a CDN swallows the hits we are counting
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(clicks).toHaveLength(1);
    // blobs = [slug, host, outcome, sourceApp, platformKey, country, city, device, abVariant]
    expect(clicks[0]?.indexes).toEqual(["tw"]);
    expect(clicks[0]?.blobs?.[0]).toBe("tw");
    expect(clicks[0]?.blobs?.[2]).toBe("browser");
    expect(clicks[0]?.blobs?.[4]).toBe("x"); // platform key, server-derived
    expect(clicks[0]?.blobs?.[7]).toBe("mobile");
  });

  it("LOOP GUARD: the marked request never renders the interstitial (no second intent)", async () => {
    const { e } = capturing({ tw: DEST }, { ANDROID_FALLBACK_MEASURE: "1" });
    const res = await worker.fetch(req("/tw?fb=1", { headers: { "user-agent": ANDROID } }), e);
    expect(res.status).toBe(302); // not 200
    const body = await res.text();
    expect(body).toBe("");
    expect(body).not.toContain("intent://");
  });

  it("the fallback hop is the SAME click — it writes no second REDIRECTS row", async () => {
    const { e, redirects } = capturing({ tw: DEST }, { ANDROID_FALLBACK_MEASURE: "1" });
    await worker.fetch(req("/tw", { headers: { "user-agent": ANDROID } }), e);
    expect(redirects).toHaveLength(1);
    await worker.fetch(req("/tw?fb=1", { headers: { "user-agent": ANDROID } }), e);
    expect(redirects).toHaveLength(1);
  });

  it("A/B: the fallback carries the variant, and the hop honours it over a fresh pick", async () => {
    const A = "https://x.com/a/status/1";
    const B = "https://x.com/b/status/2";
    // weights [1,0] → the pick is ALWAYS variant 0, so a landing on B can only come
    // from the carried ?v=1.
    const rec = JSON.stringify({
      url: "https://x.com/default/status/0",
      ab: [
        { u: A, w: 1 },
        { u: B, w: 0 },
      ],
    });
    const { e, clicks } = capturing({ ab: rec }, { ANDROID_FALLBACK_MEASURE: "1" });
    const page = await worker.fetch(req("/ab", { headers: { "user-agent": ANDROID } }), e);
    expect(fbOf(intentFrom(await page.text()))).toBe("https://zipthe.link/ab?fb=1&v=0");

    const hop = await worker.fetch(req("/ab?fb=1&v=1", { headers: { "user-agent": ANDROID } }), e);
    expect(hop.headers.get("location")).toBe(B);
    expect(clicks[0]?.blobs?.[8]).toBe("1"); // browser row attributed to the carried variant

    // a bogus carried index falls back to the normal pick (variant 0 here), never 500s
    const bad = await worker.fetch(req("/ab?fb=1&v=9", { headers: { "user-agent": ANDROID } }), e);
    expect(bad.headers.get("location")).toBe(A);
    expect(clicks[1]?.blobs?.[8]).toBe("0");
  });

  it("an unmarked request is untouched by the guard (fb= must be exactly 1)", async () => {
    const { e, clicks } = capturing({ tw: DEST }, { ANDROID_FALLBACK_MEASURE: "1" });
    const res = await worker.fetch(req("/tw?fb=0", { headers: { "user-agent": ANDROID } }), e);
    expect(res.status).toBe(200);
    expect(clicks).toHaveLength(0);
  });

  // ── DEFECT A: dark-launch law — flag OFF makes ?fb=1 an ordinary request ──────────────
  // Pre-change, the short-circuit was unconditional, so a crafted ?fb=1 dropped the click
  // and minted a phantom `browser` row even with the flag unset. Flag OFF must be
  // byte-identical to HEAD behaviour: interstitial + one click row + zero outcome rows.
  it("flag OFF + ?fb=1: serves the interstitial, counts the click, records NO outcome", async () => {
    const { e, clicks, redirects } = capturing({ tw: DEST }); // flag unset
    const res = await worker.fetch(req("/tw?fb=1", { headers: { "user-agent": ANDROID } }), e);
    expect(res.status).toBe(200); // interstitial, not a 302 short-circuit
    expect(await res.text()).toContain("intent://");
    expect(redirects).toHaveLength(1); // the click was counted
    expect(clicks).toHaveLength(0); // and NO browser outcome row
  });

  // ── DEFECT B: only an Android UA mints a `browser` row ────────────────────────────────
  // Flag ON, but the recording is gated on an Android UA — the flow the intent was built
  // for. The redirect still happens for everyone; a phantom row can't deflate the rate.
  it("flag ON + Android UA + ?fb=1: 302 + exactly one browser row, no click row", async () => {
    const { e, clicks, redirects } = capturing({ tw: DEST }, { ANDROID_FALLBACK_MEASURE: "1" });
    const res = await worker.fetch(req("/tw?fb=1", { headers: { "user-agent": ANDROID } }), e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(DEST);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.blobs?.[2]).toBe("browser");
    expect(redirects).toHaveLength(0); // the fallback hop is the SAME click, no new REDIRECTS row
  });

  it("flag ON + non-Android UA + ?fb=1: redirects but records ZERO outcome rows", async () => {
    for (const ua of [DESKTOP, "curl/8.4.0", IPHONE]) {
      const { e, clicks } = capturing({ tw: DEST }, { ANDROID_FALLBACK_MEASURE: "1" });
      const res = await worker.fetch(req("/tw?fb=1", { headers: { "user-agent": ua } }), e);
      expect(res.status, ua).toBe(302); // the redirect is for everyone
      expect(res.headers.get("location"), ua).toBe(DEST);
      expect(clicks, ua).toHaveLength(0); // but only Android mints a `browser` row
    }
  });

  it("flag ON: 50 curls mint ZERO browser rows (the proven inflation is closed)", async () => {
    const { e, clicks } = capturing({ tw: DEST }, { ANDROID_FALLBACK_MEASURE: "1" });
    for (let i = 0; i < 50; i++) {
      await worker.fetch(req("/tw?fb=1", { headers: { "user-agent": "curl/8.4.0" } }), e);
    }
    expect(clicks).toHaveLength(0);
  });
});

// ── Best-effort Android tier (Wave 13) ──────────────────────────────────────────────────────
// soundcloud.com is in the committed well-known-map.json (com.soundcloud.android) and is NOT in
// the hand-verified table — the stable fixture for this suite. open.spotify.com IS hand-verified.
const SC_URL = "https://soundcloud.com/flume/never-be-like-you";
const SC_PKG = "com.soundcloud.android";

describe("best-effort match (bestEffortMatch, pure)", () => {
  it("builds a package-pinned https intent, path handed to the app verbatim (never guessed)", () => {
    const m = bestEffortMatch(SC_URL);
    expect(m).not.toBeNull();
    expect(m?.key).toBe("soundcloud");
    expect(m?.android).toContain("intent://soundcloud.com/flume/never-be-like-you#Intent");
    expect(m?.android).toContain("scheme=https");
    expect(m?.android).toContain(`package=${SC_PKG}`);
    // UNMEASURED by construction: the fallback is EXACTLY the destination (anchored to `;end`,
    // so nothing — e.g. a ?fb=1 marker — is appended), never our measured fb=1 hop.
    expect(m?.android).toContain(`S.browser_fallback_url=${encodeURIComponent(SC_URL)};end`);
    // iOS does NOTHING — the ios form is the plain web URL, so the interstitial just serves web.
    expect(m?.ios).toBe(SC_URL);
  });

  it("returns null for a hand-verified host (never shadows the verified table)", () => {
    // discord.gg published assetlinks AND is hand-verified — it IS in well-known-map.json, so
    // this exercises the VERIFIED_HOSTS exclusion (not merely a map miss).
    expect(bestEffortMatch("https://discord.gg/abc")).toBeNull();
    expect(bestEffortMatch("https://open.spotify.com/track/abc")).toBeNull();
  });

  it("returns null for a host not in the map, and for non-http(s) URLs", () => {
    expect(bestEffortMatch("https://totally-unknown-1234.example/x")).toBeNull();
    expect(bestEffortMatch("ftp://soundcloud.com/x")).toBeNull();
    expect(bestEffortMatch("not a url")).toBeNull();
  });

  it("loaded a non-trivial map (guards an empty / broken artifact)", () => {
    expect(bestEffortDomainCount()).toBeGreaterThan(100);
  });
});

describe("best-effort Android tier — engine hook (BEST_EFFORT_ANDROID)", () => {
  const on = (init: Record<string, string> = {}): Env => ({
    ...env(init),
    BEST_EFFORT_ANDROID: "1",
  });

  it('springs the best-effort intent on Android when the flag is exactly "1"', async () => {
    const res = await worker.fetch(
      req("/sc", { headers: { "user-agent": ANDROID } }),
      on({ sc: SC_URL }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`package=${SC_PKG}`);
    expect(body).toContain("scheme=https");
    // Android interstitial path records exactly one unmeasured row — never opened/browser.
    expect(body).toContain('send("unmeasured")');
    // fallback stays EXACTLY the destination (anchored to `;end`), not our measured fb=1 hop.
    expect(body).toContain(`S.browser_fallback_url=${encodeURIComponent(SC_URL)};end`);
  });

  it('stays OFF unless the flag is exactly "1" (exact-match, like ANDROID_FALLBACK_MEASURE)', async () => {
    for (const flag of ["0", "true", "yes", "", "1 ", " 1", "11"]) {
      const res = await worker.fetch(req("/sc", { headers: { "user-agent": ANDROID } }), {
        ...env({ sc: SC_URL }),
        BEST_EFFORT_ANDROID: flag,
      });
      expect(res.status, `flag=${JSON.stringify(flag)}`).toBe(301); // plain redirect, no interstitial
    }
    const unset = await worker.fetch(
      req("/sc", { headers: { "user-agent": ANDROID } }),
      env({ sc: SC_URL }),
    );
    expect(unset.status).toBe(301);
  });

  it("never fires for a hand-verified platform, even with the flag on", async () => {
    const res = await worker.fetch(
      req("/sp", { headers: { "user-agent": ANDROID } }),
      on({ sp: "https://open.spotify.com/track/abc123" }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("scheme=spotify"); // the verified scheme, not a schemeless https intent
    expect(body).toContain("package=com.spotify.music");
    expect(body).toContain("track:abc123"); // the verified path form (spotify://track:abc123)
    expect(body).not.toContain("scheme=https"); // i.e. NOT a best-effort schemeless intent
  });

  it("falls through to today's behaviour for a host not in the map (flag on)", async () => {
    const res = await worker.fetch(
      req("/plain", { headers: { "user-agent": ANDROID } }),
      on({ plain: "https://totally-unknown-1234.example/page" }),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://totally-unknown-1234.example/page");
  });

  it("does nothing on iOS or desktop — best-effort is Android-only (flag on, mapped host)", async () => {
    const ios = await worker.fetch(
      req("/sc", { headers: { "user-agent": IPHONE } }),
      on({ sc: SC_URL }),
    );
    expect(ios.status).toBe(301);
    const desktop = await worker.fetch(
      req("/sc", { headers: { "user-agent": DESKTOP } }),
      on({ sc: SC_URL }),
    );
    expect(desktop.status).toBe(301);
  });
});

// No-signup door — the anon FIRST-CLICK PING. An unclaimed anonymous link (KV `anon:true`)
// tells the cloud a real visitor arrived; the cloud stamps firstClickAt idempotently and
// the 7-day claim window starts. Fire-and-forget on EVERY anon redirect (dupes are free),
// never for owned links, never without EVENTS_URL, and it must not break the redirect.
describe("anon first-click ping (no-signup door)", () => {
  const ANON = JSON.stringify({ url: "https://example.com/page", anon: true });
  const ANON_PLATFORM = JSON.stringify({ url: "https://x.com/nasa/status/999", anon: true });
  const OWNED = JSON.stringify({ url: "https://example.com/page", orgId: "org1" });
  const pingEnv = (init: Record<string, string>): Env => ({
    ...env(init),
    EVENTS_URL: "https://cloud.example/api/events/ingest",
    EVENTS_TOKEN: "evt-token",
  });

  function stubCtx() {
    const waits: Promise<unknown>[] = [];
    return {
      waits,
      ctx: {
        waitUntil: (p: Promise<unknown>) => void waits.push(p),
      } as unknown as ExecutionContext,
    };
  }
  function stubFetch() {
    const calls: { url: string; init?: RequestInit }[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    return { calls, restore: () => void (globalThis.fetch = orig) };
  }

  it("fires to /api/events/click with slug + bearer on a plain anon redirect", async () => {
    const f = stubFetch();
    const { ctx, waits } = stubCtx();
    try {
      const res = await worker.fetch(
        req("/anon1", { headers: { "user-agent": DESKTOP } }),
        pingEnv({ anon1: ANON }),
        ctx,
      );
      expect(res.status).toBe(302); // JSON (cloud-managed) records redirect 302
      await Promise.all(waits);
      expect(f.calls.length).toBe(1);
      const call = f.calls[0]!;
      expect(call.url).toBe("https://cloud.example/api/events/click");
      const body = JSON.parse(String(call.init?.body)) as { slug: string; host: string };
      expect(body.slug).toBe("anon1");
      const headers = (call.init?.headers ?? {}) as Record<string, string>;
      expect(headers.authorization).toBe("Bearer evt-token");
    } finally {
      f.restore();
    }
  });

  it("fires on the interstitial branch too (anon + mobile + platform)", async () => {
    const f = stubFetch();
    const { ctx, waits } = stubCtx();
    try {
      const res = await worker.fetch(
        req("/anon2", { headers: { "user-agent": IPHONE } }),
        pingEnv({ anon2: ANON_PLATFORM }),
        ctx,
      );
      expect(res.status).toBe(200); // interstitial
      await Promise.all(waits);
      expect(f.calls.filter((c) => c.url.endsWith("/api/events/click")).length).toBe(1);
    } finally {
      f.restore();
    }
  });

  it("never fires for an owned (claimed) link", async () => {
    const f = stubFetch();
    const { ctx, waits } = stubCtx();
    try {
      const res = await worker.fetch(
        req("/own1", { headers: { "user-agent": DESKTOP } }),
        pingEnv({ own1: OWNED }),
        ctx,
      );
      expect(res.status).toBe(302); // JSON (cloud-managed) records redirect 302
      await Promise.all(waits);
      expect(f.calls.length).toBe(0);
    } finally {
      f.restore();
    }
  });

  it("never fires when EVENTS_URL is unset, and the redirect still works", async () => {
    const f = stubFetch();
    const { ctx, waits } = stubCtx();
    try {
      const res = await worker.fetch(
        req("/anon3", { headers: { "user-agent": DESKTOP } }),
        env({ anon3: ANON }),
        ctx,
      );
      expect(res.status).toBe(302); // JSON (cloud-managed) records redirect 302
      await Promise.all(waits);
      expect(f.calls.length).toBe(0);
    } finally {
      f.restore();
    }
  });
});
