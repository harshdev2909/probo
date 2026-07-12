import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

export const MARKET_SEED = Buffer.from("market");
export const VAULT_SEED = Buffer.from("vault");
export const POSITION_SEED = Buffer.from("position");
export const DAILY_SCORES_SEED = Buffer.from("daily_scores_roots");
export const MS_PER_DAY = 86_400_000;

export function marketPda(
  programId: PublicKey,
  authority: PublicKey,
  fixtureId: BN,
  marketType: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      MARKET_SEED,
      authority.toBuffer(),
      fixtureId.toArrayLike(Buffer, "le", 8),
      Buffer.from([marketType]),
    ],
    programId
  )[0];
}

export function vaultPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_SEED, market.toBuffer()], programId)[0];
}

export function positionPda(
  programId: PublicKey,
  market: PublicKey,
  owner: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, market.toBuffer(), owner.toBuffer()],
    programId
  )[0];
}

export function epochDayOf(tsMs: number): number {
  return Math.floor(tsMs / MS_PER_DAY);
}

export function dailyRootsPda(oracleProgram: PublicKey, epochDay: number): PublicKey {
  const le = Buffer.alloc(2);
  le.writeUInt16LE(epochDay & 0xffff, 0);
  return PublicKey.findProgramAddressSync([DAILY_SCORES_SEED, le], oracleProgram)[0];
}
