import Link from "next/link";
import { ZippyBolt } from "./zippy-bolt";

// Docs 404 — mirrors the redirect Worker's sad bolt (droopy brows + frown).
export default function NotFound() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1rem",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      <ZippyBolt size={110} sad />
      <h1
        style={{
          fontFamily: "var(--font-display), sans-serif",
          fontSize: "clamp(2.5rem, 8vw, 4rem)",
          margin: 0,
          lineHeight: 1,
        }}
      >
        404
      </h1>
      <p style={{ color: "var(--color-fd-muted-foreground)", margin: 0 }}>
        This page doesn&apos;t live here.
      </p>
      <Link href="/" className="zippy-cta">
        back to Zippy →
      </Link>
    </main>
  );
}
