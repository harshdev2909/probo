/**
 * Receipt reconstruction — rebuild a settlement from chain, and check it against
 * TxLINE without believing whoever showed it to you.
 *
 * The five facts a receipt rests on, and where each must come from:
 *
 *   settlement   the settling program's own account       (Solana)
 *   predicate    the same account — fixed at creation      (Solana)
 *   merkle root  TxLINE's OWN daily-roots PDA             (Solana)
 *   proof        TxLINE's API                             (TxLINE)
 *   verdict      TxLINE's OWN program                     (Solana simulation)
 *
 * Note what is absent: the settling protocol's API and database. A receipt that
 * can only be checked by asking the protocol whether it is telling the truth is
 * not a receipt.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchProofV3, findFinalisedSeq, toPayloadV3, proofEpochDay } from "./proof";
import { verifyWithOracle, rootIsPublished } from "./settle";
import type { TxLineSession } from "./session";
import type { NDimensionalStrategy } from "./predicate";

export interface VerifiedReceipt {
  verified: boolean;
  fixtureId: number;
  /** The values the merkle proof attests — never a feed's sampled score. */
  provenValues: number[];
  epochDay: number;
  rootsPda: string;
  reason?: string;
}

/**
 * Verify a settlement end-to-end. `strategy` and `statKeys` must come from the
 * settling program's on-chain spec — if you pass what the protocol's API told
 * you, you have verified nothing.
 */
export async function verifyReceipt(opts: {
  connection: Connection;
  session: TxLineSession;
  txoracle: any;
  BN: any;
  fixtureId: number;
  statKeys: number[];
  strategy: NDimensionalStrategy;
  seq?: number;
}): Promise<VerifiedReceipt> {
  const { connection, session, txoracle, BN, fixtureId, statKeys, strategy } = opts;

  const seq = opts.seq ?? (await findFinalisedSeq(session, fixtureId));
  const val = await fetchProofV3(session, fixtureId, seq, statKeys);
  const epochDay = proofEpochDay(val);
  const rootsPda = (await import("./settle")).dailyRootsPda(
    epochDay,
    txoracle.programId
  );

  if (!(await rootIsPublished(connection, epochDay, txoracle.programId))) {
    return {
      verified: false,
      fixtureId,
      provenValues: [],
      epochDay,
      rootsPda: rootsPda.toBase58(),
      reason:
        "TxLINE has not published a root for that day yet. Roots land on batch " +
        "boundaries — retry, do not treat this as a failed proof.",
    };
  }

  const payload = toPayloadV3(val, BN);
  const verified = await verifyWithOracle({
    txoracle,
    payload,
    strategy,
    epochDay,
  });

  return {
    verified,
    fixtureId,
    provenValues: val.statsToProve.map((l: any) => l.stat.value),
    epochDay,
    rootsPda: rootsPda.toBase58(),
    reason: verified ? undefined : "TxLINE's program did not verify this claim.",
  };
}

/** A settlement receipt, reconstructed FROM CHAIN — no database involved. */
export interface ChainReceipt {
  marketPda: string;
  fixtureId: number;
  marketType: number;
  status: string;
  winningOutcome: number | null;
  /** Hex events-subtree root the settlement proved against. */
  proofRef: string;
  proofTs: number;
  epochDay: number;
  dailyRootsPda: string;
  resolver: string;
  settledAt: number;
  totalPool: string;
  totalWinningPool: string;
  feeAmount: string;
  /** Present for compound markets (market_type >= 16). */
  legs?: { key: number; period: number }[];
}

/**
 * Rebuild the receipt a settled market carries, reading only Solana accounts.
 * `settlerIdl` is the settling program's IDL (used purely as an account decoder).
 */
export async function reconstructReceipt(opts: {
  anchor: any;
  connection: Connection;
  settlerIdl: any;
  marketPda: string;
}): Promise<ChainReceipt> {
  const { anchor, connection } = opts;
  const market = new PublicKey(opts.marketPda);
  const provider = new anchor.AnchorProvider(
    connection,
    {
      publicKey: market,
      signTransaction: async (t: any) => t,
      signAllTransactions: async (t: any) => t,
    },
    { commitment: "confirmed" }
  );
  const prog = new anchor.Program(opts.settlerIdl, provider);
  const m: any = await prog.account.market.fetch(market);

  const out: ChainReceipt = {
    marketPda: opts.marketPda,
    fixtureId: Number(m.fixtureId),
    marketType: Number(m.marketType),
    status: Object.keys(m.status)[0],
    winningOutcome: m.winningOutcome === 255 ? null : Number(m.winningOutcome),
    proofRef: Buffer.from(m.settleProofRef).toString("hex"),
    proofTs: Number(m.settleProofTs),
    epochDay: Number(m.settleEpochDay),
    dailyRootsPda: m.settleDailyRoots.toBase58(),
    resolver: m.settleResolver.toBase58(),
    settledAt: Number(m.settledAt),
    totalPool: m.totalPool.toString(),
    totalWinningPool: m.totalWinningPool?.toString() ?? "0",
    feeAmount: m.feeAmount?.toString() ?? "0",
  };
  if (out.marketType >= 16) {
    const [comboPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("combo"), market.toBuffer()],
      prog.programId
    );
    try {
      const combo: any = await prog.account.comboSpec.fetch(comboPda);
      out.legs = combo.legs.map((l: any) => ({ key: l.key, period: l.period }));
    } catch {
      /* no sidecar — leave legs absent */
    }
  }
  return out;
}
