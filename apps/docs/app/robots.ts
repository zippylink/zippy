import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

// Native Next.js robots convention — emitted as /robots.txt at build (works under
// `output: 'export'`). Self-hosters: set NEXT_PUBLIC_SITE_URL to your docs domain.
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
