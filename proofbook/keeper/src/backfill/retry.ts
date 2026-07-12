/** RPC resilience: retry on 429 / transient RPC errors with exponential backoff. */
import { Logger } from "../logger";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isTransient(e: any): boolean {
  const m = String(e?.message ?? e);
  return (
    m.includes("429") ||
    m.includes("Too Many Requests") ||
    m.includes("Too many requests") ||
    m.includes("blockhash") ||
    m.includes("Blockhash not found") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("ECONNRESET") ||
    m.includes("socket hang up") ||
    m.includes("502") ||
    m.includes("503")
  );
}

export async function withRetry<T>(
  what: string,
  fn: () => Promise<T>,
  log: Logger,
  {
    attempts = 6,
    base = 1200,
    max = 20_000,
  }: { attempts?: number; base?: number; max?: number } = {}
): Promise<T> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      // A program error (AnchorError) is NOT transient: fail fast.
      if (e?.error?.errorCode || !isTransient(e)) throw e;
      const delay = Math.min(base * 2 ** (i - 1), max);
      log.warn(
        `${what}: transient RPC error, retry ${i}/${attempts} in ${delay}ms`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}
