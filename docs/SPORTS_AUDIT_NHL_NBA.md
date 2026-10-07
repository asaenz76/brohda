# Shared sports architecture — NHL + NBA production-readiness audit

Audit date: 2026-10-06. Baseline: `main` @ `2bbe314` + migration 179. Everything below was read from the code, from production (read-only) and from
the live provider (read-only; the key's own `/status`, `/leagues`, `/standings`, `/teams`, one NFL `/odds`, and **historical** seasons for
NBA / NHL / MLB). No production writes, no fabricated data. "Confirmed live" = observed in a real payload; "vendor list" = taken from the
provider's published status/bet catalog and not yet observed on a real game.

## 1. Verdict in one paragraph

The product domain was already sport-agnostic (Game → Post → Market → Pick → Call BS → Position → grading → history, one grading function, T-10 and
started-game checks in the database). What was NFL-only was the **data edge**: the provider adapter, fixture sync, odds/Market ingestion, Post
publication filter, admin Events/Data/Settings surfaces, and a handful of constants. This milestone makes that edge one shared pipeline driven by a
single registry row per sport (`lib/sports-data/sport-registry.ts`). **No schema migration was needed.** The remaining blocker for NHL and NBA is not code:
**the API-Sports Hockey and Basketball subscriptions are on the Free plan, which cannot read the 2026 season at all** (§4).

## 2. Per-sport audit (production + code, before this change)

| | NFL | NBA | NHL | MLB |
|---|---|---|---|---|
| Provider sport key / host | `american_football` / v1.american-football | `basketball` / v1.basketball | `hockey` / v1.hockey | `baseball` / v1.baseball |
| League id | 1 | 12 | 57 | 1 |
| Ingestion support | yes | **none** | **none** | none |
| Team sync | yes (34 rows: 32 + 2 leaked test teams) | none | none | none |
| Logos | yes (league logo self-hosted) | none | none | none |
| Fixtures in production | 321 (113 completed) | 0 | 0 | 0 |
| Score / status updates | yes | none | none | none |
| Post creation | yes (NFL-only filter) | blocked by filter | blocked by filter | — |
| Market creation | Moneyline + Total | none | none | — |
| Spread | schema + grading yes; ingestion never | same | same | same |
| Grading | generic (one function) | works | works | works |
| Matchup order | Away @ Home | **wrong** (home-first default) | **wrong** | wrong |
| Communities | 32 team + league + sport | none | none | none |
| Discovery / feed | generic by Community | generic | generic | generic |
| Notifications | generic | generic | generic | generic |
| Production blockers | none | **plan, ingestion** | **plan, ingestion** | not launching |

So "NHL exists in the generic tables" was true, and "NHL is surfaced" was false for a single reason: **there was no NHL ingestion**, so no row ever existed
to be gated.

## 3. What changed (all generic; the NFL runs the same code)

- `sport-registry.ts` — one row per sport: provider identity (`api_nfl|api_nba|api_nhl|api_mlb`), league allowlist, season naming, bet-catalog ids,
  Market templates offered, odds window / refresh interval, matchup order, start/score vocabulary, franchise source, whether a game can end level,
  expected franchise count. Activation is configuration: `API_<X>_ENABLED=true` (+ key). MLB is `declared`, with no adapter, so it cannot launch.
- `api-sports-provider.ts` — one adapter class for the basketball and hockey APIs (their game records differ; everything else is the shared code path).
- `sync-fixtures.ts` — the NFL's sync, parameterised; the one cron runs every active sport in parallel, each failure-isolated and reported with
  sport + provider. Franchise filter from the league's own standings (no hard-coded team list).
- `ingestion/sports.ts` + `aggregate-spread.ts` — the NFL's Market ingestion, parameterised; SPREAD aggregation implemented once for point spread / puck line /
  run line.
