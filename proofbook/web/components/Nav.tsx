"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { Wordmark } from "./Mark";
import { useStreamStatus } from "@/lib/stream";
import { AmbienceToggle } from "./Ambience";

const WalletButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false }
);

const LINKS = [
  ["/matches", "Matches"],
  ["/receipts", "Receipts"],
  ["/bracket", "Bracket"],
  ["/standings", "Groups"],
  ["/portfolio", "Portfolio"],
  ["/keeper", "Keeper"],
  ["/status", "Status"],
] as const;

export function Nav() {
  const path = usePathname();
  const status = useStreamStatus();
  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-ink-950/92 backdrop-blur-[2px]">
      <nav className="mx-auto flex h-16 w-full max-w-6xl items-center gap-6 px-6 lg:px-10">
        <Link href="/" aria-label="Probo home" className="shrink-0">
          <Wordmark />
        </Link>
        <div className="hidden gap-5 md:flex">
          {LINKS.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className={`label !text-[11px] transition-colors duration-150 ease-snap hover:text-ink-100 ${
                path.startsWith(href) ? "!text-ink-100" : ""
              }`}
              aria-current={path.startsWith(href) ? "page" : undefined}
            >
              {label}
            </Link>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <AmbienceToggle />
          <span
            className="hidden items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] md:inline-flex"
            title={`Keeper stream: ${status}`}
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${
                status === "live" ? "bg-pitch-400" : status === "connecting" ? "bg-amber-400" : "bg-oxide-400"
              } ${status === "live" ? "live-dot" : ""}`}
              style={{ width: 6, height: 6 }}
            />
            <span className={status === "live" ? "text-pitch-400" : status === "connecting" ? "text-amber-400" : "text-oxide-400"}>
              {status === "live" ? "feed live" : status === "connecting" ? "reconnecting" : "feed down"}
            </span>
          </span>
          <WalletButton
            style={{
              background: "transparent",
              border: "1px solid var(--hairline-strong)",
              borderRadius: "0 0 0 12px",
              fontSize: 11,
              fontFamily: "var(--font-plex-mono)",
              height: 36,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          />
        </div>
      </nav>
    </header>
  );
}
