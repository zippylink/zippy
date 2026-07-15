#!/usr/bin/env node

// src/cli.ts
import { join as join2 } from "node:path";
import {
  intro,
  outro,
  log,
  note,
  spinner,
  isCancel,
  cancel,
  password,
  select
} from "@clack/prompts";
import pc from "picocolors";

// src/recipe.ts
var RECIPES = [];

// src/recipes/neon.ts
var NEON_API = "https://console.neon.tech/api/v2";
async function safeGet(url, token) {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    });
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: String(err) };
  }
}
async function safePost(url, token, payload) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    let body;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: String(err) };
  }
}
async function validate(creds) {
  const token = creds["NEON_API_KEY"];
  if (!token) return { ok: false, detail: "NEON_API_KEY is missing" };
  const { ok, status, body } = await safeGet(`${NEON_API}/projects`, token);
  if (status === 0) {
    return { ok: false, detail: `Network error: ${body}` };
  }
  if (status === 401 || status === 403) {
    return { ok: false, detail: `${status} \u2014 invalid or expired API key` };
  }
  if (!ok) {
    return { ok: false, detail: `Unexpected ${status} from Neon API` };
  }
  const projectCount = body.projects?.length ?? 0;
  return {
    ok: true,
    detail: `Authenticated \u2014 ${projectCount} project(s) visible`,
    scopes: ["list-projects"]
  };
}
async function autoProvision(creds, ctx) {
  const token = creds["NEON_API_KEY"];
  if (!token) throw new Error("NEON_API_KEY is required for autoProvision");
  const projectName = ctx.repoName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  ctx.log(`Creating Neon project "${projectName}"\u2026`);
  const { ok: projOk, status: projStatus, body: projBody } = await safePost(
    `${NEON_API}/projects`,
    token,
    { project: { name: projectName } }
  );
  if (!projOk) {
    throw new Error(
      `Failed to create Neon project (${projStatus}): ${JSON.stringify(projBody)}`
    );
  }
  const proj = projBody;
  const projectId = proj.project.id;
  const connectionUri = proj.connection_uris?.[0]?.connection_uri;
  if (!connectionUri) {
    throw new Error("Neon returned no connection_uri for the new project");
  }
  const appRole = `${projectName.replace(/-/g, "_")}_app`;
  ctx.log(`Creating app role "${appRole}" (non-superuser, RLS-safe)\u2026`);
  const branchId = projBody.branch?.id;
  const branchSegment = branchId ? `/branches/${branchId}` : "";
  const roleUrl = `${NEON_API}/projects/${projectId}${branchSegment}/roles`;
  const { ok: roleOk, status: roleStatus, body: roleBody } = await safePost(
    roleUrl,
    token,
    { role: { name: appRole } }
  );
  if (!roleOk) {
    ctx.log(
      `Warning: could not create app role (${roleStatus}): ${JSON.stringify(roleBody)}`
    );
  } else {
    ctx.log(`Role "${appRole}" created.`);
  }
  ctx.log("Done \u2014 DATABASE_URL ready.");
  return { DATABASE_URL: connectionUri };
}
var recipe = {
  id: "neon",
  title: "Neon",
  mode: "auto",
  envVars: ["DATABASE_URL"],
  rootCredKeys: ["NEON_API_KEY"],
  tokenCreateUrl: "https://console.neon.tech/app/settings/api-keys",
  docsUrl: "https://neon.tech/docs/manage/api-keys",
  requiredScopes: ["Full access (project create, read, role manage)"],
  validate,
  autoProvision
};

