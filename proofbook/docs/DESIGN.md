# ProofBook — Design System

**Direction:** broadcast terminal × match-programme editorial. Dark is the default
and primary theme ("stadium at night"). Data surfaces are dense and confident like
a trading terminal; narrative surfaces breathe like a good magazine. One art-deco
moment exists in the entire product: the gold proof seal.

**The language in one sentence:** *squares and quarter-circles; ink and bone; one
metal, earned.*

This adapts the FIFA 26 identity's **principles** — a strict modular grid built
from two primitives, restraint as institutional confidence, one constant anchor
object, rigid type against sweeping geometry — while using **zero** of its assets.
No emblem, no FWC typeface, no trophy, no wordmarks, no flags. The mark, seal,
motif and palette are original. Nations are 3-letter codes + a color chip.

The tension that drives every screen: **rigid cryptography / fluid live match** —
blocky wide type and hard squares against quarter-circle arcs and live motion. The
product IS this contrast (deterministic settlement of an unpredictable game), so
the visual language is the thesis restated.

---

## 1. The two primitives

Everything decorative in ProofBook is built from a **square** (the ledger cell —
rigid, cryptographic) or a **quarter-circle** (the ball's arc — fluid, live).
Cards, dividers, loaders, empty states, the mark, the seal, section transitions:
same two shapes, no exceptions. If an ornament can't be built from them, it
doesn't ship.

- **The signature corner:** panels are square except **one quarter-circle corner,
  always bottom-left** (`border-radius: 0 0 0 24px`). The arc always lands the
  same way — that consistency is what makes it read as identity, not styling.
- **The mark:** a 2×2 grid — ledger square (bone), two opposing quarter-circles
  (the ball leaving the book), and one brass square (the sealed proof). The seal
  is the mark engraved in a notary ring; it is the persistent anchor object on
  every surface (nav, receipts, OG images, favicons, loading states).

## 2. Color — `web/app/globals.css` is the source of truth

**Ink ramp** (9 steps, hand-tuned, slightly warm — never `#000`/`#FFF`):

| token | hex | role |
|---|---|---|
| ink-950 | `#0f0d0a` | page |
| ink-900 | `#16130f` | panel |
| ink-800 | `#211d17` | raised / hover |
| ink-700 | `#332c23` | strong border / pressed |
| ink-500 | `#6f6455` | muted text (large only) |
| ink-400 | `#968878` | secondary text |
| ink-300 | `#b6a996` | labels / tertiary |
| ink-200 | `#d8cfc0` | body text |
| ink-100 | `#f2ede3` | bone — primary text, "paper" |

**Brass** (`400 #dcbc7a · 500 #c2a05a · 600 #96762f · 950 #241c0d`) is the only
metal and it is **earned**: verified proofs, claimable winnings, the mark/seal.
It never decorates buttons, links, or gradients. If brass appears, cryptography
happened or money is yours.

**Semantics:** pitch green (`#6cb87e`) = live, only live. Oxide red (`#d08575`)
= loss/error. Amber (`#d6a44e`) = pending/awaiting-root. Host chips
(CAN `#b0413e` / MEX `#3e7a54` / USA `#3e5e8c`) appear **only** as 12px chips
beside nation codes.

**Elevation is background, never shadow.** Hairlines (`rgba(bone, .09/.16)`) do
the separating; the ink ramp does the layering. No glows, no glassmorphism.

## 3. Type — two typefaces, one system

- **Archivo (variable: wght + wdth, self-hosted via next/font).**
  - `.display` — wdth 125 / wght 800 / uppercase / lh 0.94: headlines & scores.
  - `.display-condensed` — wdth 78 / wght 700: fixtures, tickers, dense headers.
  - Normal width, 400–600: all UI text. (No Inter anywhere.)
- **IBM Plex Mono 400/500/600** — every hash, signature, PDA, stat key, odds and
  live numeral. Cryptographic data is *always* mono: the terminal voice is the
  provenance cue.
- **Scale:** 12 / 13 / 14 / 16 / 20 / 25 / 31 / 39 / 61 / 76. `.label` =
  11px / 600 / +0.14em caps. **All numerals tabular** (`.tnum`).

## 4. Space, radius, rhythm

4pt base grid, 8pt rhythm for components. Data surfaces run compact
(8–12px paddings); editorial surfaces run generous (96px+ section gaps).
Radius family (all bottom-left): `2px` chips · `8px` controls · `24px` panels ·
`48px` hero artifacts. Uniform radius on everything is forbidden — radius follows
component role.

## 5. Motion — weight and momentum, never bounce

| token | curve | use |
|---|---|---|
| `--ease-settle` | `cubic-bezier(.22,1,.36,1)` | data ticks, entrances — a ball coming to rest |
| `--ease-carry` | `cubic-bezier(.65,0,.35,1)` | layout moves, loaders |
| `--ease-snap` | `cubic-bezier(.32,.72,0,1)` | hovers, presses |

Durations: 120ms micro · 240ms standard · 420ms entrance · 700ms hero.
Rules: every motion has a functional reason; entrances slower than exits; **one
hero move per view** (the seal engrave-in is the only 700ms animation in the
app); scores/odds tick with `tick-up`; live markets breathe via `live-dot`
(opacity, not glow). `prefers-reduced-motion` collapses everything to instant.

## 6. Voice

Confident, declarative, slightly dry. "Every payout proven, not trusted." /
"No one clicks resolve." / "This outcome is mathematics, not testimony."
Never hedging, never emoji-decorated, never "cutting-edge".

## 7. Anti-slop contract (enforced)

No purple/blue gradient heroes · no neon/glow · no floating blobs · no
glassmorphism · no emoji feature sections · no stock/AI imagery · no
centered-everything · no default-Inter-on-slate · no decorative animation ·
no `#000`/`#FFF` · no `transition: all` · asymmetry and editorial hierarchy by
default · designed empty/loading/error/404 states built from the two primitives.

## 8. Artifacts

- Tokens: `web/app/globals.css` (CSS vars + Tailwind v4 `@theme`)
- Identity: `web/components/Mark.tsx`, `web/components/Seal.tsx`
- The artifact: `web/components/Receipt.tsx` (bone "paper" — its print-constants
  are deliberately theme-independent)
- Living reference: **`/styleguide`** route — every token, component and state.
