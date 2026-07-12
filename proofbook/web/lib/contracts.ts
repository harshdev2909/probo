/**
 * The API's response contracts, re-exported as TYPES ONLY.
 *
 * `export type *` erases at compile time, so nothing from the server — not zod,
 * not a single byte — reaches the browser bundle. But the frontend and the API now
 * share one definition: if the API stops sending a field, this becomes a
 * TypeScript error at build time instead of `undefined` on a judge's screen.
 */
export type * from "../../api/src/contracts";