- `publication.ts` — eligibility generalised and batched (an NBA/NHL season has ~1,300 future Games).
- Admin Events / Data / Settings pages are registry-driven (NFL, NBA, NHL).
- Grading policy hook (`canEndLevel`): a COMPLETED level score in basketball/hockey/baseball is never graded (see §6).
- Presentation: Total accessible names use the sport's own unit (points / goals / runs).
- Repeatable readiness check: `pnpm check-sport-readiness nhl|nba|nfl`.

## 4. Provider plans — the production blocker (not code)

Live `/status` for the account's single key:

| Product | Plan | Daily limit | Note |
|---|---|---|---|
| American football (NFL) | **Pro** | 7,500 | subscription **ends 2026-11-12 — renew before then** (NFL season runs to Feb) |
| Basketball (NBA) | **Pro** (upgraded 2026-10-07) | 7,500 | reads `season=2026-2027` (1,211 games). **Subscription ends 2026-11-07 — renew.** The separate *API-NBA* product has **no odds endpoint** and is not used (Brohda needs bookmaker odds for Markets) |
| Hockey (NHL) | **Pro** (upgraded 2026-10-06) | 7,500 | reads the 2026 season (1,409 games). **Subscription ends 2026-11-07 — renew** |
| Baseball (MLB) | Free | 100 | not needed (MLB is not launching) |

Until a sport's plan is upgraded (Basketball still is not), `sync-fixtures` for that sport reports a failure (visible in job health and Sentry, per sport) and
imports nothing. Request budgets once upgraded (Pro, 7,500/day each): fixture sync 288/day/sport (one season request per 5 minutes), standings ≤ 4/day,
odds ≈ 25–40/day/sport (48-hour window at the existing daily ingestion cadence) — far inside the limits.

## 5. Provider facts (confirmed live on historical seasons)

**NHL (league 57, season 2024, 1,503 games).** Statuses observed: `FT` 1194, `AOT` 229, `AP` 79, `CANC` 1. Scores are plain integers (`scores.home/away`) plus
`periods{first,second,third,overtime,penalties}` as `"h-a"` strings. **Shootout:** in all 79 shootout games the final score equals regulation + overtime goals
(level) **plus exactly one goal for the shootout winner**; the shootout winner (more `penalties` goals) is always the team with the higher final; **no
completed game was ever level.** The provider's final therefore already is the official NHL final, and the mapping adds nothing. Overtime (`AOT`): final = period sum.
32 franchises in standings (name "Utah Mammoth" for Utah).

**NBA (league 12, season "2024-2025", 1,387 games).** Statuses: `FT` 1316, `AOT` 70, `CANC` 1. `total` = four quarters + `over_time` in every `AOT` game
(overtime is included; `over_time` is the combined overtime points). No ties. The game list and `/teams` also contain **four All-Star exhibition "teams"**
(three games): they are excluded by the standings-based franchise filter (standings = exactly the 30 franchises), so they never become Teams or Communities.

**MLB (league 1, season 2024, 2,946 games).** `FT` 2927, `POST` 9, `CANC` 6, `ABD` 4; integer `scores.*.total` including extra innings.

**Stage / preseason.** The provider does **not** classify preseason vs regular season for NBA or NHL: `stage` is always null and `week` carries playoff-round labels
(and, in the NBA, the All-Star bracket shares "NBA - Semi-finals"/"NBA - Final" with real playoff labels), so it is not a usable flag. Preseason games are in the
season's game list (NHL: 66 games in September 2024). **Effect:** a preseason Game is published only if ≥2 bookmakers quote odds for it (ingestion creates no Market
without them, and a Post is only published with an ACTIVE Market). **Locked product decision (2026-10-07): preseason Games may be public.** A legitimate provider fixture between supported teams with a valid, gradeable Market gets a normal Game Post;
no date-based or heuristic preseason suppression is built merely because the provider lacks a flag, and nothing labels preseason as regular season. NBA opening-day readiness does not depend on preseason inventory.
Playoffs need nothing special (the architecture has no regular-season-only assumption; `round` carries the provider label).

