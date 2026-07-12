"use client";

/**
 * Group tables, built from proven results only.
 *
 * A group's table is only as complete as the proofs behind it. Where a match
 * cannot be proven it is counted as unplayed and the group says so, rather than
 * silently folding in a result we would have had to invent. Each group carries
 * its own "N of 6 proven" marker so the tables are never mistaken for final.
 */
import { useEffect, useMemo, useState } from "react";

import { api, type MarketView } from "@/lib/api";
import { groupsOf, toFixture, type Group } from "@/lib/tournament";
import { StaggerItem } from "@/components/motion";
import { QuarterLoader, EmptyState, ErrorState } from "@/components/primitives";
import { PageArt } from "@/components/PageArt";
import { Flag } from "@/components/Flag";

type LoadState = "loading" | "ready" | "error";

function GroupTable({ g }: { g: Group }) {
  const complete = g.provenCount === g.totalCount;
  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-[14px] text-ink-100">{g.label}</h2>
        <span
          className={`label !text-[10px] ${complete ? "!text-brass-500" : ""}`}
          title={
            complete
              ? "Every match in this group is backed by a proof"
              : "Some matches here fall outside TxLINE's proof retention window and are counted as unplayed"
          }
        >
          {g.provenCount}/{g.totalCount} proven
        </span>
      </div>

      <table className="w-full border-collapse">
        <caption className="sr-only">
          {g.label} table, from {g.provenCount} of {g.totalCount} proven results
        </caption>
        <thead>
          <tr className="text-ink-500">
            <th scope="col" className="label !text-[10px] pb-2 text-left font-normal">Team</th>
            <th scope="col" className="label !text-[10px] pb-2 text-right font-normal">P</th>
            <th scope="col" className="label !text-[10px] pb-2 text-right font-normal">W</th>
            <th scope="col" className="label !text-[10px] pb-2 text-right font-normal">D</th>
            <th scope="col" className="label !text-[10px] pb-2 text-right font-normal">L</th>
            <th scope="col" className="label !text-[10px] pb-2 text-right font-normal">GD</th>
            <th scope="col" className="label !text-[10px] pb-2 text-right font-normal">Pts</th>
          </tr>
        </thead>
        <tbody>
          {g.rows.map((r, i) => (
            <tr
              key={r.team.code}
              className={`border-t border-hairline ${i < 2 ? "text-ink-100" : "text-ink-400"}`}
            >
              <td className="py-2">
                <span className="flex items-center gap-2">
                  <Flag team={r.team} size={16} />
                  <span className="text-[12px]">{r.team.code}</span>
                </span>
              </td>
              <td className="mono py-2 text-right text-[12px]">{r.played}</td>
              <td className="mono py-2 text-right text-[12px]">{r.won}</td>
              <td className="mono py-2 text-right text-[12px]">{r.drawn}</td>
              <td className="mono py-2 text-right text-[12px]">{r.lost}</td>
              <td className="mono py-2 text-right text-[12px]">
                {r.gd > 0 ? `+${r.gd}` : r.gd}
              </td>
              <td className="mono py-2 text-right text-[13px] text-brass-500">{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Standings() {
  const [markets, setMarkets] = useState<MarketView[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const load = () =>
    api.allMarkets()
      .then((m) => { setMarkets(m); setState("ready"); })
      .catch(() => setState("error"));

  useEffect(() => { void load(); }, []);

  const groups = useMemo(() => groupsOf(markets.map(toFixture)), [markets]);
  const proven = groups.reduce((a, g) => a + g.provenCount, 0);
  const total = groups.reduce((a, g) => a + g.totalCount, 0);

  return (
    <main className="mx-auto w-full max-w-6xl px-6 pt-12 lg:px-10">
      <PageArt src="/art-groups.jpg" opacity={0.26} />

      <header className="mb-10">
        <h1 className="display text-[clamp(34px,5vw,54px)] text-ink-100">Groups</h1>
        <p className="mt-2 max-w-2xl text-[13px] text-ink-400">
          These tables are built from proven results only{" "}
          {total > 0 && (
            <span className="text-ink-300">
              ({proven} of {total} group matches)
            </span>
          )}
          . Where a result cannot be proven we leave it out rather than fill it in from
          memory, so a table can read as incomplete. That is the honest version.
        </p>
      </header>

      {state === "loading" && (
        <div className="flex flex-col items-center gap-4 py-24">
          <QuarterLoader size={36} label="Loading groups" />
          <p className="label">Loading groups</p>
        </div>
      )}
      {state === "error" && (
        <div className="panel">
          <ErrorState title="Keeper API unreachable" retry={() => { setState("loading"); void load(); }} />
        </div>
      )}
      {state === "ready" && groups.length === 0 && (
        <div className="panel">
          <EmptyState title="No groups yet" hint="Group tables appear once the fixtures are indexed." />
        </div>
      )}

      {state === "ready" && groups.length > 0 && (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((g, i) => (
            <StaggerItem key={g.label} i={i} base={0.16}>
              <li>
                <GroupTable g={g} />
              </li>
            </StaggerItem>
          ))}
        </ul>
      )}
    </main>
  );
}
