import Link from "next/link";
import { Mark } from "./Mark";

/**
 * The site footer — the match programme's back page. An editorial link grid,
 * one dry meta row, and the wordmark set flush to the bottom edge at full
 * bleed, closed by the mark's brass square: the sealed proof as a full stop.
 *
 * The giant PROBO is SVG, not styled text. `textLength` pins the word to the
 * viewBox width exactly, so it meets both screen edges at every viewport —
 * a vw font-size only ever approximates that. Decorative, so aria-hidden;
 * the meta row carries the name for readers.
 */

const COLUMNS: [string, [string, string][]][] = [
  [
    "Play",
    [
      ["/matches", "Matches"],
      ["/bracket", "Bracket"],
      ["/standings", "Groups"],
      ["/portfolio", "Portfolio"],
    ],
  ],
  [
    "Proof",
    [
      ["/receipts", "Receipts"],
      ["/verify", "Verify a receipt"],
      ["/docs", "Docs"],
    ],
  ],
  [
    "Wire",
    [
      ["/keeper", "Keeper"],
      ["/status", "Status"],
    ],
  ],
];

export function Footer() {
  return (
    <footer className="rule mt-24">
      <div className="mx-auto w-full max-w-6xl px-6 pt-14 lg:px-10">
        {/* the whistle */}
        <p className="label !text-[10px] text-ink-500">Full time</p>

        <div className="mt-8 grid grid-cols-2 gap-x-8 gap-y-12 md:grid-cols-12">
          {/* the closing argument */}
          <div className="col-span-2 md:col-span-6">
            <Mark size={28} />
            <p className="display mt-6 text-[clamp(24px,3vw,34px)] text-ink-100">
              Proven,
              <br />
              <span className="text-ink-500">not trusted.</span>
            </p>
            <p className="mt-5 max-w-sm text-[13px] leading-relaxed text-ink-400">
              Every result verified cryptographically, every payout receipted
              on-chain. The keeper runs itself. The proof is yours to check.
            </p>
          </div>

          {COLUMNS.map(([heading, links]) => (
            <nav key={heading} className="md:col-span-2" aria-label={heading}>
              <p className="label !text-[10px] text-ink-500">{heading}</p>
              <ul className="mt-4 space-y-2.5">
                {links.map(([href, label]) => (
                  <li key={href}>
                    <Link
                      href={href}
                      className="inline-block py-0.5 text-[13px] text-ink-300 transition-colors duration-150 ease-snap hover:text-ink-100"
                    >
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        {/* meta — the small print, set in the data voice */}
        <div className="rule mt-14 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-6">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-500">
            © 2026 Probo · World Cup edition
          </span>
          <span className="label !text-[10px] flex items-center gap-2 text-ink-400">
            Powered by{" "}
            <span className="display-condensed text-[13px] tracking-[0.06em] text-ink-200">
              TxLINE
            </span>
            <span aria-hidden className="text-ink-700">
              /
            </span>
            Built on Solana
          </span>
        </div>
      </div>

      {/* the back cover: full-bleed wordmark, flush to the bottom edge */}
      <div aria-hidden className="select-none overflow-hidden">
        <svg
          viewBox="0 0 1000 186"
          className="block w-full"
          preserveAspectRatio="xMidYMax meet"
          focusable="false"
        >
          <defs>
            <linearGradient id="footer-probo" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--ink-700)" />
              <stop offset="1" stopColor="var(--ink-800)" />
            </linearGradient>
          </defs>
          <text
            x="0"
            y="184"
            className="display"
            fontSize="258"
            textLength="960"
            lengthAdjust="spacingAndGlyphs"
            fill="url(#footer-probo)"
          >
            PROBO
          </text>
          {/* the sealed proof — the mark's brass cell, as a full stop */}
          <rect x="972" y="156" width="28" height="28" fill="var(--brass-500)" />
        </svg>
      </div>
    </footer>
  );
}
