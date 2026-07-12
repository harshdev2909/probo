/**
 * Loading a Solana keypair from an environment variable — defensively.
 *
 * This exists because a strict `JSON.parse` crash-looped the API in production.
 * Deploy platforms and shells mangle secrets in mundane ways: a trailing newline,
 * a stray character after the closing bracket, quotes wrapped around the whole
 * value, `\n` escapes from a copy-paste. None of those change the KEY — they are
 * transport noise — and none of them should take a service down.
 *
 * So: be liberal about the wrapper, strict about the key itself. A 64-byte secret
 * is a 64-byte secret; anything else fails with a message that says what was
 * actually wrong, instead of `Unexpected non-whitespace character at position 232`.
 */
import { Keypair } from "@solana/web3.js";

export class KeyError extends Error {}

/** Accepts a JSON byte array or a base58 secret key, however the platform mangled it. */
export function keypairFromSecret(raw: string, label = "secret key"): Keypair {
  let v = raw.trim();

  // Platforms and copy-paste love to wrap values in quotes.
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }

  let bytes: Uint8Array;

  if (v.startsWith("[")) {
    // Take exactly the first array and ignore whatever follows it. A trailing
    // character after `]` is what killed the API — the key itself was fine.
    const end = v.indexOf("]");
    if (end === -1) {
      throw new KeyError(`${label}: starts with "[" but has no closing "]".`);
    }
    const arr = v.slice(0, end + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(arr);
    } catch (e) {
      throw new KeyError(
        `${label}: looks like a byte array but is not valid JSON (${(e as Error).message}).`
      );
    }
    if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== "number")) {
      throw new KeyError(`${label}: expected an array of numbers.`);
    }
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    // base58
    const cleaned = v.replace(/\s+/g, "");
    try {
      const bs58 = require("bs58");
      const decode = bs58.default?.decode ?? bs58.decode;
      bytes = Uint8Array.from(decode(cleaned));
    } catch {
      throw new KeyError(
        `${label}: not a JSON byte array (starts with "[") and not valid base58.`
      );
    }
  }

  // Strict from here on. A wrong-length key is a real error, not transport noise.
  if (bytes.length !== 64) {
    throw new KeyError(
      `${label}: expected 64 bytes, got ${bytes.length}. ` +
        `A Solana secret key is 64 bytes — 32 is a seed or a PUBLIC key, not a secret key.`
    );
  }

  try {
    return Keypair.fromSecretKey(bytes);
  } catch (e) {
    throw new KeyError(`${label}: 64 bytes, but not a valid Solana keypair.`);
  }
}
