import { docs, meta } from "@/.source/server";
import { loader } from "fumadocs-core/source";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";

// The content source the layout + pages read. Docs are served under /docs.
export const source = loader({
  baseUrl: "/docs",
  source: toFumadocsSource(docs, meta),
});
