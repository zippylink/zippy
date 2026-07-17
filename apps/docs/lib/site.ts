// The canonical origin for this docs deployment. Defaults to the hosted docs site;
// self-hosters override with NEXT_PUBLIC_SITE_URL (no trailing slash).
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://docs.zipthe.link").replace(
  /\/$/,
  "",
);
