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
