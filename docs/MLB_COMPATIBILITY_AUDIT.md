# MLB — shared-architecture compatibility audit (no launch)

Audit date: 2026-10-06. MLB is **not** launched by this milestone: it is a declared sport in `lib/sports-data/sport-registry.ts` (`status: "declared"`,
provider identity `api_mlb`) with **no adapter registered**, so nothing can ingest, publish or activate it (`activeSportConfigs` filters on `status === "live"`,
and a unit test pins "live ⇔ adapter registered"). The purpose here is to prove the shared model needs no fork.

Evidence: a real baseball season (league 1, season 2024, 2,946 games) fetched read-only from the provider (Free plan reads 2022–2024), reduced to
`tests/fixtures/provider/baseball-mlb-2024-sample.json` and exercised by `tests/unit/sports-data/api-sports-mapping.test.ts`.

## Model fit

| | Fits the current canonical model? | Why |
|---|---|---|
| **MLB MONEYLINE** | **YES** | two teams, one winner; a finished MLB game cannot end level (`canEndLevel("baseball") === false`, so a level COMPLETED final is refused, never VOIDed) |
| **MLB SPREAD / run line** | **YES** | run line = SPREAD (`line_value` = home handicap, e.g. −1.5; grading is `yesScore + line` vs opponent; whole-number push → VOID). No `RUN_LINE` type exists or is needed |
| **MLB TOTAL** | **YES** | combined runs vs line; push → VOID |

Game, Post, Market, Pick, Call BS, Monetary Position, grading and history are sport-agnostic and unchanged: an MLB Game is just a fixture whose `provider` is `api_mlb` and `sport` is `baseball`.
**Core schema change required: NO.** No new Market type, no new table, no migration.

## What is provider/policy-layer work for a future launch (none of it forks the product)

1. **Adapter** (like `api-sports-provider.ts`): the baseball record is `scores.{home,away}.{hits,errors,innings{1..9,extra},total}`; `total` is the official final including extra innings
   (no shootout-style concept). Status map already exists (`normalizeApiBaseballStatus`): observed `FT`, `POST` (9), `CANC` (6), `ABD` (4); live `IN1`–`IN9`; `INTR` deliberately left UNKNOWN.
2. **Official-game rules / called games.** A rain-shortened game that is official (5+ innings) is `FT` with its real score — grade from it. An unofficial game is `CANC`/`ABD` — VOID / PENDING under the existing lifecycle.
   Needs one owner decision: what `ABD` (abandoned) and `SUSP` (suspended, resumed later) should do. Today both stay PENDING, exactly like the NFL's.
3. **Suspended / resumed games** keep their Game identity while the provider keeps the same game id (verify on a real suspended game before launch).
4. **Doubleheaders:** two Games, two provider ids, same teams and date — no uniqueness assumption in the schema depends on (home, away, date); to be verified with a real doubleheader payload.
5. **Rescheduling:** same mechanism as every sport — same provider id, new `scheduled_start_utc`, same Post.
6. **Extra innings:** part of the final score; nothing special.
7. **Daily volume:** ~2,430 regular-season games per year (~15 per day, spread over many hours): the odds window and refresh interval in the registry already bound request volume.
8. **Plan:** the Baseball product is on the Free plan; launch needs a paid plan like NHL / NBA.
9. **Presentation:** run line is displayed as "Spread" like the others; "run line" wording is display-only terminology if ever wanted (the registry's `scoreUnit` already says "runs" for Total accessible names).
10. **Pitcher-conditional bets** (listed pitchers / "action" rules) are a sportsbook concept Brohda does not import; Markets are full-game only.

No gap found that requires a core architecture change; **MLB is confirmed as a shared-architecture sport, not a future fork.**