**Odds.** Bet catalogs list `2 Home/Away`, `3 Asian Handicap`, `4 Over/Under` for both NBA and NHL (NFL: 1/2/3). Historical odds are not retained (empty responses) and
the current season cannot be read on the Free plan, so **no NBA/NHL odds payload has been observed**. The Asian Handicap convention (the number is the *home* handicap; the
`Away` entry is the other side of the same line) **was verified on a real NFL payload** (§7). The adapter reads a bet only when id *and* name match, so a renumbered
catalog fails closed.

| Template | NHL | NBA |
|---|---|---|
| MONEYLINE | AVAILABLE (catalog) — see §5a for the NHL's observed payloads | AVAILABLE (catalog) — payload unverified |
| SPREAD (puck line / point spread) | AVAILABLE — **observed and enabled** (§5a) | AVAILABLE (catalog) — implemented, **gated off until a real payload is verified** |
| TOTAL | AVAILABLE — observed (§5a) | AVAILABLE (catalog) — payload unverified |

**Locked product decision (2026-10-07): SPREAD is approved for NBA and NHL once a real provider odds payload has been verified for that sport,** independently per sport. Before enabling a sport:
inspect real payloads; prove team/side orientation, sign orientation and the canonical YES-side mapping; run grading and presentation tests; then add `"SPREAD"` to that sport's `marketTemplates` in
`sport-registry.ts`. **NHL: done** (§5a — real 2026 payloads, enabled in r45). **NBA: convention verified on real 2026-27 payloads (§5b), but enabling is held at the pre-opening gate (§5c, r50)** — the production market layer has not been proven on real bookmaker inventory. **NFL: enabled on the owner's instruction (2026-10-07)** after 13 real games (week of 2026-10-08, 4–6 bookmakers each) passed the same gate: 13/13 orientation, cover probability 0.50 ± 0.02 at every line, canonical mapping, grading and presentation tests.

## 5a. Real 2026 NHL data (captured the day the Hockey plan was upgraded, read-only)

- **Season 2026:** 1,409 games, 2026-09-19 → 2027-04-11, exactly 32 franchises (standings → 32 distinct ids). Statuses now observed: `NS` 1292, `FT` 87, `AOT` 20, `AP` 7, and **live `P1` / `P2` / `P3`** (promoted from "vendor list" to observed). 72 games fall in September (preseason); the regular season opens 2026-10-06/07 — three games were live when captured.
- **Shootouts again:** all 7 current-season `AP` games credit the winner exactly one goal (e.g. periods 0-1,1-0,1-1 = 2-2, shootout 1-0 → final 3-2); a scoreless-period shootout is final 1-0. Final games are never level.
- **Offline dry run:** all 1,409 games map without error through the adapter — no `UNKNOWN` status, every team a standings franchise, unique ids, every completed game decisive.
- **Odds (real payloads):** 5 bookmakers per upcoming game. **Moneyline** (bet 2 "Home/Away") from 4–5 books. **Asian Handicap** (bet 3) and **Over/Under** (bet 4) from exactly **two** books (BetVictor, Betano) — enough at the standard minimum of 2, none at 3. The handicap convention is confirmed on NHL data: `Home -1.5 @ 2.38 / Away -1.5 @ 1.53` for a 1.57 moneyline home favourite (home lays 1.5; the Away entry is the other side of the same line).
- **Puck-line band:** a puck line is always ±1.5, so its sides are lopsided (home -1.5 fair 0.31 and 0.39 in the two captured games). The original "near a coin flip" guard (0.35–0.65) would have refused real puck lines, so the main-line band is now per sport in the registry (`spreadMainLineBand`: NHL 0.25–0.75; the orientation and both-sides guards are unchanged).

