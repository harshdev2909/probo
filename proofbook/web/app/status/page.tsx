"use client";

/**
 * Public status page.
 *
 * The keeper has to be alive to settle the semi-finals and the Final by itself.
 * If it dies, the site would otherwise just go quietly stale — the scores stop
 * moving and nothing says why. This page exists so that failure is loud: a dead
 * heartbeat is shown as dead, and the last event it saw is stamped with a real
 * time.
 *
 * It reads only the API, so it also proves the API and the database are up.
 */
import { useCallback, useEffect, useState } from "react";

import { api, type HealthView, type KeeperStatus } from "@/lib/api";
import { useCluster } from "@/lib/cluster";
import { useStreamStatus } from "@/lib/stream";
import { QuarterLoader, ErrorState } from "@/components/primitives";

type Keeper = KeeperStatus & {
  faucet: {
    enabled: boolean;
    address: string | null;
    reserves: { sol: number; usdc: number } | null;
  };
};

const ago = (ts: number | null) => {
  if (ts === null) return "never";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

function Light({ ok, warn }: { ok: boolean; warn?: boolean }) {
  const color = ok ? "bg-pitch-400" : warn ? "bg-brass-500" : "bg-oxide-400";
  return (
    <span
      aria-hidden
      className={`inline-block h-2 w-2 rounded-full ${color} ${ok ? "" : "animate-pulse"}`}
    />
  );
}

function Row({
  label,
  value,
  ok,
  warn,
  hint,
}: {
  label: string;
  value: string;
  ok?: boolean;
  warn?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-hairline py-3">
      <div className="min-w-0">
        <p className="text-[13px] text-ink-100">{label}</p>
        {hint && <p className="mt-0.5 text-[11px] leading-snug text-ink-500">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {ok !== undefined && <Light ok={ok} warn={warn} />}
        <span className="mono text-[12px] text-ink-300">{value}</span>
      </div>
    </div>
  );
}

export default function Status() {
  const [health, setHealth] = useState<HealthView | null>(null);
  const [keeper, setKeeper] = useState<Keeper | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cluster = useCluster();
  const streamStatus = useStreamStatus();

  const load = useCallback(async () => {
    try {
      const [h, k] = await Promise.all([api.health(), api.keeperStatus()]);
      setHealth(h);
      setKeeper(k as Keeper);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  if (err && !health) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 pt-16 lg:px-10">
        <div className="panel">
          <ErrorState title={`API unreachable — ${err}`} retry={() => void load()} />
        </div>
      </main>
    );
  }

  if (!health || !keeper) {
    return (
      <main className="flex justify-center pt-32">
        <QuarterLoader size={36} label="Loading status" />
      </main>
    );
  }

  const hb = keeper.heartbeatAgeSec;
  const keeperOk = keeper.alive;
  const faucetLow =
    keeper.faucet.reserves !== null &&
    (keeper.faucet.reserves.sol < 0.2 || keeper.faucet.reserves.usdc < 50_000);

  return (
    <main className="mx-auto w-full max-w-3xl px-6 pt-12 lg:px-10">
      <header className="mb-8">
        <h1 className="display text-[clamp(30px,4vw,44px)] text-ink-100">Status</h1>
        <p className="mt-2 text-[13px] text-ink-400">
          Nobody clicks resolve. The keeper does it, so it has to be alive — this page
          says whether it is.
        </p>
      </header>

      <section className="panel mb-6 p-5">
        <div className="mb-1 flex items-center gap-2">
          <Light ok={keeperOk} />
          <h2 className="text-[15px] text-ink-100">
            {keeperOk ? "Keeper is alive" : "Keeper is NOT responding"}
          </h2>
        </div>
        <p className="text-[12px] text-ink-500">
          {keeperOk
            ? "It is watching the feed and will settle the semi-finals and the Final on its own."
            : "It has stopped checking in. Matches will not settle until it is back."}
        </p>

        <div className="mt-4">
          <Row
            label="Last heartbeat"
            value={hb === null ? "never" : `${hb}s ago`}
            ok={keeperOk}
            warn={hb !== null && hb > 45 && hb <= 90}
            hint="Considered dead after 90 seconds."
          />
          <Row
            label="Score feed connected"
            value={keeper.streamConnected ? "yes" : "no"}
            ok={keeper.streamConnected}
            hint="The live TxLINE stream the keeper settles from."
          />
          <Row
            label="Last event seen"
            value={ago(keeper.lastEventAt)}
            ok={keeper.lastEventAt !== null}
            warn
            hint="Quiet between matches is normal."
          />
          <Row
            label="Last settlement"
            value={ago(keeper.lastSettlementAt)}
            ok={keeper.lastSettlementAt !== null}
            warn
          />
          <Row label="Instance" value={keeper.instance ?? "—"} />
          {keeper.lastError && (
            <Row label="Last error" value={keeper.lastError.slice(0, 40)} ok={false} />
          )}
        </div>
      </section>

      <section className="panel mb-6 p-5">
        <h2 className="mb-1 text-[15px] text-ink-100">The tournament</h2>
        <p className="mb-3 text-[12px] text-ink-500">
          Every settled market below was resolved by a real cryptographic proof. None
          were resolved by us.
        </p>
        <Row
          label="Settled by proof"
          value={`${health.counts.settled} of ${health.counts.markets}`}
          ok
        />
        <Row label="Proof receipts" value={String(health.counts.receipts)} ok />
        <Row
          label="Honest gaps"
          value={String(health.counts.gaps)}
          hint="Played, but outside TxLINE's retention window — so no proof, and no scoreline. We do not invent either."
        />
      </section>

      <section className="panel p-5">
        <h2 className="mb-3 text-[15px] text-ink-100">Services</h2>
        <Row label="API" value={health.ok ? "up" : "down"} ok={health.ok} />
        <Row label="Database" value={health.db ? "up" : "down"} ok={health.db} />
        <Row
          label="Live stream"
          value={streamStatus}
          ok={streamStatus === "live"}
          warn={streamStatus === "connecting"}
          hint="Server-sent events from the API to this page."
        />
        <Row
          label="Chain"
          value={cluster.cluster}
          ok={cluster.ok === true}
          warn={cluster.ok === null}
          hint="Verified by genesis hash, not by trusting a config value."
        />
        <Row
          label="Faucet"
          value={
            keeper.faucet.reserves
              ? `${keeper.faucet.reserves.sol.toFixed(2)} SOL · ${Math.round(
                  keeper.faucet.reserves.usdc
                ).toLocaleString()} USDC`
              : keeper.faucet.enabled
                ? "enabled"
                : "disabled"
          }
          ok={keeper.faucet.enabled && !faucetLow}
          warn={faucetLow}
          hint={faucetLow ? "Running low — judges may not be able to get test funds." : undefined}
        />
        <Row label="API version" value={health.version} ok />
      </section>
    </main>
  );
}
