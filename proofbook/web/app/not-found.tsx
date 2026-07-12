import Link from "next/link";

/** The designed 404. the zero is a quarter-circle, obviously. */
export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col items-start gap-8 px-6 pt-28 lg:px-10">
      <div className="flex items-end gap-2" aria-hidden>
        <span className="display text-[120px] leading-none text-ink-100">4</span>
        <svg width="96" height="96" viewBox="0 0 96 96" className="mb-2">
          <path d="M8 88 v-80 a80 80 0 0 1 80 80 z" fill="none" stroke="var(--brass-500)" strokeWidth="6" />
        </svg>
        <span className="display text-[120px] leading-none text-ink-100">4</span>
      </div>
      <div>
        <h1 className="display-condensed text-[24px] text-ink-100">Offside.</h1>
        <p className="mt-2 max-w-sm text-[14px] leading-relaxed text-ink-400">
          This page is behind the last defender. Everything provable lives on the board.
        </p>
      </div>
      <Link
        href="/matches"
        className="display-condensed bg-ink-100 px-6 py-3 text-[15px] text-ink-950 transition-colors duration-150 ease-snap hover:bg-ink-200"
        style={{ borderRadius: "0 0 0 14px" }}
      >
        Back to the matches
      </Link>
    </main>
  );
}
