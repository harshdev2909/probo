# Coverage matrix — what we can settle with a REAL TxLINE proof

_Generated 2026-07-12T05:14:01.465Z · today = epoch day 20646 · TxLINE devnet, free World Cup tier._

## Headline

| | count |
|---|---|
| Fixtures returned by TxLINE (competition 72) | **104** |
| ✅ **Settleable with a REAL proof** | **76** |
| ⚪️ No proof obtainable (outside retention) | 26 |
| 🟠 Proof but no on-chain root | 0 |
| 🕒 Not finished (upcoming / in play) | 2 |

## What we learned probing the live API

**1. Fixture list.** `GET /fixtures/snapshot?competitionId=72&startEpochDay=20600` returns
**104 fixtures**. Without `startEpochDay` the API returns only the immediate window (2).
Each carries `FixtureId, StartTime, Participant1/2Id, Participant1/2 (names), CompetitionId` —
so team identity comes straight from TxLINE, no guessing.

**2. Score retention is ~23 days.** Fixtures older than that return **zero** score records
(`/scores/snapshot/{id}` → empty). Their results are therefore **not provable** and we mark
them honestly rather than fabricate a receipt.

**3. The `statusId=100` (game_finalised) record is only retained ~10 days.** Older-but-retained
fixtures no longer carry it. **However** they still carry a terminal *match-ended* record:

| statusId | meaning | usable as the final? |
|---|---|---|
| `100` | game_finalised (method-agnostic) | yes — most authoritative |
| `13` | ended after penalties | yes |
| `10` | ended after extra time | yes |
| `5` | ended in regulation | yes |

We take the **highest-authority terminal record available** and prove *its* goal stats. This is
what unlocks the bulk of the backfill: a `statusId=5` record proves the full-time score with a
real Merkle proof at `period=5`.

**4. The snapshot's `Score` object is sampled and unreliable** (it often shows `0-0` for a match
the proof shows as `0-2`). We therefore settle **only on the proven stat values**, never on the
feed's score field.

**5. On-chain daily roots persist.** The oracle's `daily_scores_roots` PDA exists on devnet for
every epoch day we could fetch a proof for (verified back to epoch day 20624).

## Honest gaps

26 fixtures cannot be settled because TxLINE no longer retains their score data.
We show the fixture and its real-world result where known, but **with no Proof Receipt** and a
clear `Historical — proof outside TxLINE retention` marker. A fabricated receipt would destroy
the product's entire thesis, so we do not produce one.

## Full matrix