| Template | NHL | NBA |
|---|---|---|
| MONEYLINE | **AVAILABLE — observed** (4–5 books) | **AVAILABLE — observed** (8–9 books) |
| SPREAD (puck line / spread) | **AVAILABLE — observed** (2 books); **enabled** | **AVAILABLE — observed** (3–8 books); convention verified, **gated OFF pending the pre-opening gate (§5c)** |
| TOTAL | **AVAILABLE — observed** (2 books) | **AVAILABLE — observed** (4–9 books) |

## 5b. Real 2026-27 NBA data (captured the day the Basketball plan was upgraded, read-only)

- **Season "2026-2027":** 1,211 games, 2026-10-03 → 2027-04-05; **30 franchises** in standings, 30 team names in the game list, no non-franchise game; 1,145 games from the regular-season opener (2026-10-20 19:00 UTC). Statuses: `NS` 1,199, `FT` 12 (preseason). Offline dry run: all 1,211 games map with no `UNKNOWN` status, unique ids, every completed game decisive.
- **Odds (real):** 6 games already quoted by **8–9 bookmakers** each; bets 2 `Home/Away`, 3 `Asian Handicap`, 4 `Over/Under` present at nearly every book (WilliamHill omits the handicap). Moneyline, Spread and Total are all AVAILABLE and observed.
- **SPREAD verification (gate for enabling it), on all six real games:**
  - *Team/side orientation:* the number is the **home** handicap; `Away` is the other side of the same line (home favourite → negative line, home underdog → positive: Warriors −7 at a 0.68 moneyline, Bucks +5.5 at 0.36, Hornets −5 at 0.63, Kings +6, Thunder +1.5, Jazz +1).
  - *Sign orientation:* at every chosen line the home side's fair cover probability is 0.50 ± 0.011 — only true for the home-handicap reading; a flipped sign would be far from a coin flip.
  - *Canonical YES-side mapping:* YES = HOME at the signed line; NO = the opponent at the opposite sign (presentation shows "Away −x | Home +x" in Away @ Home order).
  - *Grading and presentation tests* run on the real lines (cover / non-cover / push; accessible names "Pick … plus/minus …").
  - → convention, sign and mapping verified. **NBA SPREAD is gated OFF** (r50) until the pre-opening gate in §5c passes; it was briefly enabled in r47 and is withdrawn — see §5c.
- Bookmaker coverage is deep for the NBA (3–8 books per spread line), unlike the NHL's two.

## 5c. NBA pre-opening gate (r50) — status: STRUCTURALLY READY, market-layer production proof PENDING BOOKMAKER INVENTORY

The NBA regular season opens **2026-10-20 (19:00 UTC)**. Today the platform side is complete and tested (teams, Communities, fixtures, status mapping, grading, jobs, UI, pipeline integration/e2e),
but **no production proof exists for the market layer** for the 2026-27 season: bookmakers have not (or only partly) published NBA odds, so ingestion → Market → Post → grading has not been observed on real
production inventory. Until it has, the NBA is **STRUCTURALLY READY, not production-proven**, and the NBA **Spread stays OFF** (`marketTemplates: ["MONEYLINE", "TOTAL"]`). Spread is not removed from the code:
mapping, grading and the main-line band stay in place, and any NBA Spread Market that already exists keeps grading.

Readiness reports this with its own status, never as a failure: `pnpm check-sport-readiness nba` →
`PROVIDER_INVENTORY_UNAVAILABLE` (Games exist; the latest ingestion run recorded "no data"/"too few bookmakers" for them) or `PROOF_PENDING`. It is `BROKEN` only if an odds request errored, a Game was
never examined, a Market is ungradeable, or a job is failing.

