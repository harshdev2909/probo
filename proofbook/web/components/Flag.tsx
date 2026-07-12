import "flag-icons/css/flag-icons.min.css";
import type { Team } from "@/lib/teams";

/**
 * A national flag (public-domain state symbol, MIT flag-icons set) cropped
 * with the signature bottom-left quarter corner. Unknown teams get a neutral
 * ledger cell instead. never a wrong flag.
 */
export function Flag({ team, size = 20 }: { team: Team; size?: number }) {
  const h = Math.round(size * 0.75);
  if (!team.iso) {
    return (
      <span
        aria-hidden
        className="inline-block border border-hairline-strong bg-ink-800"
        style={{ width: size, height: h, borderRadius: `0 0 0 ${Math.round(size / 3)}px` }}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={`${team.name} flag`}
      className={`fi fi-${team.iso} !bg-cover`}
      style={{
        width: size,
        height: h,
        display: "inline-block",
        borderRadius: `0 0 0 ${Math.round(size / 3)}px`,
        boxShadow: "inset 0 0 0 1px rgba(242,237,227,0.12)",
      }}
    />
  );
}

export function TeamRow({
  team,
  score,
  winner,
  dim,
}: {
  team: Team;
  score?: number;
  winner?: boolean;
  dim?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 ${dim ? "opacity-45" : ""}`}>
      <Flag team={team} />
      <span className="flex-1 truncate text-[15px] font-medium text-ink-100">{team.name}</span>
      {score !== undefined && (
        <span className="tnum font-mono text-[16px] font-semibold text-ink-100">{score}</span>
      )}
      {winner && (
        <span aria-label="winner" className="text-brass-400" style={{ fontSize: 10 }}>
          ◀
        </span>
      )}
    </div>
  );
}
