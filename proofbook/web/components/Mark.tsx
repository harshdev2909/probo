/**
 * The ProofBook mark. Original geometry, built from the identity's only two
 * primitives: the square (the ledger cell. rigid, cryptographic) and the
 * quarter-circle (the ball's arc. fluid, live). Four cells:
 *   ▪ ledger square   ◔ arc     . the ball leaving the book
 *   ◔ arc (rotated)   ▪ brass square. the proof, sealed
 * No FIFA assets, no flags, no borrowed anything.
 */
export function Mark({ size = 28, className = "" }: { size?: number; className?: string }) {
  const s = size;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      {/* top-left: ledger square */}
      <rect x="1" y="1" width="14" height="14" fill="var(--ink-100)" />
      {/* top-right: quarter-circle opening out (ball arc) */}
      <path d="M17 1 h14 v14 a14 14 0 0 1 -14 -14 z" fill="var(--ink-100)" opacity="0.4" />
      {/* bottom-left: quarter-circle closing in */}
      <path d="M15 31 h-14 v-14 a14 14 0 0 1 14 14 z" fill="var(--ink-100)" opacity="0.4" />
      {/* bottom-right: the sealed proof. the only brass cell */}
      <rect x="17" y="17" width="14" height="14" fill="var(--brass-500)" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <Mark size={22} />
      <span className="display text-[15px] tracking-[0.04em] text-ink-100">
        Pro<span className="text-brass-400">bo</span>
      </span>
    </span>
  );
}