| fixture | stage | date | teams | proven score | terminal record | period | seq | verdict |
|---|---|---|---|---|---|---|---|---|
| 17588227 | Group | 2026-06-11 | Mexico v South Africa | — | — | — | — | ⚪️ no proof (honest gap) |
| 17926696 | Group | 2026-06-12 | South Korea v Czech Republic | — | — | — | — | ⚪️ no proof (honest gap) |
| 17926604 | Group | 2026-06-12 | Canada v Bosnia & Herzegovina | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588394 | Group | 2026-06-12 | USA v Paraguay | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588396 | Group | 2026-06-13 | USA v Paraguay | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588308 | Group | 2026-06-13 | Qatar v Switzerland | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588386 | Group | 2026-06-13 | Brazil v Morocco | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588316 | Group | 2026-06-14 | Haiti v Scotland | — | — | — | — | ⚪️ no proof (honest gap) |
| 17926689 | Group | 2026-06-14 | Australia v Turkey | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588318 | Group | 2026-06-14 | Germany v Curacao | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588305 | Group | 2026-06-14 | Netherlands v Japan | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588239 | Group | 2026-06-14 | Ivory Coast v Ecuador | — | — | — | — | ⚪️ no proof (honest gap) |
| 17926553 | Group | 2026-06-15 | Sweden v Tunisia | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588403 | Group | 2026-06-15 | Spain v Cape Verde | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588230 | Group | 2026-06-15 | Belgium v Egypt | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588311 | Group | 2026-06-15 | Saudi Arabia v Uruguay | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588241 | Group | 2026-06-16 | Iran v New Zealand | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588306 | Group | 2026-06-16 | France v Senegal | — | — | — | — | ⚪️ no proof (honest gap) |
| 17926828 | Group | 2026-06-16 | Iraq v Norway | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588322 | Group | 2026-06-17 | Argentina v Algeria | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588405 | Group | 2026-06-17 | Austria v Jordan | — | — | — | — | ⚪️ no proof (honest gap) |
| 17926703 | Group | 2026-06-17 | Portugal v Congo DR | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588228 | Group | 2026-06-17 | England v Croatia | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588406 | Group | 2026-06-17 | Ghana v Panama | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588399 | Group | 2026-06-18 | Uzbekistan v Colombia | — | — | — | — | ⚪️ no proof (honest gap) |
| 17926765 | Group | 2026-06-18 | Czech Republic v South Africa | **1–1** | full time | 5 | 972 | ✅ real proof |
| 17926603 | Group | 2026-06-18 | Switzerland v Bosnia & Herzegovina | **4–1** | full time | 5 | 1060 | ✅ real proof |
| 17588238 | Group | 2026-06-18 | Canada v Qatar | **6–0** | full time | 5 | 1162 | ✅ real proof |
| 17588223 | Group | 2026-06-19 | Mexico v South Korea | **1–0** | full time | 5 | 1023 | ✅ real proof |
| 17588388 | Group | 2026-06-19 | USA v Australia | **2–0** | full time | 5 | 1032 | ✅ real proof |
| 17588397 | Group | 2026-06-19 | Scotland v Morocco | **0–1** | full time | 5 | 881 | ✅ real proof |
| 17588317 | Group | 2026-06-20 | Brazil v Haiti | **3–0** | full time | 5 | 1044 | ✅ real proof |
| 17926688 | Group | 2026-06-20 | Turkey v Paraguay | **0–1** | full time | 5 | 1173 | ✅ real proof |
| 17926687 | Group | 2026-06-20 | Netherlands v Sweden | **5–1** | full time | 5 | 901 | ✅ real proof |
| 17588240 | Group | 2026-06-20 | Germany v Ivory Coast | **2–1** | full time | 5 | 1070 | ✅ real proof |
| 17588320 | Group | 2026-06-21 | Ecuador v Curacao | **0–0** | full time | 5 | 1112 | ✅ real proof |
| 17588310 | Group | 2026-06-21 | Tunisia v Japan | **0–4** | full time | 5 | 1028 | ✅ real proof |
| 17588232 | Group | 2026-06-21 | Spain v Saudi Arabia | **5–0** | full time | 5 | 965 | ✅ real proof |
| 17588390 | Group | 2026-06-21 | Belgium v Iran | **0–0** | full time | 5 | 1163 | ✅ real proof |
| 17588235 | Group | 2026-06-21 | Uruguay v Cape Verde | **2–2** | full time | 5 | 1002 | ✅ real proof |
| 17588242 | Group | 2026-06-22 | New Zealand v Egypt | **1–3** | full time | 5 | 1020 | ✅ real proof |
| 17588389 | Group | 2026-06-22 | Argentina v Austria | **2–0** | full time | 5 | 904 | ✅ real proof |
| 17926647 | Group | 2026-06-22 | France v Iraq | **3–0** | full time | 5 | 1034 | ✅ real proof |
| 17588313 | Group | 2026-06-23 | Norway v Senegal | **3–2** | full time | 5 | 1063 | ✅ real proof |
| 17588244 | Group | 2026-06-23 | Jordan v Algeria | **1–2** | full time | 5 | 1032 | ✅ real proof |
| 17588231 | Group | 2026-06-23 | Portugal v Uzbekistan | **5–0** | full time | 5 | 1163 | ✅ real proof |
| 17588324 | Group | 2026-06-23 | England v Ghana | **0–0** | full time | 5 | 1018 | ✅ real proof |
| 17588401 | Group | 2026-06-23 | Panama v Croatia | **0–1** | full time | 5 | 864 | ✅ real proof |
| 17926615 | Group | 2026-06-24 | Colombia v Congo DR | **1–0** | full time | 5 | 951 | ✅ real proof |
| 17588303 | Group | 2026-06-24 | Switzerland v Canada | **2–1** | full time | 5 | 1147 | ✅ real proof |
| 17926766 | Group | 2026-06-24 | Bosnia & Herzegovina v Qatar | **3–1** | full time | 5 | 878 | ✅ real proof |
| 17588319 | Group | 2026-06-24 | Morocco v Haiti | **4–2** | full time | 5 | 1101 | ✅ real proof |
| 17588398 | Group | 2026-06-24 | Scotland v Brazil | **0–3** | full time | 5 | 981 | ✅ real proof |
| 17588395 | Group | 2026-06-25 | South Africa v South Korea | **1–0** | full time | 5 | 986 | ✅ real proof |
| 17926764 | Group | 2026-06-25 | Czech Republic v Mexico | **0–3** | full time | 5 | 967 | ✅ real proof |
| 17588302 | Group | 2026-06-25 | Ecuador v Germany | **2–1** | full time | 5 | 982 | ✅ real proof |
| 17588321 | Group | 2026-06-25 | Curacao v Ivory Coast | **0–2** | full time | 5 | 1135 | ✅ real proof |
| 17588400 | Group | 2026-06-25 | Tunisia v Switzerland | — | — | — | — | ⚪️ no proof (honest gap) |
| 17588236 | Group | 2026-06-25 | Tunisia v Netherlands | **1–3** | full time | 5 | 1001 | ✅ real proof |
| 17926686 | Group | 2026-06-25 | Japan v Sweden | **1–1** | full time | 5 | 882 | ✅ real proof |
| 17588229 | Group | 2026-06-26 | Paraguay v Australia | **0–0** | full time | 5 | 885 | ✅ real proof |
| 17926593 | Group | 2026-06-26 | Turkey v USA | **3–2** | full time | 5 | 1095 | ✅ real proof |
| 17588234 | Group | 2026-06-26 | Norway v France | **1–4** | full time | 5 | 1090 | ✅ real proof |
| 17926740 | Group | 2026-06-26 | Senegal v Iraq | **5–0** | full time | 5 | 1167 | ✅ real proof |
| 17588314 | Group | 2026-06-27 | Cape Verde v Saudi Arabia | **0–0** | full time | 5 | 1071 | ✅ real proof |
| 17588404 | Group | 2026-06-27 | Uruguay v Spain | **0–1** | full time | 5 | 881 | ✅ real proof |
| 17588309 | Group | 2026-06-27 | Egypt v Iran | **1–1** | full time | 5 | 1139 | ✅ real proof |
| 17588323 | Group | 2026-06-27 | New Zealand v Belgium | **1–5** | full time | 5 | 942 | ✅ real proof |
| 17588245 | Group | 2026-06-27 | Croatia v Ghana | **2–1** | full time | 5 | 987 | ✅ real proof |
| 17588402 | Group | 2026-06-27 | Panama v England | **0–2** | full time | 5 | 1179 | ✅ real proof |
| 17588391 | Group | 2026-06-27 | Colombia v Portugal | **0–0** | full time | 5 | 1084 | ✅ real proof |
| 17926704 | Group | 2026-06-27 | Congo DR v Uzbekistan | **3–1** | full time | 5 | 1113 | ✅ real proof |
| 17588325 | R32 | 2026-06-28 | Jordan v Argentina | **1–3** | full time | 5 | 979 | ✅ real proof |
| 17588326 | R32 | 2026-06-28 | Algeria v Austria | **3–3** | full time | 5 | 982 | ✅ real proof |
| 18167317 | R32 | 2026-06-28 | South Africa v Canada | **0–1** | full time | 5 | 958 | ✅ real proof |
| 18172469 | R32 | 2026-06-29 | Brazil v Japan | **2–1** | full time | 5 | 986 | ✅ real proof |
| 18175983 | R32 | 2026-06-29 | Germany v Paraguay | **1–1** | after penalties | 13 | 1581 | ✅ real proof |
| 18172280 | R32 | 2026-06-30 | Netherlands v Morocco | **1–1** | after penalties | 13 | 1425 | ✅ real proof |
| 18175397 | R32 | 2026-06-30 | Ivory Coast v Norway | **1–2** | full time | 5 | 1058 | ✅ real proof |
| 18175981 | R32 | 2026-06-30 | France v Sweden | **3–0** | full time | 5 | 992 | ✅ real proof |
| 18179759 | R32 | 2026-07-01 | Mexico v Ecuador | **2–0** | full time | 5 | 883 | ✅ real proof |
| 18179764 | R32 | 2026-07-01 | England v Congo DR | **2–1** | full time | 5 | 1163 | ✅ real proof |
| 18179550 | R32 | 2026-07-01 | Belgium v Senegal | **3–2** | after extra time | 10 | 1314 | ✅ real proof |
| 18172379 | R32 | 2026-07-02 | USA v Bosnia & Herzegovina | **2–0** | full time | 5 | 1056 | ✅ real proof |
| 18179551 | R32 | 2026-07-02 | Spain v Austria | **3–0** | full time | 5 | 1040 | ✅ real proof |
| 18179763 | R32 | 2026-07-02 | Portugal v Croatia | **2–2** | full time | 5 | 1072 | ✅ real proof |
| 18179552 | R32 | 2026-07-03 | Switzerland v Algeria | **2–0** | full time | 5 | 1069 | ✅ real proof |
| 18176123 | R32 | 2026-07-03 | Australia v Egypt | **1–1** | game_finalised | 100 | 1353 | ✅ real proof |
| 18175918 | R32 | 2026-07-03 | Argentina v Cape Verde | **3–2** | game_finalised | 100 | 1242 | ✅ real proof |
| 18179549 | R16 | 2026-07-04 | Colombia v Ghana | **1–0** | game_finalised | 100 | 1038 | ✅ real proof |
| 18185036 | R16 | 2026-07-04 | Canada v Morocco | **0–3** | game_finalised | 100 | 1122 | ✅ real proof |
| 18188721 | R16 | 2026-07-04 | Paraguay v France | **0–1** | game_finalised | 100 | 965 | ✅ real proof |
| 18187298 | R16 | 2026-07-05 | Brazil v Norway | **1–2** | game_finalised | 100 | 1101 | ✅ real proof |
| 18192996 | R16 | 2026-07-06 | Mexico v England | **2–3** | game_finalised | 100 | 1047 | ✅ real proof |
| 18198205 | R16 | 2026-07-06 | Portugal v Spain | **0–1** | game_finalised | 100 | 992 | ✅ real proof |
| 18193785 | R16 | 2026-07-07 | USA v Belgium | **1–4** | game_finalised | 100 | 1123 | ✅ real proof |
| 18202701 | R16 | 2026-07-07 | Argentina v Egypt | **3–2** | game_finalised | 100 | 1045 | ✅ real proof |
| 18202783 | R16 | 2026-07-07 | Switzerland v Colombia | **0–0** | game_finalised | 100 | 1352 | ✅ real proof |
| 18209181 | QF | 2026-07-09 | France v Morocco | **2–0** | game_finalised | 100 | 1114 | ✅ real proof |
| 18218149 | QF | 2026-07-10 | Spain v Belgium | **2–1** | game_finalised | 100 | 1087 | ✅ real proof |
| 18213979 | QF | 2026-07-11 | Norway v England | **1–2** | game_finalised | 100 | 1184 | ✅ real proof |
| 18222446 | SF | 2026-07-12 | Argentina v Switzerland | **3–1** | game_finalised | 100 | 1306 | ✅ real proof |
| 18237038 | SF | 2026-07-14 | France v Spain | — | — | — | — | 🕒 upcoming |
| 18241006 | SF | 2026-07-15 | England v Argentina | — | — | — | — | 🕒 upcoming |

