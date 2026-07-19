import { describe, it, expect } from "vitest";
import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
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
    expect(points[0].indexes).toEqual(["org_1"]);
    expect(points[0].blobs?.[0]).toBe("abc"); // slug
    expect(points[0].blobs?.[2]).toBe("desktop");
    expect(points[0].blobs?.[3]).toBe("x"); // platform key
    expect(points[0].blobs?.[4]).toBe("news.ycombinator.com"); // referrer host
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
    expect(points[0].blobs?.[6]).toBe("ios"); // os bucket
    expect(points[0].blobs?.[8]).toBe("instagram"); // campaign, lowercased from ?ref
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
    expect(body).toContain('beacon("opened")'); // app-launched signal
    expect(body).toContain('beacon("browser")'); // stayed-in-browser signal
    expect(body).toContain('"slug":"tw"');
  });
});

// Rich no-app fallback (fbu): a cloud-entitled record carries `fbu`, the absolute https
// URL of a cloud-hosted fallback page. Only the interstitial's AUTOMATIC timeout bail
// retargets to it — the visible "Continue in browser" anchor keeps the real web URL.
describe("rich fallback (fbu)", () => {
  const FBU = "https://cloud.zipthe.link/f/tw";
  const WEB = "https://x.com/nasa/status/999";
  const serve = (record: object) =>
    worker
      .fetch(req("/tw", { headers: { "user-agent": IPHONE } }), env({ tw: JSON.stringify(record) }))
      .then((r) => r.text());

  it("bails to the fbu while the visible fallback anchor keeps the web destination", async () => {
    const body = await serve({ url: WEB, fbu: FBU });
    expect(body).toContain(`var bailTo = ${JSON.stringify(FBU)}`); // automatic timeout bail
    expect(body).toContain(`<a id="fallback" href="${WEB}">`); // human tap path unchanged
  });

  it("without fbu the bail targets the web URL exactly as before", async () => {
    const body = await serve({ url: WEB });
    expect(body).toContain(`var bailTo = ${JSON.stringify(WEB)}`);
    expect(body).not.toContain("cloud.zipthe.link");
  });

  it("ignores a non-string or non-https fbu", async () => {
    for (const fbu of [42, "http://insecure.example.com/f", "ftp://x", { u: FBU }]) {
      const body = await serve({ url: WEB, fbu });
      expect(body).toContain(`var bailTo = ${JSON.stringify(WEB)}`); // defensively dropped
    }
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
    expect(res.headers.get("location")).toBe("https://secret.example.com/");
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