**Gate — all of these, in order, then (and only then) enable NBA Spread:**
1. Re-run `pnpm check-sport-readiness nba` on/after **2026-10-18** (and again after the first Games of **2026-10-20**). Expect no `FAIL`.
2. Bookmaker inventory present: ingestion has produced ACTIVE MONEYLINE and TOTAL Markets for in-window Games (`markets-present` = PASS), each with ≥ the configured minimum bookmaker count.
3. Posts publish for those Games (`posts-present` PASS) and they appear in the NBA feed (`feed` PASS) — checked signed in (see the OPERATIONS_RUNBOOK signed-in checklist).
4. The first completed NBA Games grade end-to-end (`provider-results` PASS; `grading-green` PASS; Picks settle with notifications).
5. Re-verify the Asian Handicap convention on the live opening-week payload (home handicap; `Away` is the other side; fair cover ≈ 0.50 at the chosen line) — repeat the §5b check.
6. Owner approves; add `"SPREAD"` to the basketball `marketTemplates` in `lib/sports-data/sport-registry.ts` and update `tests/unit/sports-data/sport-registry.test.ts`. No other change is needed.

Final-report vocabulary: **NBA STRUCTURALLY READY** / **NBA MARKET-LAYER PRODUCTION PROOF PENDING BOOKMAKER INVENTORY** until steps 1–4 are observed.

## 6. Result semantics and the policy layer

- **One grading function** (`computeSportsMarketOutcome`): official final score; MONEYLINE higher wins; SPREAD `yesScore + line` vs opponent, exact push → VOID (never the
  opposite side); TOTAL over/under, exact push → VOID; CANCELLED → VOID; every other non-final state stays PENDING (no manufactured settlement).
- **Overtime / shootout** are resolved where scores are normalised (the provider adapters), so every Market is graded on the official final including overtime. Moneyline in the
  NHL is **never regulation-only** and never uses the NFL tie rule.
- **Sport policy (new):** basketball, hockey and baseball cannot end level. A COMPLETED level score there is an *inconsistent provider result* (e.g. a shootout whose
  deciding goal was not credited yet): it is **not graded and not VOIDed**; it stays PENDING and the grading job reports it as a failure naming sport, league, provider game id
  and Brohda game id (so job health reads degraded). The NFL keeps "tied Moneyline → VOID".
