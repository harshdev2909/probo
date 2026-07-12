/**
 * The API's response contracts, as TYPES.
 *
 * This points at `shared/contracts.ts`, which has ZERO imports. It deliberately
 * does NOT point at `api/src/contracts.ts`: that file imports zod, and Node
 * resolves an import by walking up from the importing file — so from `api/src/` it
 * searches `api/node_modules` and the repo root, never `web/node_modules`. With
 * Vercel's Root Directory set to `web/`, zod is unreachable there and the build
 * fails. Types erase at compile time; a runtime library does not.
 */
export type * from "../../shared/contracts";
