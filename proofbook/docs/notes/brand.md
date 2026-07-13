# Brand — ProofBook

_Status: defined (authored from the product brief; see `DESIGN.md` for the full system)_

- **Direction:** broadcast terminal × match-programme editorial; dark-first
  ("stadium at night"); squares + quarter-circles as the only decorative primitives.
- **Palette:** warm ink→bone 9-step neutral ramp (`#0f0d0a` → `#f2ede3`); single
  brass accent (`#c2a05a` family) reserved for verified proofs/winnings/the mark;
  semantics: pitch `#6cb87e` (live), oxide `#d08575` (loss), amber `#d6a44e`
  (pending); host-nation chips only (CAN/MEX/USA). Never `#000`/`#FFF`.
- **Typography:** Archivo variable (wdth 125/800 display, normal-width UI) +
  IBM Plex Mono for all cryptographic data and numerals (tabular). No Inter.
- **Radius:** 2/8/24/48px, always bottom-left corner only.
- **Motion:** settle/carry/snap cubic-beziers, 120/240/420/700ms, no bounce.
- **Voice:** confident, declarative, dry. "Proven, not trusted."

Tokens live in `web/app/globals.css`; the full system is documented in
`DESIGN.md`. Treat both as the source of truth for any UI work in this repo.
(The `/styleguide` route was retired from the shipped site; recover it from git
history if it is ever needed again.)
