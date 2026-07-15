# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
(the repo's **Security → Report a vulnerability** tab), not a public issue. We'll
acknowledge within a few days and keep you posted on the fix.

## Security posture

- **Write auth.** `POST /api/links` and `GET /api/links/:slug` require a bearer
  token (`API_TOKEN`, a `wrangler secret`) compared in constant time. With no
  token configured, writes are **closed** (`401`), never open.
- **Input validation.** Destination URLs must be `http(s)`; custom slugs must
  match `[a-zA-Z0-9-_]{1,32}`. Random slugs come from `crypto.getRandomValues`.
- **Open redirect — by design, bounded.** A URL shortener is an intentional
  redirector, so only holders of the write token can create destinations; there is
  no public "shorten any URL" surface in the OSS core. Don't expose `/api/links`
  without a strong token.
- **Interstitial HTML** escapes interpolated values and JSON-encodes the scheme /
  intent / fallback URLs it emits.

## Supported versions

This is pre-1.0; security fixes land on `main`. Pin a commit if you deploy from a
fork.
