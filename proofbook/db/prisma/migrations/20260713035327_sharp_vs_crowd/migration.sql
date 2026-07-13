-- AlterTable
ALTER TABLE "odds_snapshots" ADD COLUMN     "bookmaker" TEXT,
ADD COLUMN     "consensusPct" DOUBLE PRECISION[],
ADD COLUMN     "consensusTs" BIGINT;
