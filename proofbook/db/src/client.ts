/**
 * The Prisma client, as a process-wide singleton.
 *
 * Next.js dev reloads and ts-node re-entry both re-evaluate modules, and a fresh
 * PrismaClient per reload exhausts Postgres connections within a minute. Cache it
 * on globalThis so a reload reuses the same pool.
 */
import { PrismaClient } from "../generated/client";

const g = globalThis as unknown as { __proofbookPrisma?: PrismaClient };

export const prisma: PrismaClient =
  g.__proofbookPrisma ??
  new PrismaClient({
    log:
      process.env.PRISMA_LOG === "1"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") g.__proofbookPrisma = prisma;

export * from "../generated/client";

/**
 * The Postgres NOTIFY channel the keeper writes to and every API instance listens
 * on. It lives here, not in the API: it belongs to the database, and putting it in
 * api/ would make the KEEPER import the API just to learn a channel name.
 */
export const CHANNEL = "proofbook_events";

/** JSON cannot hold a BigInt. Serialise as a decimal string everywhere. */
export function jsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
  ) as T;
}
