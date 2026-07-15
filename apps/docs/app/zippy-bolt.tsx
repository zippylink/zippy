// Code-drawn Zippy — the same geometry the redirect Worker inlines
// (services/redirect/src/interstitial.ts). Kept as hand-built SVG per brand.md §10
// (the logo is code, never AI/raster). Used for the docs nav logo + the 404.
const BOLT = "64,20 150,20 108,120 150,120 86,262 104,150 64,150";

export function ZippyBolt({ size = 28, sad = false }: { size?: number; sad?: boolean }) {
  const eyeY = sad ? 66 : 60;
  return (
    <svg
      viewBox="0 0 200 280"
      width={size}
      height={(size * 280) / 200}
      aria-hidden
      style={{ display: "block", overflow: "visible" }}
    >
      <polygon points={BOLT} fill="#C7D400" transform="translate(8,7)" />
      <polygon
        points={BOLT}
        fill="#EEFF00"
        stroke="#1A1033"
        strokeWidth={9}
        strokeLinejoin="round"
      />
      {sad && (
        <>
          <path
            d="M80,52 l14,4"
            stroke="#1A1033"
            strokeWidth={4}
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M124,50 l-14,4"
            stroke="#1A1033"
            strokeWidth={4}
            strokeLinecap="round"
            fill="none"
          />
        </>
      )}
      <circle cx={90} cy={eyeY} r={7} fill="#1A1033" />
      <circle cx={118} cy={eyeY - 3} r={7} fill="#1A1033" />
      <path
        d={sad ? "M84,94 Q100,82 116,94" : "M84,80 Q100,94 116,80"}
        fill="none"
        stroke="#1A1033"
        strokeWidth={5}
        strokeLinecap="round"
      />
      <path
        d="M30,58 l-11,13 8,1 -9,12"
        fill="none"
        stroke="#FF3E8A"
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M172,50 l11,13 -8,1 9,12"
        fill="none"
        stroke="#22D8FF"
        strokeWidth={6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
