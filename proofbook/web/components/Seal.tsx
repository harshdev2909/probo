"use client";

/**
 * The proof seal. the brass accent's only hero moment. A circular notary
 * seal built from the mark's quarter-circle geometry with ring text.
 * `state="verified"` engraves it in (seal-in keyframe) and fills the core.
 */
export function Seal({
  size = 120,
  state = "idle",
  className = "",
}: {
  size?: number;
  state?: "idle" | "verifying" | "verified";
  className?: string;
}) {
  const gold = state === "verified";
  const stroke = gold ? "var(--brass-400)" : "var(--ink-500)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      role="img"
      aria-label={gold ? "Proof verified on-chain" : "Proof seal"}
      className={`${gold ? "seal-in" : ""} ${className}`}
    >
      <defs>
        <path id="seal-ring" d="M60 14 a46 46 0 1 1 -0.01 0" />
      </defs>

      {/* outer ring */}
      <circle cx="60" cy="60" r="57" stroke={stroke} strokeWidth="1.5" />
      <circle cx="60" cy="60" r="46" stroke={stroke} strokeWidth="0.75" opacity="0.5" />

      {/* ring text */}
      <text
        fontSize="8.2"
        letterSpacing="2.8"
        fill={gold ? "var(--brass-400)" : "var(--ink-400)"}
        fontFamily="var(--font-plex-mono)"
      >
        <textPath href="#seal-ring" startOffset="0%">
          PROVEN · NOT TRUSTED · PROBO · SETTLED ON-CHAIN ·
        </textPath>
      </text>

      {/* core: the mark's four cells, engraved */}
      <g transform="translate(41,41) scale(1.19)">
        <rect x="0" y="0" width="15" height="15" fill={gold ? "var(--brass-950)" : "transparent"} stroke={stroke} strokeWidth="1" />
        <path d="M17 0 h15 v15 a15 15 0 0 1 -15 -15 z" stroke={stroke} strokeWidth="1" fill="none" />
        <path d="M15 32 h-15 v-15 a15 15 0 0 1 15 15 z" stroke={stroke} strokeWidth="1" fill="none" />
        <rect x="17" y="17" width="15" height="15" fill={gold ? "var(--brass-500)" : "transparent"} stroke={stroke} strokeWidth="1" />
      </g>

      {state === "verifying" && (
        <circle cx="60" cy="60" r="52" stroke="var(--brass-500)" strokeWidth="1.5" strokeDasharray="10 316" strokeLinecap="round">
          <animateTransform attributeName="transform" type="rotate" from="0 60 60" to="360 60 60" dur="1.6s" repeatCount="indefinite" />
        </circle>
      )}
    </svg>
  );
}