- **Shootout results — locked product decision (2026-10-07): keep current behaviour.** Full-game NHL Markets are graded from the provider's official final score. When the provider credits the shootout winner one
  goal in that final, the goal counts for MONEYLINE, SPREAD **and TOTAL**; a regulation+overtime-only score is never reconstructed (a shootout game's total is regulation + overtime goals + 1, always odd). Pinned by tests.
- **Postponed:** Game identity is preserved (the same provider id; rescheduling updates the start on the same row and the same single Post) and the Game is tracked until it ends.
  **Suspended / abandoned / awarded** stay PENDING until the owner sets a policy (unchanged from the NFL).
- **Result authority:** structured provider scores only (`fixtures.home_score/away_score`, written by sync). Never UI text, news or sportsbook rules.

## 7. The spread convention (verified on a real NFL payload)

`Home -9.5 @1.91 / Away -9.5 @1.91` (Betfair), `Home +2.5 @1.16 / Away +2.5 @4.70` while Home was the 1.20 moneyline favourite (Marathon), `Home -1 @1.18 / Away -1 @4.36`
against a moneyline of 1.18 / 5.00 (Bet365): the number is the **home handicap**; the Away entry is the other side of the same line. `aggregateSpread` only accepts a line that
(1) a bookmaker quotes on both sides, (2) is the consensus coin-flip line (fair probability 0.35–0.65), and (3) has a sign that agrees with the moneyline favourite. Otherwise
it returns nothing (no Market). On the captured NFL game it finds −9.5.

## 8. Time, lock, started games

Timestamps are provider Unix seconds → UTC (every captured game says `timezone: "UTC"`); nothing converts or assumes Eastern. T-10 and the started-game rule live in the
database RPCs (`set_pick`, `call_bs`, `accept_call_bs`, `propose_money`, `accept_monetary_proposal`): all compare `now()` with the canonical `scheduled_start_utc − pick_lock_minutes`
**and** require `internal_status = 'NOT_STARTED'`. They are sport-agnostic, follow a reschedule, and cannot be bypassed by the client clock. (A Pick touched inside T-10 locks permanently
and one-way, as designed; a reschedule later does not reopen it.)

## 9. Performance

- Fixture sync: one season request per sport per 5 minutes; terminal fixtures are skipped; batched upserts (now chunked at 400 rows — an NBA/NHL season is ~1,500 games with raw payloads).
- Franchise set: one standings read per league per 12 hours (in-memory).
- Odds: bounded to a 48-hour window and a 60-minute refresh interval per Game (the NFL keeps its established sportsbook-week window); one request per Game.
- Post publication: three set-based reads instead of two queries per Game per run (was O(upcoming Games) per tick).
- Admin Events and local browse already page past PostgREST's 1,000-row cap. **Fixed:** the wallet reconciliation check silently stopped at 1,000 wallets (now pages).
- Not N+1: Community distribution is per published Post (unchanged).

## 10. Findings outside the milestone's scope (reported, mostly fixed)

- **P1 (fixed): NFL season rule broke in January.** `season = UTC year` would have requested season `2027` from 2027-01-01, silently stopping sync and grading for the last regular-season
  weeks and the playoffs. Production confirms every game through 2027-01-10 is season `2026`. Fixed in the registry (`seasonFor`), pinned by a test.
- **P1 (action needed): the NFL provider subscription ends 2026-11-12.**
- **P3 (resolved by migration 180): two leaked test teams** in production (`Home Sync Test NFL` 9101, `Away Sync Test NFL` 9102). A read-only dependency audit (2026-10-07) proved them fully orphaned — no Community,
  follow, Game, Post, Market, Pick, Challenge, Position, notification, audit or `team_players` row; the only FK to `teams` is `communities.team_id`. Migration `20260101000180` deletes them with an orphan guard
  (and any *unused* Community created for them meanwhile); anything referenced stays. Authorised by the owner; applied with `supabase db push`.
- **P3:** `nfl_game_results` is the confirmed-result audit table; it is now written for every sport (it is generic in shape; only the name says NFL). A rename is cosmetic.
- **P3:** the NFL's league logo is self-hosted because the provider CDN copy was unreliable; NBA/NHL use provider URLs (readiness flags a missing one).
- **P2:** `lib/monetary/reconciliation.ts` has the same unpaged reads (and a long `.in()` list) as the wallet check that was fixed here; fine at current volume.

## 11. Activation runbook (when the plans are upgraded)

1. Upgrade the API-Sports **Hockey** (urgent: the NHL regular season is starting) and **Basketball** plans. Confirm: `GET /status` shows Pro, and `GET /games?league=57&season=2026` no longer errors.
2. In Vercel production env set `API_NHL_ENABLED=true` and `API_NBA_ENABLED=true` (the existing `API_NFL_KEY` authenticates all products; or set `API_SPORTS_KEY`). Optional budgets: `API_NHL_DAILY_REQUEST_BUDGET`, `API_NBA_DAILY_REQUEST_BUDGET`.
3. No new cron entries: the existing `sync-fixtures-nfl`, `ingest-nfl-markets`, `publish-posts`, `distribute-posts`, `grade-predictions`, `resolve-challenges`, `settle-monetary-positions` jobs run every active sport.
4. After the next sync: `pnpm check-sport-readiness nhl` and `... nba`. Items report PASS / FAIL / DISABLED / PROVIDER_INVENTORY_UNAVAILABLE / PROOF_PENDING with one overall verdict (OPERATIONS_RUNBOOK "Reading a sport's readiness verdict"); only FAIL is a defect. Inventory appears as odds are ingested and Posts publish.
5. After the first real odds payload for a sport, decide whether to turn SPREAD on for it (§5; NBA: §5c gate).
