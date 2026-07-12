"use client";

/**
 * Which chain are we actually talking to?
 *
 * We verify by genesis hash rather than by trusting a config string: a misconfigured
 * SOLANA_RPC_URL pointing at mainnet would otherwise look completely normal until a
 * judge's bet vanished into a program that doesn't exist there.
 *
 * Note what this does NOT do: it does not check the WALLET's network. It can't —
 * no wallet exposes that. It also no longer matters for correctness: the wallet
 * only signs, and the app broadcasts the signed transaction over its own devnet
 * connection (see lib/anchor.ts), so a Phantom set to mainnet still produces a bet
 * that lands on devnet. What it does affect is Phantom's preview, which will warn
 * or fail to simulate — alarming, and worth telling people about up front.
 */
import { useEffect, useState } from "react";

export const GENESIS = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
} as const;

export type Cluster = keyof typeof GENESIS | "unknown";

export interface ClusterState {
  cluster: Cluster;
  /** null while we're still asking. */
  ok: boolean | null;
  error: string | null;
}

/**
 * Asks OUR rpc proxy which cluster it is on. One request, cached for the session.
 */
export function useCluster(): ClusterState {
  const [state, setState] = useState<ClusterState>({
    cluster: "unknown",
    ok: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getGenesisHash",
            params: [],
          }),
        });
        if (!res.ok) throw new Error(`RPC proxy returned ${res.status}`);
        const body = await res.json();
        const hash: string | undefined = body?.result;
        if (cancelled) return;

        const cluster =
          (Object.entries(GENESIS).find(([, h]) => h === hash)?.[0] as Cluster) ?? "unknown";
        setState({ cluster, ok: cluster === "devnet", error: null });
      } catch (e) {
        if (cancelled) return;
        setState({
          cluster: "unknown",
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
