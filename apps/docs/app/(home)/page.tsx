import Link from "next/link";

// Minimal landing — Zippy 80s. Sends people straight into the docs.
export default function HomePage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1.25rem",
        textAlign: "center",
        padding: "2rem",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static export, no loader */}
      <img
        src="/zippy-avatar.png"
        alt="Zippy, the lightning-bolt mascot"
        width={180}
        height={180}
        style={{ width: "clamp(140px, 34vw, 200px)", height: "auto" }}
      />
      <p data-eyebrow>self-host docs</p>
      <h1
        style={{
          fontFamily: "var(--font-display), sans-serif",
          fontSize: "clamp(2.5rem, 8vw, 4rem)",
          margin: 0,
          lineHeight: 1.05,
        }}
      >
        ZIPPY <span aria-hidden>⚡</span>
      </h1>
      <p style={{ maxWidth: 540, color: "var(--color-fd-muted-foreground)", margin: 0 }}>
        the open-source URL shortener whose links open the <strong>native app</strong> — LinkedIn,
        Instagram, WhatsApp, TikTok, X and more — instead of a walled-in in-app browser. one
        Cloudflare Worker, KV-backed, ~$0 to run.
      </p>
      <Link href="/docs" className="zippy-cta">
        read the docs →
      </Link>
    </main>
  );
}
