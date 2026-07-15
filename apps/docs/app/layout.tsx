import "./global.css";
import { RootProvider } from "fumadocs-ui/provider";
import { Bungee, Outfit, Space_Mono } from "next/font/google";
import type { ReactNode } from "react";

// Zippy brand type: Bungee (display), Outfit (body), Space Mono (labels/code).
// next/font self-hosts these at build time — works under `output: 'export'`.
const bungee = Bungee({ weight: "400", subsets: ["latin"], variable: "--font-display" });
const outfit = Outfit({ subsets: ["latin"], variable: "--font-body" });
const spaceMono = Space_Mono({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata = {
  title: { default: "Zippy — docs", template: "%s · Zippy ⚡" },
  description:
    "self-host docs for Zippy — the open-source URL shortener whose links open the native app instead of an in-app browser.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="light"
      className={`${bungee.variable} ${outfit.variable} ${spaceMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        {/* Light only (`forcedTheme`) — the 80s brand is a light system. `search.type:
            'static'` points the dialog at the build-time Orama index (app/api/search). */}
        <RootProvider
          theme={{ enabled: false, forcedTheme: "light" }}
          search={{ options: { type: "static" } }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
