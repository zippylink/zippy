import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { ZippyBolt } from "./zippy-bolt";

// Shared nav config (title, links) for the docs + home layouts.
export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <>
        <ZippyBolt size={20} />
        <span style={{ fontFamily: "var(--font-display)", letterSpacing: "0.01em" }}>ZIPPY</span>
      </>
    ),
  },
  links: [
    { text: "docs", url: "/docs", active: "nested-url" },
    { text: "github", url: "https://github.com/zippy-org/zippy" },
  ],
};