// src/recipes/cloudflare.ts
var CF_BASE = "https://api.cloudflare.com/client/v4";
var REQUIRED_SCOPES = [
  "Account>Cloudflare Pages:Edit",
  "Account>Workers Scripts:Edit",
  "Account>Workers KV Storage:Edit",
  "Account>Workers R2 Storage:Edit",
  "Zone>DNS:Edit",
  "Account>Account Settings:Read"
];
async function cfGet(path, token) {
  try {
    const res = await fetch(`${CF_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = await res.json();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { error: String(err) } };
  }
}
var recipe2 = {
  id: "cloudflare",
  title: "Cloudflare",
  mode: "guided",
  envVars: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  tokenCreateUrl: "https://dash.cloudflare.com/profile/api-tokens",
  docsUrl: "https://developers.cloudflare.com/fundamentals/api/get-started/create-token/",
  requiredScopes: REQUIRED_SCOPES,
  // API token is root — reused across repos; ACCOUNT_ID is per-repo (derived at provision time)
  rootCredKeys: ["CLOUDFLARE_API_TOKEN"],
  async validate(creds) {
    const token = creds["CLOUDFLARE_API_TOKEN"];
    if (!token) {
      return { ok: false, detail: "CLOUDFLARE_API_TOKEN is missing" };
    }
    const verify = await cfGet("/user/tokens/verify", token);
    if (!verify.ok) {
      const status = verify.status;
      const msg = status === 401 || status === 403 ? `${status} invalid or revoked token` : status === 0 ? "network error \u2014 could not reach api.cloudflare.com" : `unexpected ${status}`;
      return { ok: false, detail: msg };
    }
    const verifyData = verify.body;
    if (verifyData?.result?.status !== "active") {
      return {
        ok: false,
        detail: `token status is '${verifyData?.result?.status ?? "unknown"}' (expected 'active')`
      };
    }
    const accounts = await cfGet("/accounts?per_page=50", token);
    if (!accounts.ok) {
      return {
        ok: false,
        detail: `token is active but cannot list accounts (${accounts.status}) \u2014 check Account Settings:Read scope`
      };
    }
    const accountsData = accounts.body;
    const accountList = accountsData?.result ?? [];
    const suppliedAccountId = creds["CLOUDFLARE_ACCOUNT_ID"];
    let matchedAccount = suppliedAccountId ? accountList.find((a) => a.id === suppliedAccountId) : accountList[0];
    if (suppliedAccountId && !matchedAccount) {
      return {
        ok: false,
        detail: `CLOUDFLARE_ACCOUNT_ID '${suppliedAccountId}' not found in accessible accounts`,
        scopes: [],
        missing: []
      };
    }
    const accountSummary = matchedAccount ? `account '${matchedAccount.name}' (${matchedAccount.id})` : `${accountList.length} account(s) accessible`;
    return {
      ok: true,
      detail: `authenticated \u2014 token active, ${accountSummary}`,
      scopes: ["token:active", "accounts:readable"],
      missing: []
    };
  },
  async autoProvision(creds, ctx) {
    const token = creds["CLOUDFLARE_API_TOKEN"];
    if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
    let accountId = creds["CLOUDFLARE_ACCOUNT_ID"];
    if (!accountId) {
      ctx.log("Resolving Cloudflare account id\u2026");
      const accounts = await cfGet("/accounts?per_page=1", token);
      if (!accounts.ok) {
        throw new Error(
          `Cannot list accounts (${accounts.status}). Check Account Settings:Read scope.`
        );
      }
      const data = accounts.body;
      const first = data?.result?.[0];
      if (!first) throw new Error("No Cloudflare accounts found for this token");
      accountId = first.id;
      ctx.log(`Using account '${first.name}' (${accountId})`);
    }
    const projectName = ctx.repoName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 58);
    ctx.log(`Creating Pages project '${projectName}'\u2026`);
    let res;
    try {
      const raw = await fetch(
        `${CF_BASE}/accounts/${accountId}/pages/projects`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name: projectName,
            production_branch: "main"
          })
        }
      );
      const body = await raw.json();
      res = { ok: raw.ok, status: raw.status, body };
    } catch (err) {
      throw new Error(`Network error creating Pages project: ${String(err)}`);
    }
    if (!res.ok) {
      const errBody = res.body;
      const cfErrors = errBody?.errors ?? [];
      const alreadyExists = cfErrors.some((e) => e.code === 8e6);
      if (alreadyExists) {
        ctx.log(
          `Pages project '${projectName}' already exists \u2014 reusing it.`
        );
      } else {
        const msg = cfErrors.map((e) => e.message).join("; ") || res.status.toString();
        throw new Error(`Failed to create Pages project: ${msg}`);
      }
    } else {
      ctx.log(`Pages project '${projectName}' created.`);
    }
    return {
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_PAGES_PROJECT_NAME: projectName
    };
  }
};

// src/recipes/creem.ts
var CREEM_API_BASE = "https://api.creem.io";
var KEY_PREFIXES = ["creem_live_", "creem_test_", "creem_"];
var recipe3 = {
  id: "creem",
  title: "Creem",
  mode: "guided",
  envVars: ["CREEM_API_KEY", "CREEM_WEBHOOK_SECRET"],
  tokenCreateUrl: "https://dashboard.creem.io/settings/api-keys",
  docsUrl: "https://docs.creem.io",
  requiredScopes: ["Read products / customers (minimum read scope)"],
  rootCredKeys: ["CREEM_API_KEY"],
  async validate(creds) {
    const apiKey = creds["CREEM_API_KEY"] ?? "";
    const webhookSecret = creds["CREEM_WEBHOOK_SECRET"] ?? "";
    if (!apiKey) {
      return { ok: false, detail: "CREEM_API_KEY is missing." };
    }
    if (!webhookSecret) {
      return { ok: false, detail: "CREEM_WEBHOOK_SECRET is missing." };
    }
    let res;
    try {
      res = await fetch(`${CREEM_API_BASE}/v1/products?limit=1`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        }
      });
    } catch (err) {
      const hasKnownPrefix2 = KEY_PREFIXES.some((p) => apiKey.startsWith(p));
      return {
        ok: false,
        detail: `Network error reaching Creem API (${String(err)}). Key format check: ${hasKnownPrefix2 ? "prefix looks valid" : "unrecognised prefix \u2014 double-check your key"}. CREEM_WEBHOOK_SECRET present.`
      };
    }
    if (res.ok) {
      return {
        ok: true,
        detail: `Authenticated \u2014 GET /v1/products returned ${res.status}. CREEM_WEBHOOK_SECRET present.`,
        scopes: ["products:read"]
      };
    }
    if (res.status === 401 || res.status === 403) {
      let body = "";
      try {
        body = await res.text();
      } catch {
      }
      return {
        ok: false,
        detail: `Creem API returned ${res.status} \u2014 invalid or revoked key. ${body ? `Response: ${body.slice(0, 200)}` : ""}`.trim()
      };
    }
    const hasKnownPrefix = KEY_PREFIXES.some((p) => apiKey.startsWith(p));
    return {
      ok: false,
      // ponytail: honest degradation — no safe GET endpoint confirmed; format check only
      detail: `Creem API returned unexpected status ${res.status} on GET /v1/products. Falling back to key-format check: ${hasKnownPrefix ? "prefix looks valid \u2014 key may work despite failed probe" : "unrecognised key prefix \u2014 verify your key"}. CREEM_WEBHOOK_SECRET present.`
    };
  }
};

// src/recipes/godaddy.ts
var API = "https://api.godaddy.com";
function authHeader(key, secret) {
  return `sso-key ${key}:${secret}`;
}
var recipe4 = {
  id: "godaddy",
  title: "GoDaddy (registrar / DNS)",
  mode: "guided",
  envVars: ["GODADDY_API_KEY", "GODADDY_API_SECRET"],
  rootCredKeys: ["GODADDY_API_KEY", "GODADDY_API_SECRET"],
  tokenCreateUrl: "https://developer.godaddy.com/keys",
  docsUrl: "https://developer.godaddy.com/doc/endpoint/domains",
  requiredScopes: [
    // GoDaddy OTE keys are sandbox-only — user must explicitly create a PRODUCTION key
    "Production key (not OTE/sandbox) with Domains: Read & Write access"
  ],
  async validate(creds) {
    const key = creds["GODADDY_API_KEY"] ?? "";
    const secret = creds["GODADDY_API_SECRET"] ?? "";
    if (!key || !secret) {
      return { ok: false, detail: "GODADDY_API_KEY and GODADDY_API_SECRET are both required" };
    }
    let res;
    try {
      res = await fetch(`${API}/v1/domains?limit=1`, {
        headers: { Authorization: authHeader(key, secret) }
      });
    } catch (err) {
      return { ok: false, detail: `Network error: ${String(err)}` };
    }
    if (res.ok) {
      let domains = [];
      try {
        domains = await res.json();
      } catch {
      }
      return {
        ok: true,
        detail: `Authenticated \u2014 ${domains.length} domain(s) visible (production key confirmed)`,
        scopes: ["domains:read"]
      };
    }
    if (res.status === 401 || res.status === 403) {
      let body = "";
      try {
        body = await res.text();
      } catch {
      }
      return {
        ok: false,
        detail: `${res.status} \u2014 invalid or OTE/sandbox key. Create a PRODUCTION key at https://developer.godaddy.com/keys. ${body}`.trim()
      };
    }
    return { ok: false, detail: `Unexpected ${res.status} from GoDaddy API` };
  },
  /**
   * Nameserver swap: updates ctx.domain's NS records to the supplied nameservers.
   * Nameservers are read from creds.CLOUDFLARE_NAMESERVERS (comma-separated),
   * since ProvisionCtx carries no nameserver field.
   */
  async autoProvision(creds, ctx) {
    const key = creds["GODADDY_API_KEY"] ?? "";
    const secret = creds["GODADDY_API_SECRET"] ?? "";
    const domain = ctx.domain ?? creds["GODADDY_DOMAIN"] ?? "";
    const rawNS = creds["CLOUDFLARE_NAMESERVERS"] ?? "";
    if (!domain) {
      throw new Error("autoProvision requires ctx.domain or creds.GODADDY_DOMAIN");
    }
    if (!rawNS) {
      throw new Error(
        "autoProvision requires creds.CLOUDFLARE_NAMESERVERS (comma-separated list of nameservers to install)"
      );
    }
    const nameServers = rawNS.split(",").map((ns) => ns.trim()).filter(Boolean);
    if (nameServers.length < 2) {
      throw new Error(`Expected at least 2 nameservers, got: ${nameServers.join(", ")}`);
    }
    ctx.log(`Updating nameservers for ${domain} \u2192 ${nameServers.join(", ")}`);
    let res;
    try {
      res = await fetch(`${API}/v1/domains/${encodeURIComponent(domain)}`, {
        method: "PATCH",
        headers: {
          Authorization: authHeader(key, secret),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ nameServers })
      });
    } catch (err) {
      throw new Error(`Network error updating nameservers: ${String(err)}`);
    }
    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {
      }
      throw new Error(`GoDaddy PATCH /v1/domains/${domain} failed ${res.status}: ${body}`);
    }
    ctx.log(`Nameservers updated successfully for ${domain}`);
    return {
      GODADDY_DOMAIN: domain,
      GODADDY_NAMESERVERS_SET: nameServers.join(",")
    };
  }
};