<!-- SETTLEMENT REPORT -->

## Settlement report (2026-07-12T05:22:10.484Z)

**76 of 104 World Cup fixtures settled on devnet with a REAL TxLINE proof.**

| | count |
|---|---|
| ✅ Settled this run | 0 |
| ✅ Already settled (idempotent skip) | 76 |
| ❌ Failed | 0 |
| ⚪️ No proof obtainable (honest gap) | 26 |
| 🕒 Upcoming | 2 |

### Settled with real proofs

| fixture | stage | teams | proven score | outcome | settle tx |
|---|---|---|---|---|---|
| 17926765 | Group | CZE v RSA | 1-1 | Draw | `4kgXUq6rCt3G6F4TeFzTuEM3PyhpKrW6M7fmbiUirWw5uGJtwArbP4W27HChomTZZ5b5eFdG9FJpk6Z3RK5iPy1e` |
| 17926603 | Group | SUI v BIH | 4-1 | Home | `2iGXn1WV2svuQuKwK4uzphZ1mZNLrLvVic7UEB7TTvAHcnUNeZxMN3WGVapRy63pvZ2sVsbHwqa8ZTH6aaJYpHYT` |
| 17588238 | Group | CAN v QAT | 6-0 | Home | `3WPc96icLnCqumwcWBJN8a8s4Ru6AocX24vPPAJ1ury9HsRchmW3Xv4QWCw5FFs1yqQ3qBjm6oHD9LGzxURJtBnn` |
| 17588223 | Group | MEX v KOR | 1-0 | Home | `4HFfJZvgLUDMVDQnkkWmEwiYuwenub34YE2yfRCknxtcuJm5DuXqnhGi2HZKoQ2w5MuBtoKpXMaFt9KHjwwUf8rE` |
| 17588388 | Group | USA v AUS | 2-0 | Home | `FqVy7tuhXeaThBQk7BuVB6SNiyCSXieffDLsrfx1Tz8j3uzxkfe8kQS1DeAXB9B1vZrXEWskhHYTQ3mbJkajwtg` |
| 17588397 | Group | SCO v MAR | 0-1 | Away | `56LGvFhtDkWuzt2maE8hFk1qnqmiNLZGWXvQYZrdU1MUmRH35UySCgexG1Mvz7cWDGvdWDwSu59hNYWFPoHYR4ig` |
| 17588317 | Group | BRA v HAI | 3-0 | Home | `4rGfEAwAPQTHDiQ7bYcLPmNEYXX6zLTT5bTKygoj6JaiS9DFsqayvLHXPKQCb4QpVuZKRB2nZmVQxvFwpmoXD7n4` |
| 17926688 | Group | TUR v PAR | 0-1 | Away | `4kiSVanE8mcnL1H1ifGa4VBLSsUS5ujE4M9cCo4YMN19UfVkcdWmpxfrEzRNFh5EMLFFYSJJ1drtiaseqrbMY369` |
| 17926687 | Group | NED v SWE | 5-1 | Home | `MGTdVkFB59h6Eh8u9yAYcSaCkTNZqTmJyh5gF78FhAfwVJWdrvtWKCiem7AhsBC6e8cp4cP2BBtodfwe5WinizU` |
| 17588240 | Group | GER v CIV | 2-1 | Home | `61bJwQraZzG6822oeXFUnYaD2TSZhtUdkhs2gfmSapLVMwiNveyviYzh8yw5s9p4LmptFMiG7RbSiw1waWPHNSCy` |
| 17588320 | Group | ECU v CUW | 0-0 | Draw | `5K9gVfifV2JzNZLgWVQ3icaTpTsqWyJwuAx2drepd5w9Rz9sHB8fGZU4ryTmhNkHeXyd7tQPRLTfBufhQQtPsn2p` |
| 17588310 | Group | TUN v JPN | 0-4 | Away | `3C87jugnndt9w1BvXDUvKhbouZcMA7NLXEAUrLSsP5hiqwj3FvrxqnZXPR8hYXJP6xLsrFw1vTNJ1dxn2GbZkdHY` |
| 17588232 | Group | ESP v KSA | 5-0 | Home | `2Vbtf1P83NW2UqBzFjPrao683P3ZVBChbbACqtCyS8ULUjPfWT7kFZR1F3o3vdRWzxKdHUmReZSxkNrKvt8J8NnU` |
| 17588390 | Group | BEL v IRN | 0-0 | Draw | `5QA6PKRwjacEbiuTV9tsxPpnEdkGyuVJPBpzDqf7CkyCWF6HRBbQW6LUzMhRXpi1Fr1Q1wvBYvfzcuXjssNne8Y` |
| 17588235 | Group | URU v CPV | 2-2 | Draw | `3tUpSZzZkHnLrbg4wJgfbNxA9n8uhDdT2L2GDJ3cfeBibxAHCGiEX5ajo19gBLcrF7aQ6APnTBjn9xoJmGhQg3eU` |
| 17588242 | Group | NZL v EGY | 1-3 | Away | `CsTmKcNaAAL7iGs4op3EBcSbFSvUft24nEFG6K5cTv5kgCpFAFpB8dZrRshrTse3Lc5Y4nZEnAmfRH5h2EW5h81` |
| 17588389 | Group | ARG v AUT | 2-0 | Home | `SJ5AuxXp8RE3KmUUgG1DjcgfJtJQRKi3R1dh1UD9TBo8upTJec44wrZbkVoSmpnFjeRzkEQQ8yQQGawUua9uqCF` |
| 17926647 | Group | FRA v IRQ | 3-0 | Home | `4JJnnjroF7mtf5Jcw5hGNfN2FRDcJ4U7RSRczbRFYhvgv8cqMQhio6yfQksobPmx75h4hP4HREEHg9PrwcaginLr` |
| 17588313 | Group | NOR v SEN | 3-2 | Home | `3QWC14yz6ZNEoMNuyF5s1sjmwMfzhaKBt6ZGjgQUv6G1wbMv5da67xsBcg8aVLkU8a2K2W4YCNxnsZtvxvtC5GXu` |
| 17588244 | Group | JOR v ALG | 1-2 | Away | `2GnkAKwBZaXq4LiVqEK39wGxtrR9Uh9nP9DUVPorU4NQZvgDTDjK8txrWTagDtN2e3t1X82GHHmLo9A9Fz5K9aKw` |
| 17588231 | Group | POR v UZB | 5-0 | Home | `eRxKEKJ6UWHPqNQQqxnUJXk2tNqXLDQfK1ungs2GbVVodhfQKwPz7mx5NLzB5NgEmTBvKhhqB88CgH2BKj8L9bA` |
| 17588324 | Group | ENG v GHA | 0-0 | Draw | `2eo7n4czPANy2bca32eVafNiRKyXD9BPfpfwYhCoVrv2NNw3yYKQWCv7fWeXobtXLVnL5oruzfKxFhjE2kQYPHpb` |
| 17588401 | Group | PAN v CRO | 0-1 | Away | `QGXGDTQsWtwN6mjbWYDHh14mcTXNfE1dHF5DkYsAL4wx1KjZFm9GDX5Tsb46aa13izKt5q57unc9omi4a5x6xbY` |
| 17926615 | Group | COL v COD | 1-0 | Home | `2opnpwN3tHMpqhheWsBGLphN3AwNG6z8YMDL6wiJKk24PYVehNuuCmko2ZqfoP9T8VBpq5C4K1yHM8D6aRdpq8MD` |
| 17588303 | Group | SUI v CAN | 2-1 | Home | `4dVA4vtg5qUreokHMDbDT6TxdutaoJX1uK67irLGeMZ2g4B38vJAwUuGmT2ZL41LLXQqbpzy5KEG5u3buZCo8Yb` |
| 17926766 | Group | BIH v QAT | 3-1 | Home | `3LD715f9qprneYxv12qE8efzixDhHfnKKccC4GTn62bJzjkY8VX9UPyzZZF6LUnurBDNEYZP2iYGy6FPuCVna1ba` |
| 17588319 | Group | MAR v HAI | 4-2 | Home | `pokHUmYynvvAKrUQfYqRVJJ9mMod2tf16oPZWZLdwuEpFnUfCqxY3KNm1ytPdyXbh8mNt97Qj9Nopxp6wFY9wVp` |
| 17588398 | Group | SCO v BRA | 0-3 | Away | `P88666Wmm2cCCfLkMYBZJTE95zR9DBswFroTbm2YcnhVkTR3AKoPw4QhQ4iLTssdpsB8UKiYtEpDaqwvvzFdFFB` |
| 17588395 | Group | RSA v KOR | 1-0 | Home | `KcnM3Jr76Lvy3i9feLUgK78j79jAzokHXVCBNybNBjNTkhikn1yay4sXkG4XEGMJ7mBqXM6vFDeFtmuzuAst61Z` |
| 17926764 | Group | CZE v MEX | 0-3 | Away | `4s2tNjMqzfFev5h6s8nJHvWmuNkyXTekVwwFz2EvzwAyYXgkoTMtX6TkzpELLLZp2yhou7g9Wf9j4zvdAEScWuxi` |
| 17588302 | Group | ECU v GER | 2-1 | Home | `2q43dGj9aHEF5LiCi341jx7o2sW7W2bDvBXXPX3cE9X6mVmkF9kWUJSmyTGNXtCb83GNrityGStBpFDUj2BymTsm` |
| 17588321 | Group | CUW v CIV | 0-2 | Away | `5C1zRPi79E4FfumYyV3jVoASa8jYR7o7zhR8DP8sKE3Ryao7He1DzoQf8ruGpQRuhnJgxwPQXQhii7xiKDrbEe5a` |
| 17588236 | Group | TUN v NED | 1-3 | Away | `3hwu2qCGWYGi3hmuPWgdY3yEzmCpBytJHPnTbd56Y82VYVvukPjENQzKUnPDcs9XJc1XRAgXdUMKLcDb1o6furgr` |
| 17926686 | Group | JPN v SWE | 1-1 | Draw | `2BKpewKaaaqvCuBYAzqL4yEV7SnCnJSZbRuZszX9H7vv7z1wyxvUVDfZLuMSnDChTtteknMNBo3AB2gDE9S8XhYU` |
| 17588229 | Group | PAR v AUS | 0-0 | Draw | `3P1owfvg11vS89UmzKtHSx1MqLvfCG6LpE1bfQXiQsCyc6CC7Tiu26rTvZHyGAWfiHArEPjQA6VdAr9aWk7xWxFj` |
| 17926593 | Group | TUR v USA | 3-2 | Home | `4meaoaoTnqUEnRs3RnrMGQFmKruvMjmMs9AFMWoD18k9iPHrKXyDTRyNGPmkNr6ATpjLbMkyzAMGPQQbcZPWVUWz` |
| 17588234 | Group | NOR v FRA | 1-4 | Away | `dE6435zPRGbeTJQNB1peg1TYT4SLTzMVZQck3YcBUktJbfryAy9PmELVt4WKvUXq3jbacmzbDHuVfVyyvW8HXis` |
| 17926740 | Group | SEN v IRQ | 5-0 | Home | `5AuxETbjKBtsZGiVK8UjX3us4fJcgxnzdCCZGdwA2giWZvavQgwB16biemZVrv5bS6RELhHg2KNde9hFkHSxw8AA` |
| 17588314 | Group | CPV v KSA | 0-0 | Draw | `4prUzKeLauuT3fJ4EaJUzoJjCkr71HuBsC5rxip2k3VnD6KvAW6Kh1rcAyFiYBk43BLJgb7NTKqbYWhWPnXxBKRD` |
| 17588404 | Group | URU v ESP | 0-1 | Away | `32fNargCheL51VLXaim1m93HEBRbqxNgrfgkkxWMXnrg37L1zrrwegw7BPwyK1ofXzPRPxRLssduzsb9B8FY4h7e` |
| 17588309 | Group | EGY v IRN | 1-1 | Draw | `3A6Tbc5L621JBKu3HZDiRjGBHEPgywV2ecd7YggRW8Zw8W2DiL5uUUZYMFrmKYinRUhvqpHYdov6WF4BJ4suNNvB` |
| 17588323 | Group | NZL v BEL | 1-5 | Away | `MZYcbxxzcpYQpScVYrfYE52oFXFukKpMjVeydWxy4mkAMqSsc1JB9jQbZ9okrbM6g5P1rWJRgeKzrxFjLB1cvAB` |
| 17588245 | Group | CRO v GHA | 2-1 | Home | `3nVWJuH3y9148HaHGHp9ZBfb7qEjwcRY1nxFVeJLDHPgE69r52GzDU9Whwe5NHxJsirqM5kXTXfshPwZnpdkzvdU` |
| 17588402 | Group | PAN v ENG | 0-2 | Away | `5JhLfbugDECUuSdCDDJ62cwQGAtVQq38Yh9GkQsUPcWeRXnr5KG7eecWqWd6UV24qfPSShV2r9AfN21B45mWbWu8` |
| 17588391 | Group | COL v POR | 0-0 | Draw | `64g2Bu3agPc152rvSSjbwWvDqmvANPsWtvKSxa4gfdGGLsYUWtyGLJrfFf77zShcT3QNBbwpoSvngkXRgDKW7xNE` |
| 17926704 | Group | COD v UZB | 3-1 | Home | `4aD35AwfQzytn9mKUZMyFE2n3KNU4X3EcXj76rgq6K5i2JtAWSTey5eY8XJjco1X69zgjtNRLh67988cLzRHurwE` |
| 17588325 | R32 | JOR v ARG | 1-3 | Away | `5vcHNkzeMuqQhoZFqoiHw9CHXSndKDWW4Ruu2tBvKotpzsB8uZxQXifVcEaUxNPPQhLcfJXRdCyW6Yx1kU5UGgtx` |
| 17588326 | R32 | ALG v AUT | 3-3 | Draw | `3XgnSYUvqmo46dftU8EkLpRRWo1pajH9UukeWGoHDiKZQk2Lks767E4LnRVJyWVEKcji6n7cy33T37cvvxVesQz9` |
| 18167317 | R32 | RSA v CAN | 0-1 | Away | `2zFByRce8ASE48kGD85GwQ4SPRtYReJ7tjJwUbqUsNQD1ZvFJZrDTrkhgHSQRLdtg64AZvKr1V84SuJcGeiHBUUo` |
| 18172469 | R32 | BRA v JPN | 2-1 | Home | `2sE5RDp7M51SrCqLQ9XF9jpX3aWVdZ9DKsU6R11eJDEMhvMXSsRm2ekWBRnara6d4LrsEwTDaUPbMMFpCd6raVAt` |
| 18175983 | R32 | GER v PAR | 1-1 | Draw | `5r4SUZ7huN75BWCUr8ro5V1uQ3Zi9ovwHpEXiBnZFFvhk9N6n2EHyB7YUitAzo8sq1AemqvsA6djB6Y2DSnjeyQj` |
| 18172280 | R32 | NED v MAR | 1-1 | Draw | `5E6WL6hywfW5zKWR933iVCwQrYKk7q2f9B9kkW5UDpjJDZtThZijsN6TQFvu6iSRWjdpfM3J4nEPJWv4yTWKfDf9` |
| 18175397 | R32 | CIV v NOR | 1-2 | Away | `VXoK3HDBpT2Dv1Ks4VXd4X6bLGmZYWfNYhnRdnpxsedwGTGf45HnKwrMKK3gCKyYobJBxNahai9qx5FJ8wM2eVH` |
| 18175981 | R32 | FRA v SWE | 3-0 | Home | `51A3JgTR5QJfv9xc66jntWaDyTJpdFGLdT7AuwjfKifgeRzB2W9tY2ArhVMCH6UBKuGrxhKbemipHcN54Yg3hvxY` |
| 18179759 | R32 | MEX v ECU | 2-0 | Home | `3TEBG4Lk7a7rjzd8xvELWXqMqpiiaBLShNmeHjAXKANTdPQEhaZu5adeyjefF1a3y6osJzpjioq1zy3eM5L31wGA` |
| 18179764 | R32 | ENG v COD | 2-1 | Home | `3jUmkmXF8Pm79YRzvm3Degxi9vn98oBrrv7hgC9QikGkMALwNHn87sbcWPWpro43bBZy72b8gbC4qv41CePYPzKD` |
| 18179550 | R32 | BEL v SEN | 3-2 | Home | `5KXK6BC27m8rnY92CcudhJvbDm2SiGkfNKX4wMgr9kMKLziCyrHoxTpwocE1zUizS1PqgyK9Stv9qG9rFYFxr2BG` |
| 18172379 | R32 | USA v BIH | 2-0 | Home | `4ZsroRbijH1a9ca6kf83ENkWQRsrFEBGCfTZ47qc6SQnAS5f5WkUBa9YmgN78xar6kxJWrF8RFCnKRKW3e63yY2m` |
| 18179551 | R32 | ESP v AUT | 3-0 | Home | `vGZk1D6AcZDurWTgqEcDuq9oCb6kXFioYt4D8T1dc6Yjcp7VBwoiCM2UTwXA6FhfgeSC9v8MHK4YQKnNy1ijSuR` |
| 18179763 | R32 | POR v CRO | 2-2 | Draw | `249Su5iwzxo7Yvn5GsaYDrDDb4Zfs9QLJaMekovh7rNXC7bEPNon9jx3vhxzPT8ZbCno6iNumEBLh6nH9dzcVSBM` |
| 18179552 | R32 | SUI v ALG | 2-0 | Home | `3hEgAA3g5u69TaLy7dW5ewnYCcoJXAVsKSzQFgAdcScjZeN6isNVZTQsFF4YxTpHwwjjd3AmPcNgk6eUng5kb9UG` |
| 18176123 | R32 | AUS v EGY | 1-1 | Draw | `5aqFJqkpV5GLpYi1KwNgVzYHwa4119EX9A872po8RnFaH1MoR5a7JhmwHtvQwJnZeiEXr1RLLNjBz8VtpDs2Q1H1` |
| 18175918 | R32 | ARG v CPV | 3-2 | Home | `qKwvQLVPD4m2Nx6nYejdYFmtP3MWHXChfzfwB1WRFqhMjEzZEtHz2ySv3AyczRaaTyWzGcZYptWgy6fGDK2sREP` |
| 18179549 | R16 | COL v GHA | 1-0 | Home | `3VFPToPuz11BL5rDV8j745bpZfD1Xwy7wz1iHs4hN3Y2qhnoS7TF95x2gB12YvG3VZVuQUjC2MVWzGjPticuyAKD` |
| 18185036 | R16 | CAN v MAR | 0-3 | Away | `2SvEwNDCDwxrZthdYecVvdt8SjqhVvibjWzrATpb3PyqzCudYCNseavqkAUHtaqT1HtuSzoyEuJ3ycv2JrBGL5oi` |
| 18188721 | R16 | PAR v FRA | 0-1 | Away | `4Ytr9DihwGesr9v3MTRHrbsJLnejPdUXViFd8y7hFBR6aPhtMmcsJyV7z3fTffSQ9nhJ31p5aaxjpbAwXwjCjR3u` |
| 18187298 | R16 | BRA v NOR | 1-2 | Away | `CtYPoAEELQBrn3RLfuPipYfiYuZujVz1eKjhqojLAAaYdFWPj5v2QMBPPDNRK2Ty4deEEbrTj9nGvX4yzo7XhUz` |
| 18192996 | R16 | MEX v ENG | 2-3 | Away | `5Mdgg15JrM6fJLdtv9hRKrQCFALDt7uVzqCuofCKHsRBp5f7iC6Xu9i4JgPgGWNXrnV8GG2i6PrzeV89o1rvVGaW` |
| 18198205 | R16 | POR v ESP | 0-1 | Away | `2GFYh4bQnZyYgn6wsFyJUYrZdEHW8kqBvDbPrhbNYZNxjZvrgmui7WHYkMGuQ4hk2fQiwM2T2TQdQdW1NgCPftFz` |
| 18193785 | R16 | USA v BEL | 1-4 | Away | `3cQnfQRq1bR2Vr6DfmTXhwvJ4Wtm2385Bd7iRGdenrJPPNVS3ydevUHadkdefMCNx398ZaKRPMUAXCqKGDZVBbR4` |
| 18202701 | R16 | ARG v EGY | 3-2 | Home | `4FUGqATLPmiHNhXcAjMDR1qSvuHi6aU3kKAU773ecrTx4MnafFpVZ5S3FotSomXow9ni9ux5w7Eou8tmqp9RVwSf` |
| 18202783 | R16 | SUI v COL | 0-0 | Draw | `4w28SHh2PPtkLsBprsbGgfNY9WCu2x9QH4bEx1s6a8qE885P8bF4u3CKzB5R9uvHDwxZgbyXFbEaKfn8NoT3ZWaV` |
| 18209181 | QF | FRA v MAR | 2-0 | Home | `hhP1giCE91rvP3fuF28WJdefcWTNqcjsDC6wuTMgb9zCDMbjatJZczyt1wPQv517uP6jD67NrYurbgpzZFHNQUb` |
| 18218149 | QF | ESP v BEL | 2-1 | Home | `5shUicsGfEW21wK7vvCeF5wv6tykHxuYE1ZZVCavrwdYS8b2FE8r9GVeEW31YMeRKmhRzdqtu2N4cYwV8nDsx1PN` |
| 18213979 | QF | NOR v ENG | 1-2 | Away | `WMwudioC6cDJrKqNUayyA7NFi3hPfmvUr8tBBsoSjE4eUk6BusC7uoF31UvnSzMQE7JyhREvpH6m5VXnPyALnUA` |
| 18222446 | SF | ARG v SUI | 3-1 | Home | `4LxgRds5Vj3isWidDFqEKrJWPKMT3PHjKwNPND9PYFv47AiZzTXuB277B6wvRr44BBBZYkKXvc6Znz8jsQTuxZti` |


