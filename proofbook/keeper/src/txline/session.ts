import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import axios, { AxiosInstance } from "axios";
import nacl from "tweetnacl";
import * as fs from "fs";
import * as path from "path";

import { KeeperConfig, ROOT } from "../config";
import { Logger } from "../logger";
import { Store, type StoreLike } from "../state";
import { Chain } from "../chain/proofbook";

const TXL_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");

/**
 * TxLINE session manager. Owns the guest JWT (short-lived) and the apiToken
 * (long-lived, obtained via the FREE on-chain World-Cup subscription). Both are
 * persisted; the JWT auto-renews on 401 and the apiToken re-subscribes on 403.
 * Designed to never crash the keeper on token expiry.
 */
export class TxLineSession {
  api: AxiosInstance;
  private log = new Logger("txline:auth");
  private renewing: Promise<string> | null = null;

  constructor(
    private cfg: KeeperConfig,
    private store: StoreLike,
    private chain: Chain
  ) {
    this.api = axios.create({
      baseURL: `${cfg.txlineApi}/api`,
      timeout: 30_000,
    });

    this.api.interceptors.request.use((rc) => {
      const s = this.store.data.session;
      if (s.jwt) rc.headers["Authorization"] = `Bearer ${s.jwt}`;
      if (s.apiToken) rc.headers["X-Api-Token"] = s.apiToken;
      return rc;
    });

    this.api.interceptors.response.use(
      (r) => r,
      async (error) => {
        const rc = error.config || {};
        const status = error.response?.status;
        if (status === 401 && !rc._retriedJwt) {
          rc._retriedJwt = true;
          this.log.warn("401 — renewing guest JWT and retrying");
          await this.renewJwt();
          return this.api(rc);
        }
        if (status === 403 && !rc._retriedToken) {
          rc._retriedToken = true;
          this.log.warn(
            "403 — apiToken rejected; re-running free subscribe + activate"
          );
          await this.subscribeAndActivate();
          return this.api(rc);
        }
        return Promise.reject(error);
      }
    );
  }

  async ensure(): Promise<void> {
    if (!this.store.data.session.jwt) await this.renewJwt();
    if (!this.store.data.session.apiToken) await this.subscribeAndActivate();
    this.log.info("session ready", {
      apiToken: (this.store.data.session.apiToken || "").slice(0, 14) + "...",
    });
  }

  async renewJwt(): Promise<string> {
    if (!this.renewing) {
      this.renewing = (async () => {
        const { data } = await axios.post(
          `${this.cfg.txlineApi}/auth/guest/start`
        );
        this.store.data.session.jwt = data.token;
        this.store.saveSoon();
        this.log.info("guest JWT renewed");
        return data.token as string;
      })().finally(() => (this.renewing = null));
    }
    return this.renewing;
  }

  /** FREE World-Cup tier: on-chain subscribe (level 1 @ price 0) + activation. */
  async subscribeAndActivate(): Promise<string> {
    const jwt = this.store.data.session.jwt || (await this.renewJwt());
    const { connection, wallet } = this.chain;

    const txoracleIdl = JSON.parse(
      fs.readFileSync(
        path.join(ROOT, "scripts", "vendor", "txoracle.json"),
        "utf8"
      )
    );
    const txoracle = new anchor.Program(
      txoracleIdl,
      this.chain.provider
    ) as any;

    const ata = getAssociatedTokenAddressSync(
      TXL_MINT,
      wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    if (!(await connection.getAccountInfo(ata))) {
      this.log.info("creating Token-2022 TxL ATA");
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          ata,
          wallet.publicKey,
          TXL_MINT,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      await anchor.web3.sendAndConfirmTransaction(connection, tx, [wallet], {
        commitment: "confirmed",
      });
    }

    const [pricingMatrix] = PublicKey.findProgramAddressSync(
      [Buffer.from("pricing_matrix")],
      txoracle.programId
    );
    const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_treasury_v2")],
      txoracle.programId
    );
    const tokenTreasuryVault = getAssociatedTokenAddressSync(
      TXL_MINT,
      tokenTreasuryPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );

    const sig = await txoracle.methods
      .subscribe(this.cfg.serviceLevelId, this.cfg.subscribeWeeks)
      .accounts({
        user: wallet.publicKey,
        pricingMatrix,
        tokenMint: TXL_MINT,
        userTokenAccount: ata,
        tokenTreasuryVault,
        tokenTreasuryPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();
    this.log.info("free-tier subscribe tx", { sig });

    const message = new TextEncoder().encode(`${sig}::${jwt}`);
    const walletSignature = Buffer.from(
      nacl.sign.detached(message, wallet.secretKey)
    ).toString("base64");
    const { data } = await axios.post(
      `${this.cfg.txlineApi}/api/token/activate`,
      { txSig: sig, walletSignature, leagues: [] },
      { headers: { Authorization: `Bearer ${jwt}` } }
    );
    const apiToken = data.token || data;
    this.store.data.session.apiToken = apiToken;
    this.store.saveSoon();
    this.log.info("apiToken activated", {
      apiToken: apiToken.slice(0, 14) + "...",
    });
    return apiToken;
  }

  headers(): Record<string, string> {
    const s = this.store.data.session;
    return {
      Authorization: `Bearer ${s.jwt}`,
      "X-Api-Token": s.apiToken || "",
    };
  }
}
