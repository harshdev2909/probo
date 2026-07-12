"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * RPC is for wallet signing ONLY — every list and read comes from the API.
 *
 * This points at our OWN origin, not at Helius. The upstream URL (which carries
 * the API key) lives server-side in `app/api/rpc/route.ts`; putting it in a
 * NEXT_PUBLIC_ var would inline it into the JS bundle and publish the key.
 */
export const RPC_PATH = "/api/rpc";

export function rpcEndpoint(): string {
  if (typeof window !== "undefined") return `${window.location.origin}${RPC_PATH}`;
  // SSR: the provider is only ever exercised in the browser, but Connection wants
  // an absolute URL at construction time.
  return `${process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"}${RPC_PATH}`;
}

export function SolanaProviders({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );
  const endpoint = useMemo(() => rpcEndpoint(), []);
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