// src/recipes/infisical.ts
var recipe5 = {
  id: "infisical",
  title: "Infisical",
  mode: "guided",
  envVars: ["INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET"],
  tokenCreateUrl: "https://app.infisical.com",
  docsUrl: "https://infisical.com/docs/documentation/platform/identities/universal-auth",
  requiredScopes: [
    "Project \u2192 Access Control \u2192 Machine Identities \u2192 create a machine identity",
    "Assign the identity to the project with the required role (e.g. Member)",
    "Under the identity \u2192 Authentication \u2192 Universal Auth \u2192 add a Client Secret"
  ],
  rootCredKeys: ["INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET"],
  async validate(creds) {
    const clientId = creds["INFISICAL_CLIENT_ID"];
    const clientSecret = creds["INFISICAL_CLIENT_SECRET"];
    if (!clientId || !clientSecret) {
      return {
        ok: false,
        detail: "INFISICAL_CLIENT_ID and INFISICAL_CLIENT_SECRET are required"
      };
    }
    let res;
    try {
      res = await fetch(
        "https://app.infisical.com/api/v1/auth/universal-auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, clientSecret })
        }
      );
    } catch (err) {
      return {
        ok: false,
        detail: `Network error: ${err instanceof Error ? err.message : String(err)}`
      };
    }
    if (res.ok) {
      let tokenType = "Bearer";
      try {
        const body = await res.json();
        tokenType = body.tokenType ?? tokenType;
      } catch {
      }
      return {
        ok: true,
        detail: `Authenticated \u2014 received ${tokenType} access token`
      };
    }
    let errDetail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.message) errDetail += `: ${body.message}`;
    } catch {
    }
    return { ok: false, detail: errDetail };
  }
};

