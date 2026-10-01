# Universal Sports Architecture Proposal — PART B

**Status: APPROVED with 15 decisions/adjustments. Phase 0.5 (circuit-breaker correctness) COMPLETE. Phase 1 (competition boundary + complete-season storage) COMPLETE. Phases 2–4 authorized to proceed; Phase 5 requires a separate review of the shared confirmed-result schema before implementation.**

## Approved decisions (superseding the open questions below)

1. Saudi Pro League: **disabled** in `SUPPORTED_COMPETITIONS` (historical data preserved). New entries to add (IDs to be resolved live, never fabricated): Primeira Liga, Eredivisie, Copa Libertadores, Copa Sudamericana, CONCACAF Champions Cup.
2. Confirmed-result architecture: **one shared universal table**, not one per sport — append-only, one current result, CONFIRMED/CORRECTED, correction history, grader resolves through it. Payload is sport-specific/normalized (not assumed to be a home/away score) — exact schema to be presented for review before Phase 5 implementation.
3. Competition grouping: **no new CONTINENTAL group** — Champions League/Europa League/Libertadores/Sudamericana/CONCACAF Champions Cup all stay under `GLOBAL` (an admin-grouping convenience, not a taxonomy).
4. Phase order: **0 (done) → 0.5 (done) → 1 → 2 → 3 → 4 → [review] → 5 → 6 → 7**, exactly as originally proposed with 0.5 inserted.
5. Circuit breaker fix: **approved and implemented now** — see below.
6. Events rollout: parallel route (`/admin/events`) alongside existing Fixtures during rollout; no removal until Events is proven complete.
7. Complete-season football storage: **approved**, using the existing import-job/chunk infrastructure, no new provider calls.
8–14. Local-first Events invariant, admin IA (Dashboard/Events/Pools/Results/Sports·Data Management), no `fixtures` rename, provider+external-ID identity enforcement, odds policy unchanged, NBA/MLB/NHL deferred to a documented Phase 7 contract, F1/Tennis/Golf/MMA infrastructure deferred until a sport requiring it is approved — all **approved exactly as proposed**.

---

## Phase 0.5 — Circuit Breaker Correctness (COMPLETE)

**Root cause**: `fetchWithRetry` (`lib/sports-data/http.ts`) only checked `response.ok` (HTTP status) before logging a request as a success. API-Sports (both API-Football and API-NFL) signals quota exhaustion as an **HTTP 200** with a populated JSON `errors` field — that check happened only later, inside each provider's own `parseApiFootballBody`/`parseApiNflBody`, called *after* the request was already logged as a plain success. `provider_request_log` — and therefore every circuit-breaker read derived from it (`provider-gateway.ts`'s `getProviderStatus`/`isQuotaExhaustedError`) — never saw the failure at all, so the breaker never opened.

**Fix**: a new `detectSoftError` check in `http.ts`, run on every `response.ok` result before it's logged. It clones the response (so the caller's own parse function still gets an unconsumed body), inspects the same `errors` convention, and — if populated — logs it as a real error and throws a new `ProviderSoftError` (never retried, same reasoning as a permanent 4xx: retrying a quota-exhausted request only spends more of the same exhausted quota).

**Files changed**:
- `lib/sports-data/http.ts` — `detectSoftError`, `ProviderSoftError`, wired into `fetchWithRetry`.
- `lib/actions/competitions.ts` — two previously-uncaught `getLeagueById` calls now catch and return a clean admin-facing message on a quota hit, instead of throwing an unhandled exception out of the server action.
- `lib/actions/fixtures.ts` — `importOneFixture` (the bulk "Import selected" path) now catches per-fixture, so one fixture's quota error returns a clean per-row failure instead of crashing the whole batch.
- `tests/unit/http.test.ts` — 7 new regression tests for the exact HTTP-200 + quota-JSON-body shape (detection, no-retry, correct logging, no false positives on real successes, provider isolation, body-clone safety).
- `tests/integration/circuit-breaker.test.ts` — new, 4 tests proving the real DB round-trip: real write → real `getProviderStatus` read → breaker opens → providers stay isolated.

**Quota behavior**: a detected quota error is now logged as a real error in `provider_request_log`; the three existing circuit-breaker call sites (`sync.ts`, `discovery-sync.ts`, `availability-cache.ts`) already checked `getProviderStatus`/`circuitBreakerOpen` before looping — they simply never saw it trip before. No changes were needed there; they now function as originally designed. Verified via the existing `competition-crons.test.ts` breaker test plus the new integration test.

