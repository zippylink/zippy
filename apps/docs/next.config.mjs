import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Pure-content docs → full static export. No Node server, no per-route edge runtime.
  // `deploy.sh docs` just uploads `out/` to Cloudflare Pages.
  output: "export",
};

export default withMDX(config);