// src/recipes/posthog.ts
var recipe6 = {
  id: "posthog",
  title: "PostHog",
  mode: "guided",
  envVars: ["NEXT_PUBLIC_POSTHOG_KEY", "NEXT_PUBLIC_POSTHOG_HOST"],
  // The personal API key lives in the root store (shared across repos).
  // The project key and host are per-repo .env values.
  rootCredKeys: ["POSTHOG_PERSONAL_API_KEY"],
  tokenCreateUrl: "https://us.posthog.com/settings/user-api-keys",
  docsUrl: "https://posthog.com/docs/api",
  requiredScopes: [
    "Read project (to validate credentials via /api/projects/)"
  ],
  async validate(creds) {
    const personalKey = creds["POSTHOG_PERSONAL_API_KEY"];
    const projectKey = creds["NEXT_PUBLIC_POSTHOG_KEY"];
    if (!personalKey) {
      return { ok: false, detail: "POSTHOG_PERSONAL_API_KEY is required to validate" };
    }
    if (projectKey && !projectKey.startsWith("phc_")) {
      return {
        ok: false,
        detail: `NEXT_PUBLIC_POSTHOG_KEY looks wrong \u2014 PostHog project keys start with "phc_" (got: ${projectKey.slice(0, 8)}\u2026)`
      };
    }
    let res;
    try {
      res = await fetch("https://us.posthog.com/api/projects/", {
        headers: { Authorization: `Bearer ${personalKey}` }
      });
    } catch (err) {
      return { ok: false, detail: `Network error: ${err.message}` };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `${res.status} \u2014 personal API key rejected (invalid or expired)` };
    }
    if (!res.ok) {
      return { ok: false, detail: `Unexpected ${res.status} from PostHog /api/projects/` };
    }
    let body;
    try {
      body = await res.json();
    } catch {
      return { ok: false, detail: "PostHog returned non-JSON \u2014 unexpected response" };
    }
    const projects = body.results ?? [];
    const projectList = projects.map((p) => p.name).join(", ") || "(none)";
    const detail = `Authenticated. Accessible projects: ${projectList}`;
    return {
      ok: true,
      detail,
      scopes: ["read:projects"]
    };
  }
};

// src/recipes/resend.ts
var recipe7 = {
  id: "resend",
  title: "Resend",
  mode: "guided",
  envVars: ["RESEND_API_KEY"],
  tokenCreateUrl: "https://resend.com/api-keys",
  docsUrl: "https://resend.com/docs/introduction",
  requiredScopes: ["Full access (or at minimum Sending access)"],
  rootCredKeys: ["RESEND_API_KEY"],
  async validate(creds) {
    const key = creds["RESEND_API_KEY"] ?? "";
    if (!key.startsWith("re_")) {
      return {
        ok: false,
        detail: "RESEND_API_KEY must start with 're_' \u2014 format check failed (no network call made)."
      };
    }
    let res;
    try {
      res = await fetch("https://api.resend.com/domains", {
        headers: { Authorization: `Bearer ${key}` }
      });
    } catch (err) {
      return {
        ok: false,
        detail: `Network error reaching api.resend.com: ${err.message}`
      };
    }
    if (res.ok) {
      let domainCount = 0;
      try {
        const body = await res.json();
        domainCount = Array.isArray(body.data) ? body.data.length : 0;
      } catch {
      }
      return {
        ok: true,
        detail: `Authenticated. ${domainCount} domain(s) visible via /domains.`,
        scopes: ["full-access"]
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        detail: `HTTP ${res.status} on GET /domains \u2014 key may be send-only (no read scope) or invalid. Prefix 're_' is present. If you intend a send-only key, the app will work but this validation endpoint is inaccessible without Full Access.`,
        missing: ["full-access (read /domains)"]
      };
    }
    return {
      ok: false,
      detail: `Unexpected HTTP ${res.status} from api.resend.com/domains.`
    };
  }
};

