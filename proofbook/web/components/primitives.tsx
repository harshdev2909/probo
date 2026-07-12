/**
 * Small shared primitives, all derived from the square/quarter-circle grid.
 */

const NATION_CHIP: Record<string, string> = {
  CAN: "var(--chip-can)",
  MEX: "var(--chip-mex)",
  USA: "var(--chip-usa)",
};

/** Nation = 3-letter code + a color chip. Never a flag asset. */
export function TeamChip({ code, name }: { code: string; name?: string }) {
  const chip = NATION_CHIP[code] ?? "var(--ink-500)";
  return (
    <span className="inline-flex items-center gap-2" title={name ?? code}>
      <span
        aria-hidden
        className="inline-block h-3 w-3 rounded-[2px]"
        style={{ background: chip, borderRadius: "0 0 0 6px" }}
      />
      <span className="display-condensed text-[15px] text-ink-100">{code}</span>
    </span>
  );
}

/** Loading: four grid cells taking turns being the quarter-circle. */
export function QuarterLoader({ size = 28, label = "Loading" }: { size?: number; label?: string }) {
  const cell = (size - 4) / 2;
  const delays = ["0ms", "150ms", "300ms", "450ms"];
  return (
    <span
      role="status"
      aria-label={label}
      className="inline-grid grid-cols-2 gap-1"
      style={{ width: size, height: size }}
    >
      {delays.map((d, i) => (
        <span
          key={i}
          className="bg-ink-500"
          style={{
            width: cell,
            height: cell,
            animation: `quarter-turn 1.2s var(--ease-carry) ${d} infinite`,
          }}
        />
      ))}
    </span>
  );
}

/** Empty state: a hollow grid cell + micro-copy with a voice. */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden>
        <rect x="1" y="1" width="18" height="18" stroke="var(--ink-700)" fill="none" />
        <path d="M21 39 v-18 a18 18 0 0 1 18 18 z" stroke="var(--ink-700)" fill="none" />
      </svg>
      <div>
        <p className="display-condensed text-[16px] text-ink-300">{title}</p>
        {hint && <p className="mt-1.5 text-[13px] text-ink-400">{hint}</p>}
      </div>
    </div>
  );
}

/** Error state: oxide, honest, with a recovery action. */
export function ErrorState({ title, retry }: { title: string; retry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden>
        <rect x="1" y="1" width="18" height="18" stroke="var(--oxide-500)" fill="none" />
        <path d="M21 1 h18 v18 a18 18 0 0 1 -18 -18 z" fill="var(--oxide-950)" stroke="var(--oxide-500)" />
      </svg>
      <div>
        <p className="display-condensed text-[16px] text-oxide-400">{title}</p>
        {retry && (
          <button
            onClick={retry}
            className="label mt-3 border border-hairline-strong px-4 py-2.5 text-ink-200 transition-colors duration-150 ease-snap hover:border-ink-500 focus-visible:outline-2"
            style={{ borderRadius: "0 0 0 12px" }}
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

/** Truncated hash/signature with mono styling. */
export function Hash({ value, head = 8, tail = 8 }: { value: string; head?: number; tail?: number }) {
  const short = value.length > head + tail + 3 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
  return (
    <span className="font-mono text-[12.5px] tracking-tight text-ink-300" title={value}>
      {short}
    </span>
  );
}
