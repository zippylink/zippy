import type { MetadataRoute } from "next";

import { source } from "@/lib/source";
import { SITE_URL } from "@/lib/site";

// Native Next.js sitemap convention — emitted as /sitemap.xml at build (works under
// `output: 'export'`). Enumerates the home page plus every fumadocs page from the
// same source the site renders, so it can never drift from the real routes.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const docs = source.getPages().map((page) => ({
    url: `${SITE_URL}${page.url}`,
    changeFrequency: "weekly" as const,
    priority: 0.7,
  }));

  return [{ url: SITE_URL, changeFrequency: "weekly", priority: 1 }, ...docs];
}
