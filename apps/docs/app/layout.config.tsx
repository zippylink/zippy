import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

// Shared nav config (title, links) for the docs + home layouts.
export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <>
        <span aria-hidden style={{ fontSize: "1.15em" }}>
          ⚡
        </span>
        <span style={{ fontFamily: "var(--font-display)", letterSpacing: "0.01em" }}>ZIPPY</span>
      </>
    ),
  },
  links: [
    { text: "docs", url: "/docs", active: "nested-url" },
    { text: "github", url: "https://github.com/zippy-org/zippy" },
  ],
};
