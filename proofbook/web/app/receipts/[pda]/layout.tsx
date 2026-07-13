/**
 * Per-receipt share metadata.
 *
 * The receipt page itself is a client component (it reads the chain to verify),
 * and a client component cannot export `generateMetadata`. This server layout
 * wraps it purely so a shared link carries the real match, the real proven score
 * and the dynamic OG card — instead of the generic site title.
 */
import type { Metadata } from "next";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ pda: string }>;
}): Promise<Metadata> {
  const { pda } = await params;

  try {
    const res = await fetch(`${API_URL}/receipts/${pda}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) throw new Error(String(res.status));
    const r: any = await res.json();

    const home = r.home?.name ?? "Home";
    const away = r.away?.name ?? "Away";
    const score =
      r.provenScore && r.provenScore.p1 !== null
        ? `${r.provenScore.p1}–${r.provenScore.p2}`
        : null;

    const title = score
      ? `${home} ${score} ${away} · proven, not trusted`
      : `${home} v ${away} · Proof Receipt`;
    const description = score
      ? `Settled ${r.outcomeLabel} on a real TxLINE merkle proof, verified on-chain. Don't take our word for it. Check it yourself.`
      : `A ProofBook settlement, verifiable against TxLINE's on-chain merkle root.`;

    return {
      title,
      description,
      openGraph: { title, description, type: "article" },
      twitter: { card: "summary_large_image", title, description },
    };
  } catch {
    // No receipt is a real state, and it should share honestly as one.
    return {
      title: "No receipt for this market",
      description:
        "ProofBook could not obtain a proof for this market, so it does not claim one.",
    };
  }
}

export default function ReceiptLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