### Honest gaps — outside TxLINE retention, so neither proof nor score

These 26 fixtures were played, but they fall outside the window in which TxLINE
still retains score records. So we have **no proof** — and because TxLINE is our only
source of truth, **no verified scoreline either**.

They appear in the product as real fixtures, with no receipt and no score. We could
fill the scoreline in from memory and mint a receipt to match; both would be fabricated,
and one invented receipt would falsify the only claim this product makes. So we show the
gap instead.

| fixture | stage | teams | reason |
|---|---|---|---|
| 17588227 | Group | MEX v RSA | outside TxLINE score retention (no records) |
| 17926696 | Group | KOR v CZE | outside TxLINE score retention (no records) |
| 17926604 | Group | CAN v BIH | outside TxLINE score retention (no records) |
| 17588394 | Group | USA v PAR | outside TxLINE score retention (no records) |
| 17588396 | Group | USA v PAR | outside TxLINE score retention (no records) |
| 17588308 | Group | QAT v SUI | outside TxLINE score retention (no records) |
| 17588386 | Group | BRA v MAR | outside TxLINE score retention (no records) |
| 17588316 | Group | HAI v SCO | outside TxLINE score retention (no records) |
| 17926689 | Group | AUS v TUR | outside TxLINE score retention (no records) |
| 17588318 | Group | GER v CUW | outside TxLINE score retention (no records) |
| 17588305 | Group | NED v JPN | outside TxLINE score retention (no records) |
| 17588239 | Group | CIV v ECU | outside TxLINE score retention (no records) |
| 17926553 | Group | SWE v TUN | outside TxLINE score retention (no records) |
| 17588403 | Group | ESP v CPV | outside TxLINE score retention (no records) |
| 17588230 | Group | BEL v EGY | outside TxLINE score retention (no records) |
| 17588311 | Group | KSA v URU | outside TxLINE score retention (no records) |
| 17588241 | Group | IRN v NZL | outside TxLINE score retention (no records) |
| 17588306 | Group | FRA v SEN | outside TxLINE score retention (no records) |
| 17926828 | Group | IRQ v NOR | outside TxLINE score retention (no records) |
| 17588322 | Group | ARG v ALG | outside TxLINE score retention (no records) |
| 17588405 | Group | AUT v JOR | outside TxLINE score retention (no records) |
| 17926703 | Group | POR v COD | outside TxLINE score retention (no records) |
| 17588228 | Group | ENG v CRO | outside TxLINE score retention (no records) |
| 17588406 | Group | GHA v PAN | outside TxLINE score retention (no records) |
| 17588399 | Group | UZB v COL | outside TxLINE score retention (no records) |
| 17588400 | Group | TUN v SUI | outside TxLINE score retention (no records) |