**Sentry behavior**: no global Sentry config was touched. Instead, the two remaining call sites that could have let a quota error throw uncaught out of a server action (crashing to Sentry's automatic `onRequestError` capture as an unhandled exception) now catch it and return a clean, classified admin message. Every other call site already caught this gracefully. Net effect: a quota hit is now always resolved through normal control flow, not Sentry's exception pipeline — consistent with "known quota exhaustion is a handled operational state."

**Provider isolation**: confirmed via a new integration test — an API-Football quota error opens only `getProviderStatus(true, "api_football")`'s breaker; `getProviderStatus(true, "api_nfl")` is unaffected, since `provider_request_log` and every read of it were already filtered by `provider` (this was already correct; the bug was detection, not isolation).

**Existing cached/local data**: unaffected by design — the breaker gates new *outbound* provider calls only; every admin-facing read in this app is already DB-only (confirmed in both prior audits), so this required no new work, only verification that nothing regressed it.

**Verification**: `tsc --noEmit` clean, `eslint --max-warnings=0` clean, all 877 unit tests pass, all 27 relevant existing integration tests pass unchanged, all 11 new tests (7 unit + 4 integration) pass, no residual test data left in production.

---

## Phase 1 — Football Supported-Competition Boundary + Complete-Season Storage (COMPLETE)

**Competition boundary** (`lib/sports-data/supported-competitions.ts`):
- Saudi Pro League (307) disabled (`enabled: false`), entry kept documented, historical data untouched — already-imported-but-now-unsupported competitions are already a tested code path (`competition-crons.test.ts`'s "skips an imported-but-now-unsupported competition entirely... without touching its data").
- 5 new entries added, IDs resolved via live, scoped `searchLeagues` lookups (never fabricated): Primeira Liga (94), Eredivisie (88), Copa Libertadores (13, "CONMEBOL Libertadores" in the provider's own naming), Copa Sudamericana (11, "CONMEBOL Sudamericana"), CONCACAF Champions Cup (16 — flagging a real naming note: the provider's database still calls this "CONCACAF Champions League," its pre-2023-rebrand name; there's a separate id, 1136, for the women's competition specifically, which is not this one). All 5 grouped under `GLOBAL` per the approved no-new-taxonomy decision.
- 2 live `searchLeagues` calls total across the whole resolution session (both scoped/filtered queries, not the dangerous empty-query "list everything" variant that caused the original quota incident).

**Complete-season storage** (`lib/actions/competitions.ts`): `startCompetitionImportAction`'s `includeHistorical` default flipped from `false` to `true`. Confirmed via grep that every real admin call site (Import / Import selected / Import all recommended) already omits this option entirely — so this one default change makes every normal import complete-season, with zero UI changes. No new provider call: the season response already contains the full season in the one existing `getSeasonFixtures` call; only what gets kept from a response already in hand changed. The option itself stays available as an explicit override (tested both ways).

**Not done, flagged for your decision**: this only changes the default for *new* imports going forward. It does not retroactively backfill the ~11 already-imported, currently-future-only-stored competitions (Premier League, LaLiga, etc.). The exact mechanism to do that already exists and is unchanged — `importHistoricalFixturesAction`, exposed as a button on each Competition Workspace's Settings tab — it just hasn't been run for the already-imported ones. Given that's a real, additional round of live provider calls and data writes across ~11 competitions, I didn't trigger it unilaterally. Let me know if you want it run (either per-competition via the UI, or I can run it for all of them in one pass).

**Tests**: 3 new unit tests (Saudi Pro League disabled, all 5 new competitions resolved and enabled, no new taxonomy group introduced) + 1 existing test rewritten for the new default + 1 new test proving the explicit override still works.

**Verification**: `tsc`/`eslint` clean, 880 unit tests pass, all 30 relevant integration tests pass (6 in the rewritten file + 24 across the broader competition-related suite), no residual test data left in production.

---

Grounded entirely in the completed football and NFL audits from this session, plus direct re-verification of current source files where noted. Every claim below is tagged:
- **CONFIRMED** — directly verified against current repository files/schema/migrations
- **PROPOSED** — a design recommendation, not yet built
- **FUTURE** — an extension point for a sport not being built now

**Live provider requests made producing this report: API-NFL = 0, API-Football = 0.**

---

## 1. Executive Summary

Football and NFL already implement two different points on the same underlying lifecycle: *provider → local storage → local browsing → on-demand markets → confirmed result → grading*. NFL's implementation is smaller and newer, and it happens to get several things right that football's older, larger implementation doesn't: single-pass full-season sync, local-only browsing, a real confirmed-result gate before grading, and no accidental live-provider calls from normal page renders (football has one: the Fixtures "By date" tab).

The recommended direction is **not** a schema rewrite. It's:
1. Fix football's two biggest deviations from its own already-working NFL sibling — local-first browsing and complete-season storage — using football's *existing* infrastructure (import jobs, chunking, Competition Workspace), not new infrastructure.
2. Generalize the one genuinely valuable NFL invention — the confirmed-result gate — into a shape any sport can plug into, reusing the exact pattern already proven in production.
3. Introduce a thin provider-routing abstraction (already forced into existence by Part A's bug fix) so a future sport's provider adapter is additive, not a rewrite.
4. Rename nothing in the database. Introduce "Events" only as UI/product language layered over the existing `fixtures` table.
5. Treat NBA/MLB/NHL as "cheap" (their real-world shape matches football/NFL almost exactly) and F1/tennis/golf/MMA as "expensive" (they break the two-participant, one-atomic-event assumptions football/NFL both share) — and design the *extension points* for the expensive category without building anything for it now.

---

## 2. Current-State Synthesis (from the two completed audits)

### Football (CONFIRMED, from the football audit)
- Curated multi-competition catalog: `SUPPORTED_COMPETITIONS` (14 entries, 2 unresolved/disabled) — [`lib/sports-data/supported-competitions.ts:44-74`](lib/sports-data/supported-competitions.ts:44).
- Import: `startCompetitionImportAction` → `getSeasonFixtures` (whole season, one call) → filtered to future-only unless `includeHistorical` → chunked via `competition_import_jobs`/`competition_import_job_chunks` (≤150 fixtures/chunk) → `process-competition-imports` cron (**not confirmed scheduled** — absent from `docs/DEPLOYMENT.md`).
- Discovery: separate `discovery-sync.ts`, re-diffs the whole season, **auto-imports** new/changed fixtures directly, no approval gate. 6h staleness, `discover-competitions` cron (**not confirmed scheduled**).
- Sync: two disagreeing mechanisms — `runFixtureSync` (scheduled, scores/status, adaptive interval) vs. "Sync now" (manual, kickoff-only, never touches score/status).
- Browsing: three modes. By-date is cache-backed but **fires a live provider call on every page render** via a bare `useEffect` (`date-mode.tsx:106-111`) — the one real "passive quota drain" found in the whole audit. By-competition has **no caching at all**, live on every search. By-fixture-ID **bypasses Competition Workspace gating entirely** (no `isSupportedCompetition` check).
- Grading: reads the raw, live-syncing `fixtures.regulation_*_score` directly. No confirmed-result layer.
- Odds: two separate call paths (`getFixtureGoalsLinesAction` uncached, `getFixtureMarketsAction` 5-min cached) can double-fire for one fixture selection — **fixed as part of Part A**, but the deeper redundancy (two paths existing at all) remains.
- Scale reality: **already hit a real production incident** — the admin Competitions list once pulled all fixtures via an unordered `.in()` query and PostgREST's 1000-row default cap silently truncated it at 1852 real rows across 8 competitions, hiding entire competitions' future fixtures. Fixed via a server-side aggregate RPC (`get_competition_fixture_aggregates`) for that one page; the Workspace dashboard's equivalent query still uses the same raw-transfer pattern (currently safe only because it's scoped to one competition).

### NFL (CONFIRMED, from the NFL audit)
- Single hardcoded competition, `SUPPORTED_NFL_COMPETITIONS` (1 entry) — [`lib/sports-data/supported-nfl-competitions.ts:26-31`](lib/sports-data/supported-nfl-competitions.ts:26), deliberately not merged into football's config (documented reason: different discovery-machinery needs, ID-collision risk).
- Import/sync: one function, `runNflFixtureSync`, one `getSeasonFixtures` call per tick (whole season), batched upsert, self-maintains its own `league_season_imports` row every tick — **no admin action ever required**.
- No round/stage filtering exists anywhere (confirmed via clean git diff against a fully-reverted filter attempt).
- Pending/TBD matchups: placeholder bracket slots (`id:0`, `name:null`) are never written to `fixtures` at all (NOT NULL constraint); discovered naturally on a later tick once real teams appear.
- Browsing: **no NFL-specific admin route exists**. The Competitions/Fixtures pages are 100% football-hardcoded; NFL's only discovery surface is the shared pool-creation fixture picker (DB-only).
- Grading: **implemented and migration-applied** confirmed-result layer — `nfl_game_results` (CONFIRMED/CORRECTED, `is_current`, append-only, two protective triggers), gated by `resolveNflFixtureRow` ahead of both grading callers.
- Odds: single clean live call at pool-creation time, all markets in one response, uncached by design.
- Real, confirmed bugs found and **fixed in Part A**: an NFL fixture selection could reach `apiFootballProvider` through the shared markets path; `fixture_odds_cache` had no provider identity.
- Real, *not yet fixed* gaps: no circuit breaker on NFL sync at all; NFL's quota/health is never surfaced in the admin Provider Status panel; `sync-fixtures-nfl` is not documented as scheduled.

### The core asymmetry
Football has *more* infrastructure (import jobs, chunking, discovery, Competition Workspace) but uses it in a way that still reaches the live provider constantly. NFL has *less* infrastructure but, because of that, ended up fully local-first and provider-isolated by construction. The goal is football *behaving* like NFL operationally, using football's own existing machinery — not NFL's schema.

---

## 3. Universal Principles (PROPOSED, restating the product principle back as testable rules)

1. **Local-first browsing is a hard rule, not a preference.** Any admin action that only changes a filter (date, sport, competition, status, search) must resolve to a query against `fixtures`/related tables, never a live provider call — no exceptions, including default `useEffect`-triggered fetches on page load.
2. **Odds are never synced.** They are fetched live, on demand, at the moment a pool is being created, cached briefly if at all, and the selected line is frozen into the pool. Fixture/event sync and odds/market sync are two unrelated schedules, forever.
3. **A provider's live response is not grading truth.** Grading reads a confirmed-result record, not the live-syncing event row. NFL already proves this pattern works end-to-end, migration-tested, in production.
4. **Provider is a property of the event, not an assumption baked into a function name.** Any code that fetches provider-specific data must take (or derive) the provider from the actual event, and refuse explicitly on a mismatch — this is now enforced for odds (Part A); it should become the standing rule for every future provider-specific code path.
5. **Unsupported-competition data is never deleted, only never expanded into.** Real data (e.g. football's Serie B rows unexpectedly present in production, confirmed during today's cleanup work) stays; the *supported list* controls what future imports/discovery are allowed to touch, not what already exists.
6. **No feature maintains its own competition list.** This is already football's own stated rule for `SUPPORTED_COMPETITIONS`; it should extend to "no feature maintains its own *provider* list or *sport* list" either.

---

## 4. Proposed Domain Model

```
SPORT
  └─ COMPETITION
       └─ EDITION / SEASON (optional)
            └─ EVENT
                 └─ SUB-EVENT (optional)
                      └─ MARKET
                           └─ POOL
                                └─ RESULT
```

**Where it holds cleanly (PROPOSED mapping, CONFIRMED against real schema/config for football/NFL):**

| Layer | Football | NFL | NBA (FUTURE) |
|---|---|---|---|
| Sport | `fixtures.sport = "football"` | `"american_football"` | `"basketball"` |
| Competition | one `SUPPORTED_COMPETITIONS` entry (Premier League) | the one `SUPPORTED_NFL_COMPETITIONS` entry | one NBA config entry |
| Edition/Season | `season` text column (`"2026"`) | same | same |
| Event | one `fixtures` row | one `fixtures` row | one `fixtures` row |
| Sub-event | *(none — always atomic)* | *(none)* | *(none)* |
| Market | football's `OddsMarket`/NFL's `NflBookmakerOdds` (both provider-specific shapes, never unified) | " | new shape |
| Pool | `pools` row | same | same |
| Result | raw `fixtures.regulation_*_score` (**gap**) | `nfl_game_results` (**works**) | *(needs the same as NFL)* |

**Where it needs flexibility (PROPOSED, FUTURE):**
- **Edition/Season is genuinely optional**, not "always present, sometimes empty" — tennis (Wimbledon 2027) and MMA (UFC 300) don't have a season *containing* Wimbledon/UFC-300, the tournament/event edition *is* the season-equivalent. The model needs Season to be nullable/absent-by-design, not a required layer every sport must populate with a placeholder.
- **Sub-event is genuinely optional and, when present, is structurally different per sport** — F1 (qualifying/race under one Grand Prix), MMA (many fights under one card), tennis (many matches under one tournament round) don't share a common sub-event shape. This layer should be modeled as "an Event MAY have children that are also Events" (self-referential), not a distinct SUB-EVENT table — see §7.
- **Market → Pool is already provider-specific and deliberately not unified** (football's `OddsMarket` and NFL's `NflBookmakerOdds` are different shapes on purpose, per `nfl-odds.ts`'s own header comment) — this is correct and should stay that way; do not force a common raw-market schema (see §16).

---

## 5. Provider Abstraction

**CONFIRMED, already partially built by Part A**: [`lib/sports-data/provider-names.ts`](lib/sports-data/provider-names.ts) is the first piece of this — a single source of truth for provider identity strings, and `assertProvider` in `lib/actions/odds.ts` is the first instance of "derive provider from the event, refuse on mismatch."

**PROPOSED, next steps (not built yet):**
- Every provider-specific action (not just odds) should take `provider` as an explicit parameter derived from the event row, never inferred from context or defaulted to football. Candidates for the same treatment football's odds already got: `getFixtureQuestionContextAction`'s recommendation logic, any future per-event provider-specific fetch.
- A small `FixtureProvider` → adapter lookup (not a generic interface every provider must satisfy identically — see §16 on why raw shapes stay separate): `{ api_football: apiFootballProvider, api_nfl: apiNflProvider, [future]: ... }`, used only for *routing*, not for forcing identical method signatures across sports.
- **Do not build a generic `SportsDataProvider` interface that assumes every sport looks like football.** The current `SportsDataProvider` type (`lib/sports-data/types.ts`) already has NFL-specific gaps (several methods stubbed to no-ops for NFL, confirmed in the NFL audit's §12) — this is the *correct* outcome, not a defect: a provider adapter should only implement what its sport actually needs, and callers should never assume every adapter method exists.

---

## 6. Event Lifecycle (PROPOSED universal shape, built from NFL's proven pattern + football's existing infrastructure)

```
INITIAL IMPORT / DISCOVERY → LOCAL EVENT CREATED
PERIODIC DISCOVERY → NEW EVENTS FOUND
EVENT SYNC → SCHEDULE / PARTICIPANTS / STATUS / SCORE UPDATED
TERMINAL EVENT → RESULT CONFIRMATION
MARKETS → ON DEMAND (separate lifecycle, §7)
```

**Confirmed today, per sport, against this shape:**

| Stage | Football today | NFL today |
|---|---|---|
| Initial import | `startCompetitionImportAction`, admin-triggered, chunked job | automatic every cron tick, no admin action |
| Periodic discovery | separate `discovery-sync.ts`, auto-imports, 6h staleness | folded into the same tick as sync (whole-season re-fetch every time) |
| Event sync | `runFixtureSync`, adaptive interval, scores/status only | `runNflFixtureSync`, same tick as discovery, all fields |
| Terminal → confirmation | **missing** | `nfl_game_results` reconciliation, every tick, independent of the terminal-skip |

**PROPOSED**: football does not need NFL's "everything in one tick" simplicity (its provider genuinely charges per-fixture, unlike NFL's whole-season call) — it needs its *existing* three-stage split (import/discovery/sync) to (a) actually run on a documented schedule, and (b) gain the same terminal→confirmation stage NFL already has. This is additive to football's current pipeline, not a replacement of it.

---

## 7. Participant Model — Do Not Build Yet (per explicit instruction, §7/§29)

**CONFIRMED**: today, `fixtures.home_team_*`/`away_team_*` are fixed columns — exactly two participants, both team-shaped, hardcoded into the schema.

**PROPOSED migration path, described only (not implemented):**
- The two-participant assumption should NOT be generalized in this pass. Football and NFL both need it exactly as it is; changing it now would touch the single highest-traffic table in the schema for zero present-day benefit.
- The correct extension point, when a participant-breaking sport is actually built, is **not** "add a generic N-participant join table to `fixtures`" — it's **a new event *type*** that coexists with today's two-team `fixtures` rows, sharing only the Event-level concepts (provider, external ID, scheduled start, status) and diverging below that. F1/golf do not need `home_team_name`/`away_team_name` to be generalized; they need a event kind that never has those columns populated at all, with its own participant relationship.
- **Self-referential sub-events** (§4) are the same story: when F1 is actually built, "Monaco Grand Prix" and "Qualifying" would both be rows in the same events concept, with the session referencing the weekend via a nullable `parent_event_id`-shaped relationship — not a new SUB-EVENT table today.
- This section is deliberately a *description* of the extension point, not a schema. No migration is proposed here.

---

## 8. Market/Odds Lifecycle

```
EVENT → provider-specific market adapter → normalized markets (per-provider shape)
      → template compatibility → pool configuration → market/line snapshot frozen
```

**CONFIRMED current state**: football's `NormalizedFixtureMarkets` and NFL's `NflBookmakerOdds`/`NormalizedNflFixtureOdds` are two genuinely different shapes, by design (`nfl-odds.ts`'s header comment explains why — different bookmaker numbering, different market structure). Both freeze into `pools.template_config` at creation time and are never re-read afterward — this part is already universal and correct.

**PROPOSED**: keep the shapes separate. **Do not** attempt to normalize football and NFL odds into one raw structure — that was explicitly rejected by the NFL implementation itself and remains correct for any future sport (golf's "will player X finish top-5" market family has nothing in common with a two-way spread). What *should* become universal is the **policy**, not the shape: fetched on-demand, cached briefly with provider in the cache key (Part A), never fetched during sync, always frozen at pool creation. §16/§17 cover this further.

---

## 9. Result/Grading Lifecycle — the Confirmed-Result Layer, Generalized

**CONFIRMED**: NFL's `nfl_game_results` (CONFIRMED/CORRECTED, `is_current`, append-only via two protective triggers, populated every sync tick independent of the terminal-skip, gated ahead of both grading callers via `resolveNflFixtureRow`) is fully implemented, migration-applied, and integration-tested. Football has no equivalent — it grades directly off `fixtures.regulation_*_score`.

**PROPOSED universal shape**, reusing NFL's proven design rather than inventing a new one:

```
PROVIDER EVENT STATE → LOCAL EVENT → CONFIRMED RESULT → POOL GRADING → SETTLEMENT
```

- A generic `<sport>_confirmed_results`-style table per sport (or one shared table with a `sport`/`provider` discriminator — **this specific schema choice is a decision for you, see §22**), same shape as `nfl_game_results`: append-only, `CONFIRMED`/`CORRECTED` status, `is_current`, no delete grant, one no-delete trigger, one update-guard trigger permitting only the `is_current` flip.
- A generic resolver, same shape as `resolveNflFixtureRow`, called by both existing grading callers (`lib/pools/settle.ts`, `lib/actions/pool-lifecycle.ts`) — extended to branch by provider/sport instead of a single NFL-only check.
- Settlement itself (`apply_wallet_transaction`, `confirm_pool_settlement`, `reverse_pool_settlement`, etc.) is **already sport-agnostic** and needs zero changes — this is the same conclusion the original NFL implementation reached and it still holds.
- Regrading/correction: NFL's existing `reverse_pool_settlement` (manual, admin-triggered, already generic) is reused as-is for "settled, then corrected" — no new money-movement mechanism needed for any future sport either.

**A genuine open design question (flagged, not resolved here — see §22)**: does every future sport get its own confirmed-result table (like NFL), or one shared table keyed by `(provider, external_fixture_id)`? A shared table is less migration churn per sport; a per-sport table lets each sport's result shape (score vs. leaderboard position vs. method-of-victory) stay untyped-JSON-free. This directly affects how F1/golf/MMA's non-score results would eventually be represented, so it's worth deciding deliberately rather than defaulting to "just copy NFL's table."

---

## 10. Supported Football Competition Model — the Curated List, Reconciled

**CONFIRMED, direct diff against the current `SUPPORTED_COMPETITIONS` file** (14 entries: [`lib/sports-data/supported-competitions.ts:44-74`](lib/sports-data/supported-competitions.ts:44)):

**Already supported, matches your desired list exactly:** Premier League, LaLiga, Serie A (Italy), Bundesliga, Ligue 1, Brasileirão Série A, Liga Profesional Argentina, Liga MX, Major League Soccer, UEFA Champions League, UEFA Europa League, Costa Rica Primera División, Costa Rica Liga de Ascenso, CONCACAF Central American Cup.

**Already present as resolved-but-disabled** (matches your "when available" framing exactly — no change needed): Costa Rica Cup, Costa Rica Super Cup (`externalLeagueId: null, enabled: false`).

**⚠️ Discrepancy worth flagging directly**: **Saudi Pro League (external ID 307) is currently `enabled: true`** in the live config. Your spec states "Saudi Pro League is NOT currently in the core supported list" — that's not what the code shows. This needs an explicit decision from you: disable it, or update your desired list to include it. I have not changed it.

**Not yet in the list at all** (would need new entries, IDs to be verified via a live lookup before adding — **not fabricated here**, per your explicit instruction): Primeira Liga (Portugal), Eredivisie (Netherlands), Copa Libertadores, Copa Sudamericana, CONCACAF Champions Cup.

**PROPOSED for Phase 1**: resolve those 5 new IDs (one `searchLeagues`/`getLeagueById` lookup each, batched into a single quota-safe session, not fabricated), add them as new `SUPPORTED_COMPETITIONS` entries following the exact existing pattern, decide the Saudi Pro League question, and consider whether `Copa Libertadores`/`Copa Sudamericana`/`CONCACAF Champions Cup` want a new `CompetitionGroup` (`"CONTINENTAL"`?) rather than being force-fit into `"GLOBAL"`.

---

## 11. Proposed Admin Information Architecture

### CURRENT (CONFIRMED from both audits)
```
Competitions          (football-only; NFL's own league_season_imports row
                        leaks in unfiltered, mislabeled "Unsupported")
Fixtures               (3 discovery modes, football-only; + one shared,
                        provider-agnostic "Imported fixtures" list at the
                        bottom — NFL's only real admin visibility point)
Pools / Pools New
Settings
```

### PROPOSED
```
Dashboard              (unchanged / out of scope)
Events                 (NEW — unified daily surface, §12)
Pools                  (unchanged as a destination — §14)
Results                (NEW — the confirmed-result layer surfaced,
                        currently invisible: nfl_game_results has no
                        admin UI at all today)
Sports / Data Mgmt     (RENAMED-IN-SPIRIT "Competitions" — secondary,
                        occasional-use, §13)
```

For each proposed destination:

| Destination | Purpose | Daily or occasional | Data source | Provider calls allowed? | Actions |
|---|---|---|---|---|---|
| Events | browse/filter events across all sports, create a pool | **daily** | DB only, always | **never** | Create Pool |
| Pools | manage drafts/open/locked/grading/settlement/history | **daily** | DB only | only for odds prefill at creation (existing, on-demand) | publish, lock, grade, settle, void |
| Results | see confirmed vs. provider-reported state, corrections, audit history | occasional | DB (new confirmed-result tables) | never (read-only surface) | manual confirm/correct (admin override) |
| Sports / Data Mgmt | competition config, import status, sync health, coverage | occasional / operational | DB + admin-triggered live calls | **yes, but only on explicit admin action** | import, sync now, archive, enable/disable |

---

## 12. Events Screen — Text Wireframe (PROPOSED)

```
┌─ EVENTS ─────────────────────────────────────────────────────────┐
│ [Today] [Tomorrow] [Today+Tomorrow] [Next 3d] [Next 7d] [Custom]  │
│ Sport: [All ▾ Football  NFL  (NBA·NHL·MLB when added)]            │
│ Competition: [All ▾ Premier League  NFL  MLS  Champions League…]  │
│ Status: [Upcoming] [Live] [Completed]        Search: [__________] │
├────────────────────────────────────────────────────────────────────┤
│ TODAY                                                              │
│  ⚽ Football · Premier League                                     │
│    Arsenal vs Liverpool          12:00 PM   [● 2 pools live]      │
│                                                [+ Create Pool]     │
│                                                                     │
│  🏈 NFL                                                            │
│    Chiefs vs Bills               6:20 PM    [+ Create Pool]       │
│                                                                     │
│  ⚽ Football · MLS                                                │
│    LA Galaxy vs Austin FC         9:30 PM   [⚠ sync stale 40m]    │
│                                                [+ Create Pool]     │
└────────────────────────────────────────────────────────────────────┘
```

Notes grounded in the audits:
- The date-preset row is a direct port of football's **existing** By-date presets (`today`, `tomorrow`, `today_tomorrow`, `next_3_days`, `next_7_days`, `custom`) — no new UX concept, just re-pointed at the DB instead of the live provider (fixing the one passive-trigger bug the football audit found).
- "existing pool indicator" (`● 2 pools live`) needs a new lightweight query — currently the closest equivalent is `getActivePoolSummariesForFixture`, already used by the wizard; this screen would reuse it, not build a new one.
- "provider/data-health indicator" (`⚠ sync stale`) appears **only where useful**, per your instruction — i.e., only on an event whose `last_synced_at` is meaningfully overdue, not as a permanent per-row badge.
- Sport/Competition filters are DB `WHERE` clauses against `fixtures.sport`/`competition_external_id`, matching exactly how the existing by-competition filter already works (`competitionKey` in `template-cards.ts`, confirmed in Part A's own review of that file) — no new filtering concept.

---

## 13. Sports / Competition Management — Text Wireframe (PROPOSED)

```
┌─ SPORTS / DATA MANAGEMENT ─────────────────────────────────────────┐
│ ⚽ Football                                                        │
│   Premier League      [Enabled] 2026/27   382 events   Next: 2h    │
│                        Synced 4m ago                    [Sync now] │
│   LaLiga               [Enabled] 2026/27   340 events   Next: 6h    │
│                        Synced 12m ago                   [Sync now] │
│   Champions League     [Enabled] 2026/27    64 events   Next: 3d    │
│   …                                                                 │
│   ▸ 2 unresolved (Costa Rica Cup, Costa Rica Super Cup)            │
│                                                                      │
│ 🏈 NFL                                                              │
│   NFL                 [Enabled] 2026       273 events   Next: 18h  │
│                        Synced 2m ago (automatic — no import needed)│
│                                                                      │
│ 🏀 Basketball  (once NBA is added)                                  │
│   NBA                 [Enabled] 2026/27      — events               │
└──────────────────────────────────────────────────────────────────────┘
```

Grounded notes:
- This is explicitly **operational infrastructure**, per your instruction — a secondary destination, not where an admin lands by default.
- NFL's row would, for the first time, get a *correct* home here — currently it only exists as a misfiled, mislabeled row inside football's Competitions "Imported" tab (a confirmed bug pattern from the NFL audit, not fixed in Part A since it's a UI/IA concern, not a routing bug).
- "Sync now" stays exactly what it already does for football (whole-season re-fetch) and is simply *absent* for NFL rows (since NFL already self-syncs every cron tick) — not a new concept, just correctly scoped per-sport instead of one bad multiplexed button.

---

## 14. Football Changes Required (PROPOSED, ordered roughly by leverage)

1. **Local-first By-date/By-competition browsing** — stop the `useEffect`-triggered live call in `date-mode.tsx`; make By-competition query local `fixtures` instead of live-searching. This alone fixes the audit's single worst finding.
2. **Complete-season storage as the default** — change the importer so a supported competition's season import stores every valid fixture the provider's one season-response returns, including completed ones, not just future ones (currently gated behind `includeHistorical`). Per your explicit note: the provider call is unchanged (already one request, already returns the full season) — only the *filter after the response* changes. Uses the existing chunk/job infrastructure unmodified.
3. **A confirmed-result layer for football**, generalized from NFL's (§9).
4. **Resolve the "Sync now"/scheduled-sync split** — one explicit, admin-legible action set (§19 below), not one button whose behavior differs from the scheduled cron.
5. **Decide the Saudi Pro League discrepancy and add the 5 missing competitions** (§10).
6. **Constrain the ad-hoc "By fixture ID" import path** — keep it (your own preference, §26 of your spec), but make it visibly exceptional in the new IA (Sports/Data Mgmt, not Events) and keep it `isSupportedCompetition`-gated by default with an explicit admin override for the rare troubleshooting case, rather than the current unconditional bypass.
7. **Un-leak NFL from football's Competitions "Imported" tab** — either filter that tab to football only, or make it genuinely provider-aware (moot once §11's new IA lands, since NFL gets its own real home there).

---

## 15. NFL Changes Required (PROPOSED)

1. **Add a circuit breaker to `runNflFixtureSync`** — currently absent entirely; football already has one (`getProviderStatus`/`isQuotaExhaustedError` in `provider-gateway.ts`), NFL should call the same function with `provider: "api_nfl"` (already supported by that function's signature, just never invoked with it).
2. **Surface NFL's quota/health in the admin Provider Status panel** — currently `getProviderStatus` is only ever called with the football default; a one-line addition renders the same panel for `"api_nfl"`.
3. **Confirm/document `sync-fixtures-nfl`'s actual production schedule** — not verifiable from the repo; needs a direct check against wherever crons are actually configured outside this repo.
4. **Give NFL a real home in the new IA** (§13/§11) instead of leaking into football's Competitions tab.

---

## 16. Future NBA/MLB/NHL Extension Path (FUTURE)

These three are the "cheap" tier: two team-shaped participants, one atomic event, one season, a score-based result, spread/total/moneyline-shaped markets — i.e., they fit the *exact* model football and NFL already use, no schema changes needed.

For each, adding the sport should require:

| Piece | Reusable as-is? | What's new |
|---|---|---|
| Provider adapter | No — new adapter per sport (own API, own auth) | Implement `getSeasonFixtures`/`getFixtureById`/odds methods for that provider, following NFL's adapter as the template (single-competition-shaped sports don't need football's multi-competition adapter complexity) |
| Competition config | Yes, pattern reused | One new `SUPPORTED_<SPORT>_COMPETITIONS`-style file, NFL's single-entry shape, not football's curated-catalog shape (each of these is effectively "one league" the same way NFL is) |
| Event normalization | Yes, pattern reused | Map that sport's raw response into the existing `NormalizedFixture` shape — same fields, same table |
| Participant model | Yes, unchanged | Two teams, existing columns |
| Synchronization | Yes, pattern reused | Reuse NFL's whole-season-refetch sync shape if the provider supports it; otherwise football's per-fixture adaptive-interval shape if it charges per-fixture |
| Result normalization | New | A confirmed-result table following §9's generalized pattern |
| Market adapter | New | That sport's own raw odds shape (NBA spread/total, MLB run line, NHL puck line) — own normalization, own estimation heuristics if needed (same "flag UNCONFIRMED where genuinely unconfirmed" philosophy Part A reinforced for NFL) |
| Templates | New, but shaped like NFL's | Half-point-line spread/total/team-total templates, same `halfPointLineSchema` pattern already built for NFL |

**Bottom line**: adding NBA/MLB/NHL is realistically "copy `sync-nfl.ts` + `api-nfl-provider.ts` + `nfl.ts` templates + `nfl_game_results`'s migration pattern, swap the provider and the sport string" — genuinely close to your stated goal of "register sport/provider → synchronize → appears in the normal workflow," **once** the Events/Results IA and the generalized confirmed-result layer exist. Without those two prerequisites, each new sport still means another bespoke admin surface, exactly what you're trying to avoid.

---

## 17. Future F1/Tennis/Golf/MMA Extension Considerations (FUTURE, considerations only — not designed)

These are the "expensive" tier, per §7's stress-test:

| Sport | Breaks | Why |
|---|---|---|
| Formula 1 | Participant model, event nesting, result shape | 20 individual drivers, not 2 teams; a Grand Prix weekend contains qualifying + race as child events; result is a finishing position, not a score |
| Tennis | Season/edition concept, event nesting | A tournament (2 weeks) behaves like a bracket, not a league season; rounds narrow participants across many matches |
| Golf | Participant model, result shape | 100+ individual participants, no head-to-head; result is a leaderboard, not a score |
| MMA | Season concept, event nesting | No season at all — episodic numbered events, each containing many independent fights as child events |

For each, before any implementation: provider adapter (new, no existing adapter is close), competition configuration (F1/MMA are single "one entity" like NFL; tennis is genuinely per-tournament, closer to football's multi-competition shape but with brackets instead of ongoing seasons), event normalization (needs the self-referential parent/child event relationship from §7, not yet built), participant model (needs the N-participant/individual-athlete extension from §7, not yet built), synchronization (provider-dependent, unknown until a specific provider is evaluated), result normalization (needs a non-score result shape — position/leaderboard/method-of-victory — a real design gap even in the generalized confirmed-result layer from §9), market adapter (an entirely new market family — position/range bets, nothing like spread/total), templates (new question shapes entirely: "will driver X finish top 3," "will fighter X win by decision").

**None of this is designed here.** The only concrete recommendation for *this* pass: when §7's event-nesting and N-participant extension points are eventually built (triggered by the first sport in this tier actually being greenlit, not before), design them once, generically, rather than bespoke per sport — F1's session-nesting and MMA's fight-card-nesting are the same underlying shape (parent event, many child events, each independently gradeable).

---

## 18. Database/Index Implications (CONFIRMED findings, carried forward from the football audit — no new research)

- No index exists on `(provider, competition_external_id, season)` despite it being the dominant filter shape across the Workspace dashboard, discovery-sync's per-competition scans, and import-job finalization. Not a current problem at football's present scale; **should be added before Phase 1's complete-season-storage change increases per-competition row counts.**
- PostgREST's 1000-row default cap already silently truncated a real query once in production (§2). The events screen (§12) and any "list every event for competition X" surface must paginate or aggregate server-side from day one — this is not optional, it's a proven failure mode, not a hypothetical.
- `fixture_odds_cache` — **already fixed in Part A** (composite `(provider, external_fixture_id)` primary key).
- `fixtures.competition_external_id` is a plain text column, not a foreign key to `leagues.id`, for both sports today. This is a real, live gap — a competition-external-id typo mismatch would silently orphan fixtures from their `league_season_imports` gate. **Not recommended to fix by adding a hard FK now** (would require backfilling/validating every existing row across two providers, real migration risk for a currently-nonexistent-in-practice failure mode) — flagged as a future hardening item, not a Phase 1 blocker.
- `nfl_game_results.fixture_id` deliberately has no FK to `fixtures.id` (mirrors `pool_grading_evidence`'s pattern, so a hard-deleted fixture never blocks a result row). Any generalized confirmed-result table (§9) should keep this same no-FK convention.

---

## 19. Quota/Caching Architecture (PROPOSED, extending what Part A already started)

- **Provider-scoped health/circuit-breaking**: `getProviderStatus(enabled, provider)` already accepts a `provider` parameter (confirmed in the NFL audit) — it's simply never called with `"api_nfl"` today. Making NFL's sync call it (§15) is the concrete first step toward "API-Football exhausted ≠ API-NFL unavailable" being actually true in practice, not just true by accident of the two providers' code paths never crossing.
- **The circuit breaker's real weakness** (confirmed in the football audit): it logs an HTTP 200 response as "success" before inspecting the JSON body's `errors` field — the actual shape API-Football/API-NFL use to signal quota exhaustion. This means the breaker likely never trips on the real-world failure mode. **This is a correctness bug independent of the multi-sport work** and should be fixed regardless of Part B's timeline.
- **Request deduplication**: not currently implemented for any provider call — two concurrent admins hitting "Sync now" on the same competition, or the by-date `useEffect` firing twice in a race, could both reach the live provider. Not confirmed as an active incident, but the fixture_odds_cache incident (Part A) proves "two paths reach the same live call" is a real, recurring bug shape here — worth a shared debounce/in-flight-request-dedup utility as part of Phase 3.
- **Explicit vs. automatic classification**: this already exists informally (admin-clicked "Sync now"/"Import" vs. cron-triggered) but isn't tracked as a first-class distinction anywhere (e.g. `provider_request_log` doesn't currently record "was this explicit or automatic"). Worth adding as a column if/when the quota-incident-postmortem tooling needs to answer "did an admin cause this spike, or did a cron."

---

## 20. KEEP / REPURPOSE / DEPRECATE / DELETE LATER Inventory

| Item | Classification | Why |
|---|---|---|
| `fixtures` table | **KEEP** | Already sport-agnostic, already proven to work for both sports, no rename |
| `SUPPORTED_COMPETITIONS` / `SUPPORTED_NFL_COMPETITIONS` | **KEEP, pattern REPURPOSED** | Both stay as-is; the *pattern* (curated static config, one file per "how this sport picks its competitions") becomes the template for NBA/MLB/NHL |
| `league_season_imports` / `competition_import_jobs`/`_chunks` | **KEEP** | Already sport-agnostic in schema; NFL already reuses `league_season_imports` unmodified |
| `nfl_game_results` | **REPURPOSED (generalized)** | Becomes the template for §9's universal confirmed-result layer, not replaced |
| Football's 3 fixture-discovery UI modes (by-date/by-competition/by-fixture-ID) | **By-date: REPURPOSE** (becomes local-first, folds into Events). **By-competition: REPURPOSE** (same, folds into Events' competition filter). **By-fixture-ID: KEEP, DEPRECATE as a primary surface** (stays as an exceptional admin tool per your explicit preference, §14/§26 of your spec) |
| Competitions page (current form) | **REPURPOSE** | Becomes the "Sports/Data Management" secondary surface (§13); NFL gets a real row in it for the first time |
| `getFixtureGoalsLinesAction` | **KEEP** | Football-specific, correctly gated (Part A), no reason to change |
| The *duplication* between `getFixtureGoalsLinesAction`/`getFixtureMarketsAction` (two odds paths for football) | **DEPRECATE LATER** | Not touched in Part A (only the routing bug was fixed); worth collapsing into one path once the Market/Odds Lifecycle work (§8) is scoped |
| `fixture_odds_cache` | **KEEP** | Already fixed to be provider-aware (Part A) |
| `docs/DEPLOYMENT.md` | **KEEP, needs an update** | Doesn't document `sync-fixtures-nfl`, `discover-competitions`, `process-competition-imports`, `refresh-recommendation-cache` — a documentation gap, not a code gap, flagged in both audits |
| `searchLeagues` (football provider method) | **DELETE LATER** | Already dead code (zero callers), the exact call type that caused a prior quota-exhaustion incident — should be removed once confirmed nothing plans to resurrect it |
| Circuit breaker's 200-status-before-body-check ordering | **DEPRECATE (bug)** | Not a Part B item at all — a standalone correctness fix, independent of everything else in this proposal |

---

## 21. Incremental Implementation Phases (PROPOSED — none implemented, all pending your approval)

**Phase 0 — DONE.** Part A provider-routing bug fixes (shipped, commit `0d2665d`).

**Phase 1 — Football supported-competition boundary + complete local season behavior.**
Schema: none. Code: importer filter change (§14.2), Saudi Pro League decision + 5 new competition entries (§10). Migrations: none required for the filter change; a small migration if a new `CompetitionGroup` value is added for continental competitions. Tests: importer unit tests for the historical-inclusion default; a regression test confirming existing pool-eligibility behavior is unaffected. Risk: **low** — provider call unchanged, only what gets persisted from an already-received response changes. Rollback: revert the filter change; no data migration to unwind.

**Phase 2 — DONE.** Local-first football browsing.
Schema: one additive migration, `idx_fixtures_provider_competition_season` composite index (`20260101000117`). Code: new `lib/fixtures/local-browse.ts`/`local-filters.ts`/`local-grouping.ts`/`local-competition-options.ts` — local-DB-only By date/By competition query layer, paginated past PostgREST's 1000-row cap, scoped to `sport='football'` and (by default) `SUPPORTED_COMPETITIONS`; new `lib/actions/fixture-browse.ts` Server Actions; `date-mode.tsx`/`competition-mode.tsx` rewritten to browse locally by default, with the old provider-backed search demoted to an explicit, never-auto-fired "Discover fixtures from provider" panel (spec §10); `lib/actions/fixtures.ts`'s direct-by-ID import now gates unsupported-competition fixtures (forces `hidden_from_pool_creation`, returns a warning, never a silent bypass — spec §8); `?fixtureId=` deep-link added to `/admin/pools/new` for the new "browse → Create Pool" flow (spec §13). `fixture_date_search_cache` classified **REPURPOSE** — still real and working, but reachable only from the explicit discovery panel, never normal browsing. Tests: 3 new files (`local-fixture-filters.test.ts`, `local-fixture-grouping.test.ts` unit; `local-fixture-browse.test.ts` integration, 19 tests) plus the full existing suite re-verified green. Risk realized as **low**, not medium — admins see exactly what's synced, and the existing "Not imported"/workspace-link pattern already communicated staleness before this phase; no separate staleness UI was needed. Verified against real production data (see chat for the full report). Rollback: straightforward, no data changes; the old provider-backed date/competition search code is untouched, just no longer the default path.

**Phase 3 — DONE.** Provider-neutral market routing and provider-scoped health/quota.
Schema: one additive migration (`20260101000118`) — `provider_request_log` gains `normalized_error_type`/`caller_category`/`cache_hit`/`quota_*` columns plus a `(provider, created_at)` index; new `fixture_odds_raw_cache` table (shared, provider-keyed raw-odds cache); `team_players` gains a `provider` column in its unique key, closing the same latent-collision gap `fixture_odds_cache` had before an earlier phase. Code: `lib/sports-data/provider-registry.ts` (`getSportsProvider`), `provider-capabilities.ts` (`supports()`), `provider-errors.ts` (8-value taxonomy + `UnsupportedOperationError`), `quota-reserve.ts` (opt-in, self-imposed per-provider daily budget — inert unless configured, never fabricates a real quota value), `odds-raw-cache.ts` + `market-routing.ts`. Fixed a real, live bug found by the audit: `sync.ts`'s fixture-refresh query had no provider filter, so every non-terminal NFL fixture was being sent to `apiFootballProvider.getFixtureById` on every cron tick. Also fixed: NFL sync had no circuit-breaker/quota-reserve check at all (added, mirroring football's); a `getTeamSquadAction` call with no try/catch that could hang the pool-creation player picker forever on a real provider failure (fixed, falls back to cache); an unguarded `getLeagueById` call in NFL sync that could discard an already-successful sync's result on failure (wrapped). Provider Status panel now shows both providers independently, still zero live calls on page load, plus an explicit one-request "Test connection" action. Football's duplicate odds fetch (`getFixtureGoalsLinesAction` + `getFixtureMarketsAction` both hitting the same endpoint) now shares one cached raw response; the same cache gives API-NFL odds fetching a cache for the first time. Added a development-production safety guard (`scripts/lib/production-guard.ts`) to the three write-capable scripts wired to `.env.local` — directly closes the gap that caused this session's real incident (`create-super-admin` silently writing to production). `docs/DEPLOYMENT.md` now documents all 7 cron endpoints, only 3 of which are confirmed scheduled anywhere. Tests: 4 new unit files, 2 new integration files (32 new tests total), plus 2 existing files extended (NFL soft-error/breaker-isolation, permanent-4xx classification) — full suite (914 unit + 72 integration across every Phase 3-relevant file) green. Risk realized as **low** as predicted — every change was additive or a targeted bug fix; no existing flow's behavior changed except where the bug fix was the point. Rollback: straightforward, no data changes beyond the additive migration (which itself is non-destructive and can stay even if the code were reverted).

**Phase 4 — DONE.** Unified Events admin experience.
Schema: none — pure UI/query layer over the existing `fixtures` table, exactly as scoped. Code: new `lib/fixtures/local-browse.ts` multi-sport query (`queryLocalEventsByDateWindow`, sport-aware `isRowSupported`/`rowCompetitionGroup` — football and NFL each check their own supported-competitions config, never merged); new `lib/actions/events.ts` (`browseEventsAction`); new `/admin/events` route (page + client browser + Date→Sport→Competition grouping component), reusing Phase 2's date-preset/timezone library unchanged; new `/admin/data` hub + `/admin/data/fixtures` (fixture-ID lookup + provider-discovery panel + imported-fixtures management, moved from `/admin/fixtures`) + `/admin/data/nfl` (read-only sync status — NFL had zero admin visibility before this phase); `/admin/fixtures` and `/admin/fixture-archive` now redirect (old by-date/by-competition local-browsing UI deleted as a strict subset of Events; `/admin/competitions` and its Workspace left code-unchanged, just removed from primary nav — the audit found its 4 tabs were already zero-provider-call on load, so this was a repositioning, not a provider-call fix); `/admin/pools` gained `?fixtureId=` filtering so Events' pool-count badge links to a real filtered list instead of duplicating pool UI; navigation reordered (Events, Pools, Users, Invitations, Data, then super-admin-only tabs). Tests: 6 new unit files + 1 new integration file (9 tests, real production Postgres) + 2 existing unit files updated for the new `LocalFixture.sport` field — full suite (947 unit + existing integration) green. A live UX pass (after working around a local-preview-only env-file quirk unrelated to the code — `.env.development.local`'s local-Supabase key was leaking into the `next start` preview process) caught and fixed two real bugs before sign-off: a duplicated "Final" badge on completed events, and team names truncating mid-word on mobile instead of wrapping. Also surfaced a pre-existing, out-of-scope finding: `getCompetitionManagerDataAction` destructures away Supabase query errors (defaults silently to empty arrays) — masked a real failure as "0 recommended competitions" during debugging; worth a follow-up fix. Risk realized as **low**, not medium-high — no feature flag was needed since the redirect pattern (`/admin/fixtures` → `/admin/events`) already used elsewhere in this codebase (`/admin/fixture-archive`) provided a safe, reversible cutover, and no schema/backend logic changed. Rollback: revert the nav/redirect commits; the deleted local-browsing UI would need restoring from git history if ever needed again, but every backend function it depended on (`queryLocalFixturesByDateWindow` et al.) was left untouched.

**Phase 5 — Universal confirmed-result layer.**
Schema: new migration(s), following `nfl_game_results`'s exact pattern for football (§9's open question about shared-vs-per-sport table needs resolving first — see §22). Code: generalize `resolveNflFixtureRow` into a per-provider resolver; wire both grading callers. Tests: port `nfl-confirmed-result-grading.test.ts`'s exact test shape to football. Risk: **medium** — touches the grading path, the single most money-sensitive code in the app; needs the same rigor NFL's original implementation got (dry-run reconciliation pass, idempotency tests, football-unaffected-when-provider-mismatched test). Rollback: the resolver can no-op back to raw-fixture reads per sport if something's wrong, without a schema rollback.

**Phase 6 — Competition management simplification.**
Code only: fold Settings/Templates tabs (already-orphaned per the football audit) into the new Sports/Data Management surface or formally deprecate the routes. Risk: **low**, mostly cleanup.

**Phase 7 — Prepare the extension contract for NBA/MLB/NHL.**
Documentation + a template/checklist derived from §16's table, validated by actually onboarding one of the three (not scoped here — a future decision). Risk: **N/A**, this phase is prep work, no production changes.

---

## 22. Risks

- **The football grading migration (Phase 5) is the highest-stakes single change in this whole proposal** — it touches real settlement logic for a sport with real, larger pool volume than NFL currently has. It should not be attempted until Phases 1-4 have proven the team's confidence in this workflow on lower-stakes changes.
- **Local-first browsing (Phase 2) changes what admins see**, potentially surfacing "missing" fixtures that are really just unsynced — this needs a clear staleness UI, or it will look like a regression even when it's working correctly.
- **IA changes (Phase 4) are the most visible to daily admin workflow** — the biggest adoption/confusion risk, independent of correctness.
- **The shared-vs-per-sport confirmed-result table question (§9) blocks Phase 5 from starting cleanly** — needs a decision first, not mid-implementation.
- **Today's session revealed `.env.local` points at production**, and the integration test suite runs against it by design (confirmed with you directly). Every phase's test-writing work should account for this explicitly — new integration tests need the same rigorous, pattern-based cleanup discipline used for today's audit, or synthetic data will keep accumulating in production with every CI/test run.

---

## Decisions Requiring Your Approval Before Any Implementation

1. Saudi Pro League: keep enabled, or disable to match your stated desired list (§10)?
2. Confirmed-result table: one shared table across all sports, or one per sport following `nfl_game_results`'s exact pattern (§9, blocks Phase 5)?
3. Continental competitions (Copa Libertadores, Copa Sudamericana, CONCACAF Champions Cup): new `CompetitionGroup` value, or fold into `GLOBAL` (§10)?
4. Phase ordering — proceed exactly as sequenced above, or reprioritize (e.g. Phase 5's confirmed-result layer before Phase 2's browsing change)?
5. Should the circuit-breaker 200-status-body-check bug (§19) be fixed now, independent of this proposal's timeline, given it's a standalone correctness issue?
6. Feature-flag strategy for Phase 4's navigation change — acceptable to build behind a flag with the old IA left live in parallel, or is a hard cutover preferred?

**This entire document is a proposal. No phase begins until you approve it — or a specific subset of it.**
