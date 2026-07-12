// Each instruction module defines a `handler` fn; they collide harmlessly under
// the glob re-exports below (we always call handlers by full module path).
#![allow(ambiguous_glob_reexports)]

pub mod initialize_market;
pub mod place_bet;
pub mod lock_market;
pub mod settle_market;
pub mod claim_winnings;
pub mod cancel_market;
pub mod claim_refund;
pub mod withdraw_fees;

// Glob re-export so the `#[program]` macro can resolve each instruction's
// `Accounts` context struct and its derive-generated helper modules
// (`__client_accounts_*`) at the crate root. Each module also defines a
// `handler` fn; those collide under glob and are simply not re-exported by bare
// name (we always call them by full module path from `lib.rs`), which is fine.
pub use cancel_market::*;
pub use claim_refund::*;
pub use claim_winnings::*;
pub use initialize_market::*;
pub use lock_market::*;
pub use place_bet::*;
pub use settle_market::*;
pub use withdraw_fees::*;
