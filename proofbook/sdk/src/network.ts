/**
 * Network configuration — the SDK works against devnet and mainnet; everything
 * that differs between them lives here and nowhere else.
 */
export interface Network {
  /** TxLINE's on-chain oracle (the `txoracle` program). */
  oracleProgram: string;
  /** TxLINE's REST/SSE origin. */
  apiOrigin: string;
  /** TxL subscription mint (Token-2022) for the on-chain subscribe. */
  txlMint: string;
  cluster: "devnet" | "mainnet-beta";
}

export const DEVNET: Network = {
  oracleProgram: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
  apiOrigin: "https://txline-dev.txodds.com",
  txlMint: "4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG",
  cluster: "devnet",
};

export const MAINNET: Network = {
  oracleProgram: "9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA",
  apiOrigin: "https://txline.txodds.com",
  txlMint: "Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL",
  cluster: "mainnet-beta",
};
