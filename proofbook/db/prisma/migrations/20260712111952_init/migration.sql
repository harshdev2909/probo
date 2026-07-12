-- CreateEnum
CREATE TYPE "ProofStatus" AS ENUM ('proven', 'no_proof', 'upcoming');

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('open', 'locked', 'settled', 'cancelled');

-- CreateTable
CREATE TABLE "teams" (
    "code" VARCHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "iso" TEXT NOT NULL,
    "confed" TEXT NOT NULL,
    "chip" TEXT NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "fixtures" (
    "id" INTEGER NOT NULL,
    "competitionId" INTEGER,
    "homeName" TEXT NOT NULL,
    "awayName" TEXT NOT NULL,
    "homeCode" VARCHAR(3),
    "awayCode" VARCHAR(3),
    "stage" TEXT NOT NULL,
    "kickoffTs" TIMESTAMP(3) NOT NULL,
    "proofStatus" "ProofStatus" NOT NULL DEFAULT 'upcoming',
    "gapReason" TEXT,
    "statusId" INTEGER,
    "provenP1" INTEGER,
    "provenP2" INTEGER,
    "lastSeq" INTEGER,
    "lastTs" BIGINT,
    "finalisedSeq" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fixtures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markets" (
    "pda" TEXT NOT NULL,
    "fixtureId" INTEGER NOT NULL,
    "marketType" INTEGER NOT NULL,
    "status" "MarketStatus" NOT NULL DEFAULT 'open',
    "lockTime" TIMESTAMP(3) NOT NULL,
    "resolutionTimeout" INTEGER NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "usdcMint" TEXT NOT NULL,
    "vault" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "oracleProgram" TEXT NOT NULL,
    "totalPool" BIGINT NOT NULL DEFAULT 0,
    "pools" BIGINT[],
    "totalWinningPool" BIGINT,
    "feeAmount" BIGINT,
    "winningOutcome" INTEGER,
    "createdTx" TEXT,
    "lockTx" TEXT,
    "settleTx" TEXT,
    "cancelTx" TEXT,
    "settledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("pda")
);

-- CreateTable
CREATE TABLE "positions" (
    "pda" TEXT NOT NULL,
    "marketPda" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "outcomeIndex" INTEGER NOT NULL,
    "amount" BIGINT NOT NULL,
    "claimed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("pda")
);

-- CreateTable
CREATE TABLE "receipts" (
    "marketPda" TEXT NOT NULL,
    "fixtureId" INTEGER NOT NULL,
    "winningOutcome" INTEGER NOT NULL,
    "outcomeLabel" TEXT NOT NULL,
    "provenP1" INTEGER,
    "provenP2" INTEGER,
    "statPeriod" INTEGER,
    "oracleProgram" TEXT NOT NULL,
    "epochDay" INTEGER NOT NULL,
    "dailyRootsPda" TEXT NOT NULL,
    "proofRef" TEXT NOT NULL,
    "resolver" TEXT NOT NULL,
    "settleTx" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL,
    "totalPool" BIGINT NOT NULL,
    "totalWinningPool" BIGINT NOT NULL,
    "feeAmount" BIGINT NOT NULL,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("marketPda")
);

-- CreateTable
CREATE TABLE "feed_events" (
    "id" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "fixtureId" INTEGER,
    "marketPda" TEXT,
    "seq" INTEGER,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odds_snapshots" (
    "id" BIGSERIAL NOT NULL,
    "marketPda" TEXT NOT NULL,
    "pools" BIGINT[],
    "totalPool" BIGINT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odds_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "keeper_runs" (
    "id" TEXT NOT NULL,
    "instance" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "version" TEXT,
    "isLeader" BOOLEAN NOT NULL DEFAULT false,
    "streamConnected" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeat" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastEventAt" TIMESTAMP(3),
    "lastSettlementAt" TIMESTAMP(3),
    "marketsSettled" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "keeper_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faucet_grants" (
    "wallet" TEXT NOT NULL,
    "grants" INTEGER NOT NULL DEFAULT 0,
    "totalUsdc" BIGINT NOT NULL DEFAULT 0,
    "lastGrantAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "faucet_grants_pkey" PRIMARY KEY ("wallet")
);

-- CreateTable
CREATE TABLE "kv" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kv_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "teams_name_key" ON "teams"("name");

-- CreateIndex
CREATE INDEX "fixtures_stage_idx" ON "fixtures"("stage");

-- CreateIndex
CREATE INDEX "fixtures_kickoffTs_idx" ON "fixtures"("kickoffTs");

-- CreateIndex
CREATE INDEX "fixtures_proofStatus_idx" ON "fixtures"("proofStatus");

-- CreateIndex
CREATE INDEX "markets_status_idx" ON "markets"("status");

-- CreateIndex
CREATE INDEX "markets_marketType_idx" ON "markets"("marketType");

-- CreateIndex
CREATE INDEX "markets_fixtureId_idx" ON "markets"("fixtureId");

-- CreateIndex
CREATE INDEX "markets_lockTime_idx" ON "markets"("lockTime");

-- CreateIndex
CREATE UNIQUE INDEX "markets_fixtureId_marketType_key" ON "markets"("fixtureId", "marketType");

-- CreateIndex
CREATE INDEX "positions_owner_idx" ON "positions"("owner");

-- CreateIndex
CREATE INDEX "positions_marketPda_idx" ON "positions"("marketPda");

-- CreateIndex
CREATE INDEX "receipts_settledAt_idx" ON "receipts"("settledAt");

-- CreateIndex
CREATE INDEX "receipts_fixtureId_idx" ON "receipts"("fixtureId");

-- CreateIndex
CREATE INDEX "feed_events_createdAt_idx" ON "feed_events"("createdAt");

-- CreateIndex
CREATE INDEX "feed_events_type_createdAt_idx" ON "feed_events"("type", "createdAt");

-- CreateIndex
CREATE INDEX "feed_events_fixtureId_idx" ON "feed_events"("fixtureId");

-- CreateIndex
CREATE INDEX "odds_snapshots_marketPda_takenAt_idx" ON "odds_snapshots"("marketPda", "takenAt");

-- CreateIndex
CREATE INDEX "keeper_runs_lastHeartbeat_idx" ON "keeper_runs"("lastHeartbeat");

-- CreateIndex
CREATE INDEX "faucet_grants_lastGrantAt_idx" ON "faucet_grants"("lastGrantAt");

-- AddForeignKey
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_homeCode_fkey" FOREIGN KEY ("homeCode") REFERENCES "teams"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_awayCode_fkey" FOREIGN KEY ("awayCode") REFERENCES "teams"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "markets" ADD CONSTRAINT "markets_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "fixtures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_marketPda_fkey" FOREIGN KEY ("marketPda") REFERENCES "markets"("pda") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_marketPda_fkey" FOREIGN KEY ("marketPda") REFERENCES "markets"("pda") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feed_events" ADD CONSTRAINT "feed_events_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "fixtures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odds_snapshots" ADD CONSTRAINT "odds_snapshots_marketPda_fkey" FOREIGN KEY ("marketPda") REFERENCES "markets"("pda") ON DELETE CASCADE ON UPDATE CASCADE;