// src/recipes/better-auth.ts
import { randomBytes } from "node:crypto";
var recipe8 = {
  id: "better-auth",
  title: "Better Auth",
  mode: "generate",
  envVars: ["BETTER_AUTH_SECRET"],
  docsUrl: "https://www.better-auth.com/docs/installation",
  generate() {
    return { BETTER_AUTH_SECRET: randomBytes(32).toString("base64url") };
  }
};

// src/recipes/index.ts
RECIPES.push(
  // auto
  recipe,
  // guided
  recipe2,
  recipe3,
  recipe4,
  recipe5,
  recipe6,
  recipe7,
  // generate
  recipe8
);

// src/env-file.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
var LINE = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/;
function parseEnvExample(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const [, commentedOut, key, rest] = m;
    out.push({
      key,
      comment: extractInlineComment(rest),
      optional: Boolean(commentedOut)
    });
  }
  return out;
}
function extractInlineComment(rest) {
  const quoted = /^\s*(['"]).*?\1\s+#\s?(.*)$/.exec(rest);
  if (quoted) return quoted[2].trim();
  const hash = rest.indexOf(" #");
  if (hash === -1) return void 0;
  return rest.slice(hash + 2).replace(/^#?\s*/, "").trim() || void 0;
}
function upsertEnvLocal(path, values) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.length ? existing.split("\n") : [];
  const written = [];
  const unchanged = [];
  const remaining = new Set(Object.keys(values));
  const next = lines.map((line) => {
    const m = LINE.exec(line);
    if (!m) return line;
    const key = m[2];
    if (!(key in values)) return line;
    remaining.delete(key);
    const desired = `${key}=${quoteIfNeeded(values[key])}`;
    if (line === desired) {
      unchanged.push(key);
      return line;
    }
    written.push(key);
    return desired;
  });
  const appended = [];
  for (const key of remaining) {
    appended.push(`${key}=${quoteIfNeeded(values[key])}`);
    written.push(key);
  }
  if (appended.length) {
    if (next.length && next[next.length - 1] !== "") next.push("");
    next.push("# added by @builders-stack/provision", ...appended);
  }
  writeFileSync(path, next.join("\n") + (next.at(-1) === "" ? "" : "\n"));
  return { written, unchanged };
}
function quoteIfNeeded(v) {
  return /[\s#'"]/.test(v) ? JSON.stringify(v) : v;
}

// src/config-store.ts
import { homedir } from "node:os";
import { join } from "node:path";
import {
  chmodSync,
  existsSync as existsSync2,
  mkdirSync,
  readFileSync as readFileSync2,
  writeFileSync as writeFileSync2
} from "node:fs";
function getConfigDir() {
  return process.env.BUILDERS_STACK_HOME || join(homedir(), ".builders-stack");
}
function credentialsPath() {
  return join(getConfigDir(), "credentials.json");
}
var EMPTY = { version: 1, providers: {} };
function read() {
  const path = credentialsPath();
  if (!existsSync2(path)) return { ...EMPTY, providers: {} };
  try {
    const parsed = JSON.parse(readFileSync2(path, "utf8"));
    return { version: 1, providers: parsed.providers ?? {} };
  } catch {
    return { ...EMPTY, providers: {} };
  }
}
function write(store) {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true, mode: 448 });
  const path = credentialsPath();
  writeFileSync2(path, JSON.stringify(store, null, 2) + "\n", { mode: 384 });
  chmodSync(path, 384);
}
function getProviderCreds(providerId) {
  return read().providers[providerId] ?? {};
}
function setProviderCreds(providerId, creds) {
  const store = read();
  store.providers[providerId] = { ...store.providers[providerId] ?? {}, ...creds };
  write(store);
}
function resolveRootCreds(providerId, rootCredKeys = []) {
  const creds = getProviderCreds(providerId);
  const haveAll = rootCredKeys.every((k) => Boolean(creds[k]));
  return haveAll ? creds : null;
}

// src/cli.ts
function parseFlags(argv) {
  const has = (f) => argv.includes(f);
  const val = (f) => {
    const i = argv.indexOf(f);
    return i !== -1 ? argv[i + 1] : void 0;
  };
  const cwd = val("--cwd") ?? process.cwd();
  const set = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--set" && argv[i + 1]) {
      const eq = argv[i + 1].indexOf("=");
      if (eq > 0) set[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1);
    }
  }
  return {
    json: has("--json") || has("--non-interactive"),
    provision: has("--provision"),
    help: has("--help") || has("-h"),
    cwd,
    envExample: val("--env-example") ?? join2(cwd, ".env.example"),
    envLocal: val("--env-local") ?? join2(cwd, ".env.local"),
    domain: val("--domain"),
    set
  };
}
function repoNameFromCwd(cwd) {
  return cwd.split("/").filter(Boolean).at(-1) ?? "app";
}
function selectRecipes(manifestKeys) {
  const keys = new Set(manifestKeys);
  const recipes = RECIPES.filter((r) => r.envVars.some((v) => keys.has(v)));
  const owned = new Set(recipes.flatMap((r) => r.envVars));
  const uncovered = manifestKeys.filter((k) => !owned.has(k));
  return { recipes, uncovered };
}
function keysToCollect(recipe9) {
  const extra = (recipe9.rootCredKeys ?? []).filter(
    (k) => !recipe9.envVars.includes(k)
  );
  return [...recipe9.envVars, ...extra];
}
async function runInteractive(flags) {
  intro(
    pc.inverse(pc.bold(" builders-stack ")) + " " + pc.dim("provision \u2014 keys in, cloud out")
  );
  const manifest = parseEnvExample(flags.envExample);
  if (manifest.length === 0) {
    cancel(
      `No .env.example found at ${flags.envExample} \u2014 run from a repo root or pass --cwd.`
    );
    process.exit(1);
  }
  const { recipes, uncovered } = selectRecipes(manifest.map((v) => v.key));
  log.step(
    `${pc.bold(String(recipes.length))} provider(s) needed by ${pc.cyan(
      repoNameFromCwd(flags.cwd)
    )} ` + pc.dim(`(${manifest.length} vars in .env.example)`)
  );
  if (recipes.length === 0) {
    outro(pc.yellow("No known providers for this repo. Nothing to do."));
    return;
  }
  const collected = {};
  const summary = [];
  for (const recipe9 of recipes) {
    log.step(`${pc.bold(recipe9.title)} ${pc.dim(`\xB7 ${recipe9.mode}`)}`);
    if (recipe9.mode === "generate") {
      const minted = recipe9.generate ? recipe9.generate() : {};
      for (const [k, v] of Object.entries(minted)) collected[k] = v;
      log.success(pc.green(`\u2713 generated ${recipe9.envVars.join(", ")}`));
      summary.push({ service: recipe9.title, status: "generated", where: ".env.local" });
      continue;
    }
    let creds = resolveRootCreds(recipe9.id, recipe9.rootCredKeys);
    let reused = false;
    if (creds) {
      const s = spinner();
      s.start(`Found ${recipe9.title} in ~/.builders-stack \u2014 re-validating\u2026`);
      const result = recipe9.validate ? await recipe9.validate(creds) : { ok: true };
      s.stop(formatValidate(recipe9, result));
      if (result.ok) {
        reused = true;
      } else {
        printScopeReport(recipe9, result);
        log.warn("Stored credential no longer valid \u2014 let's replace it.");
        creds = null;
      }
    }
    if (!creds) {
      creds = await acquireWithRetry(recipe9);
      if (!creds) {
        log.warn(`Skipped ${recipe9.title}.`);
        summary.push({ service: recipe9.title, status: "skipped", where: "\u2014" });
        continue;
      }
    }
    persistRootCreds(recipe9, creds);
    for (const key of recipe9.envVars) {
      if (creds[key] !== void 0) collected[key] = creds[key];
    }
    if (flags.provision && recipe9.mode === "auto" && recipe9.autoProvision) {
      const s = spinner();
      s.start(`Provisioning ${recipe9.title}\u2026`);
      try {
        const produced = await recipe9.autoProvision(creds, {
          repoName: repoNameFromCwd(flags.cwd),
          domain: flags.domain,
          log: (m) => s.message(m)
        });
        for (const [k, v] of Object.entries(produced)) collected[k] = v;
        s.stop(pc.green(`\u2713 provisioned ${recipe9.title}`));
        summary.push({
          service: recipe9.title,
          status: reused ? "reused \u2192 provisioned" : "provisioned",
          where: rootStore(recipe9)
        });
        continue;
      } catch (err) {
        s.stop(pc.red(`\u2717 ${recipe9.title} provisioning failed`));
        log.error(err instanceof Error ? err.message : String(err));
        summary.push({ service: recipe9.title, status: "provision failed", where: rootStore(recipe9) });
        continue;
      }
    }
    summary.push({
      service: recipe9.title,
      status: reused ? "reused \u2713" : "validated \u2713",
      where: rootStore(recipe9)
    });
  }
  const { written, unchanged } = upsertEnvLocal(flags.envLocal, collected);
  log.success(
    `Wrote ${pc.bold(String(written.length))} var(s) to ${pc.dim(flags.envLocal)}` + (unchanged.length ? pc.dim(` (${unchanged.length} unchanged)`) : "")
  );
  note(renderSummary(summary), "Summary");
  if (uncovered.length) {
    note(
      uncovered.map((k) => `  ${pc.yellow("\xB7")} ${k}`).join("\n"),
      "Set these by hand (no provider covers them)"
    );
  }
  const next = [];
  if (!flags.provision && recipes.some((r) => r.mode === "auto" && r.autoProvision)) {
    next.push(`Re-run with ${pc.cyan("--provision")} to auto-create cloud resources (Neon DB, etc.).`);
  }
  next.push(`Boot the stack: ${pc.cyan("./tilt_up.sh")}`);
  outro(pc.green("Done. ") + next.join(" "));
}
function rootStore(recipe9) {
  return recipe9.rootCredKeys?.length ? "~/.builders-stack + .env.local" : ".env.local";
}
function renderSummary(rows) {
  const w = (s, n) => s + " ".repeat(Math.max(0, n - stripAnsi(s).length));
  const colored = (status) => {
    if (/fail|✗/.test(status)) return pc.red(status);
    if (/skip/.test(status)) return pc.yellow(status);
    return pc.green(status);
  };
  const head = pc.dim(w("SERVICE", 20)) + pc.dim(w("STATUS", 24)) + pc.dim("STORED");
  const body = rows.map(
    (r) => w(r.service, 20) + w(colored(r.status), 24) + pc.dim(r.where)
  );
  return [head, ...body].join("\n");
}
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
async function acquireWithRetry(recipe9) {
  showGuidance(recipe9);
  for (; ; ) {
    const creds = await promptCreds(recipe9);
    if (!creds) return null;
    let result = { ok: true };
    if (recipe9.validate) {
      const s = spinner();
      s.start(`Validating ${recipe9.title}\u2026`);
      result = await recipe9.validate(creds);
      s.stop(formatValidate(recipe9, result));
    }
    if (result.ok) return creds;
    printScopeReport(recipe9, result);
    const choice = await select({
      message: `${recipe9.title} didn't validate. What now?`,
      options: [
        { value: "retry", label: "Retry \u2014 re-paste the credential" },
        { value: "open", label: `Open the token page (${recipe9.tokenCreateUrl ?? "docs"})` },
        { value: "skip", label: "Skip this provider" }
      ]
    });
    if (isCancel(choice)) {
      cancel("Cancelled.");
      process.exit(1);
    }
    if (choice === "skip") return null;
    if (choice === "open" && recipe9.tokenCreateUrl) openBrowser(recipe9.tokenCreateUrl);
  }
}
function showGuidance(recipe9) {
  const lines = [];
  if (recipe9.tokenCreateUrl) lines.push(`${pc.bold("Create a token:")} ${pc.underline(pc.cyan(recipe9.tokenCreateUrl))}`);
  if (recipe9.requiredScopes?.length) {
    lines.push("");
    lines.push(pc.bold("Tick these scopes:"));
    for (const s of recipe9.requiredScopes) lines.push(`  ${pc.cyan("\u25B8")} ${s}`);
  }
  if (recipe9.docsUrl) {
    lines.push("");
    lines.push(pc.dim(`Docs: ${recipe9.docsUrl}`));
  }
  if (lines.length) note(lines.join("\n"), recipe9.title);
}
async function promptCreds(recipe9) {
  const out = {};
  const keys = keysToCollect(recipe9);
  for (const key of keys) {
    const answer = await password({ message: key });
    if (isCancel(answer)) {
      cancel("Cancelled.");
      process.exit(1);
    }
    const v = (answer ?? "").trim();
    if (!v) {
      if (Object.keys(out).length === 0) return null;
      continue;
    }
    out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}
function printScopeReport(recipe9, r) {
  const lines = [];
  if (r.detail) lines.push(pc.dim(r.detail));
  for (const s of r.scopes ?? []) lines.push(pc.green(`  \u2713 ${s}`));
  for (const m of r.missing ?? []) lines.push(pc.red(`  \u2717 MISSING  ${m}`));
  if (lines.length) note(lines.join("\n"), `${recipe9.title} \u2014 scope report`);
}
function persistRootCreds(recipe9, creds) {
  if (!recipe9.rootCredKeys?.length) return;
  const subset = Object.fromEntries(
    recipe9.rootCredKeys.filter((k) => k in creds).map((k) => [k, creds[k]])
  );
  if (Object.keys(subset).length) setProviderCreds(recipe9.id, subset);
}
function formatValidate(recipe9, r) {
  if (r.ok) return pc.green(`\u2713 ${recipe9.title}${r.detail ? pc.dim(` \u2014 ${r.detail}`) : ""}`);
  const miss = r.missing?.length ? pc.red(` (missing: ${r.missing.join(", ")})`) : "";
  return pc.red(`\u2717 ${recipe9.title}${r.detail ? ` \u2014 ${r.detail}` : ""}`) + miss;
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  import("node:child_process").then(({ spawn }) => spawn(cmd, [url], { stdio: "ignore", detached: true }).unref()).catch(() => {
  });
}
async function runJson(flags) {
  const manifest = parseEnvExample(flags.envExample);
  const { recipes, uncovered } = selectRecipes(manifest.map((v) => v.key));
  const reports = [];
  const collected = {};
  for (const recipe9 of recipes) {
    const stored = resolveRootCreds(recipe9.id, recipe9.rootCredKeys) ?? {};
    const keys = keysToCollect(recipe9);
    const creds = { ...stored };
    let fromEnv = false;
    for (const key of keys) {
      const v = flags.set[key] ?? process.env[key];
      if (v) {
        creds[key] = v;
        fromEnv = true;
      }
    }
    const provided = keys.filter((k) => creds[k] !== void 0);
    const missing = keys.filter((k) => creds[k] === void 0);
    if (recipe9.mode === "generate") {
      const minted = recipe9.generate ? recipe9.generate() : {};
      for (const [k, v] of Object.entries(minted)) collected[k] = v;
      reports.push({
        id: recipe9.id,
        title: recipe9.title,
        mode: recipe9.mode,
        status: "generate",
        providedVars: Object.keys(minted),
        missingVars: [],
        source: "generated"
      });
      continue;
    }
    const source = Object.keys(stored).length && fromEnv ? "mixed" : Object.keys(stored).length ? "stored" : fromEnv ? "env" : "none";
    if (missing.length) {
      reports.push({
        id: recipe9.id,
        title: recipe9.title,
        mode: recipe9.mode,
        status: "needs-human",
        providedVars: provided,
        missingVars: missing,
        source,
        action: {
          tokenCreateUrl: recipe9.tokenCreateUrl,
          docsUrl: recipe9.docsUrl,
          requiredScopes: recipe9.requiredScopes
        }
      });
      continue;
    }
    let validate2;
    if (recipe9.validate) validate2 = await recipe9.validate(creds);
    const ok = validate2 ? validate2.ok : true;
    if (ok) {
      for (const key of recipe9.envVars) if (creds[key] !== void 0) collected[key] = creds[key];
    }
    reports.push({
      id: recipe9.id,
      title: recipe9.title,
      mode: recipe9.mode,
      status: ok ? source === "stored" ? "reused" : "valid" : "invalid",
      providedVars: provided,
      missingVars: [],
      source,
      validate: validate2,
      action: ok ? void 0 : { tokenCreateUrl: recipe9.tokenCreateUrl, docsUrl: recipe9.docsUrl, requiredScopes: recipe9.requiredScopes }
    });
  }
  const nextActions = reports.filter((r) => r.status === "needs-human" || r.status === "invalid").map((r) => ({
    service: r.title,
    why: r.status === "invalid" ? "credential present but failed validation" : `missing ${r.missingVars.join(", ")}`,
    open: r.action?.tokenCreateUrl ?? r.action?.docsUrl,
    scopes: r.action?.requiredScopes
  }));
  const plan = {
    repo: repoNameFromCwd(flags.cwd),
    envExample: flags.envExample,
    configDir: getConfigDir(),
    manifestVars: manifest.map((v) => v.key),
    uncoveredVars: uncovered,
    recipes: reports,
    resolvedVars: Object.keys(collected).sort(),
    ready: reports.every((r) => r.status !== "needs-human" && r.status !== "invalid" && r.status !== "provision-failed"),
    nextActions
  };
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
}
function printHelp() {
  const b = pc.bold;
  process.stdout.write(
    `
${pc.inverse(b(" builders-stack "))} ${pc.dim("provision")}

Acquire, validate, and store the API keys a builders-stack repo needs, then
optionally auto-provision the cloud resources. Root creds live in ${pc.cyan("~/.builders-stack")}
(reused across repos, like ~/.aws) \u2014 per-repo values go to ${pc.cyan(".env.local")}.

${b("USAGE")}
  bsp [options]
  npx @builders-stack/provision [options]

${b("OPTIONS")}
  ${pc.cyan("--provision")}          After validating, auto-create cloud resources (Neon DB, DNS\u2026).
  ${pc.cyan("--json")}               Non-interactive: emit a JSON plan (agent mode). No prompts.
  ${pc.cyan("--non-interactive")}    Alias for --json.
  ${pc.cyan("--set KEY=VALUE")}      Feed a credential to --json mode (repeatable).
  ${pc.cyan("--cwd <dir>")}          Repo root (default: current dir).
  ${pc.cyan("--env-example <path>")} Manifest file (default: <cwd>/.env.example).
  ${pc.cyan("--env-local <path>")}   Output file (default: <cwd>/.env.local).
  ${pc.cyan("--domain <domain>")}    Custom domain, for DNS-provisioning providers.
  ${pc.cyan("-h, --help")}           This help.

${b("EXAMPLES")}
  ${pc.dim("# Interactive setup of the current repo")}
  bsp
  ${pc.dim("# Let an agent see what's still missing")}
  bsp --json
  ${pc.dim("# Set up + create the Neon database in one shot")}
  bsp --provision
`
  );
}
async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }
  if (flags.json) {
    await runJson(flags);
    return;
  }
  await runInteractive(flags);
}
main().catch((err) => {
  console.error(pc.red("provision failed:"), err instanceof Error ? err.message : err);
  process.exit(1);
});
