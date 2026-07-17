/**
 * NFT metadata for a Proof-of-Outcome collectible.
 *
 * Metaplex Core points an asset's `uri` here. The JSON embeds the thing that
 * makes this NFT worth anything: the proof reference, the settle transaction, and
 * a link to re-verify it against TxLINE's on-chain oracle. The image reuses the
 * receipt's existing ink/brass OG card.
 *
 * It is served ONLY for a receipt that is genuinely settled on-chain. If the
 * market is not settled — or has no proof — this returns 404, so an NFT can never
 * point at metadata for a settlement that did not happen.
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

function siteUrl(req: NextRequest): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    `${req.nextUrl.protocol}//${req.nextUrl.host}`
  );
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ pda: string }> }
) {
  const { pda } = await ctx.params;

  let r: any = null;
  try {
    const res = await fetch(`${API_URL}/receipts/${pda}`, {
      next: { revalidate: 300 },
    });
    if (res.ok) r = await res.json();
  } catch {
    /* fall through to the honest 404 */
  }

  // No receipt, or no proof, means no NFT. We do not mint a claim we cannot back.
  if (!r || !r.proofRef || !r.settleTx) {
    return NextResponse.json(
      { error: "no settled proof receipt for this market" },
      { status: 404 }
    );
  }

  const site = siteUrl(req);
  const home = r.home?.name ?? "Home";
  const away = r.away?.name ?? "Away";
  const stage = r.stage ?? "World Cup";
  const score =
    r.provenScore && r.provenScore.p1 !== null
      ? `${r.provenScore.p1}–${r.provenScore.p2}`
      : null;
  const image = `${site}/receipts/${pda}/opengraph-image`;
  const verify = `${site}/verify?market=${pda}`;

  const attributes = [
    { trait_type: "Tournament", value: "World Cup 2026" },
    { trait_type: "Stage", value: stage },
    { trait_type: "Fixture", value: `${home} v ${away}` },
    { trait_type: "Outcome", value: r.outcomeLabel },
    ...(score ? [{ trait_type: "Proven score", value: score }] : []),
    { trait_type: "Oracle", value: "TxLINE validate_stat_v3" },
    { trait_type: "Proof ref", value: r.proofRef },
    { trait_type: "Settle tx", value: r.settleTx },
    { trait_type: "Settled by", value: "a merkle proof, not an admin" },
  ];

  return NextResponse.json(
    {
      name: `ProofBook · ${home} v ${away} · ${stage}`,
      symbol: "PROOF",
      description:
        `Proof-of-Outcome. ${home} v ${away} (${stage}) settled to "${r.outcomeLabel}"` +
        `${score ? `, proven ${score},` : ""} trustlessly — TxLINE's own on-chain ` +
        `oracle re-derived the merkle root and returned true inside the settlement ` +
        `transaction. No admin key resolved this. Verify it yourself: ${verify}`,
      image,
      external_url: verify,
      attributes,
      properties: {
        category: "image",
        files: [{ uri: image, type: "image/png" }],
      },
    },
    {
      headers: { "cache-control": "public, max-age=300" },
    }
  );
}
