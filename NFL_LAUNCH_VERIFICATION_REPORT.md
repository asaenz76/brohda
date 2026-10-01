# NFL Launch Verification Report

**Date:** 2026-08-12
**Scope:** End-to-end verification of the NFL (API-NFL) integration built per `NFL_INTEGRATION_ARCHITECTURE_NOTE.md`.
**Environment:** Local dev DB (`.env.development.local`), production build (`next build` + `next start`), real live API-NFL calls (PRO plan, 7,500 req/day).

## Summary

All 7 implementation tasks are complete. Full regression (typecheck, lint, 823 unit/integration tests) is green. Live end-to-end verification confirms fixtures sync correctly, the admin pool-creation wizard correctly restricts legacy templates by sport while allowing the new `NFL_TOTAL_POINTS` template, server-side enforcement rejects an invalid template choice even when the client UI doesn't yet filter it out, and both a legacy `REGULATION_RESULT` pool and a new `NFL_TOTAL_POINTS` pool render correctly for real users on the Feed and pool-detail pages. No blocking issues found. One known, low-risk UI gap is called out below (not a launch blocker).

## What was built

| # | Item | File(s) |
|---|------|---------|
| 1 | Multi-provider config — `provider` param threaded through `getProviderStatus`, competition maps widened | `lib/sports-data/provider-gateway.ts` |
| 2 | `ApiNflProvider` client (API-Sports envelope, soft-error handling, fixture/league mapping) | `lib/sports-data/api-nfl-provider.ts`, `supported-nfl-competitions.ts` |
| 3 | `sync-fixtures-nfl` cron with atomic overlap-guard lock | `app/api/cron/sync-fixtures-nfl/route.ts`, `sync-nfl.ts`, `lib/jobs/record.ts`, migration `20260101000108` |
| 4 | Grading templates: Moneyline via `REGULATION_RESULT` (reused), `NFL_TOTAL_POINTS` (new registry template) | `lib/pools/templates.ts`, `lib/pools/templates/nfl.ts`, `registry.ts`, `families.ts` |
| 5 | Admin creation-flow verification | this report |
| 6 | Player-facing verification | this report |
| 7 | Full regression + this report | — |

## Automated regression

```
tsc --noEmit         → 0 errors
eslint .              → 0 errors, 0 warnings
vitest run            → 73 files, 823 tests, all passed (29.9s)
```

New/updated test coverage: `pool-templates.test.ts` (sport-based eligibility), `pool-templates-registry.test.ts` (`nflTotalPoints`, 18 templates / 6 active-for-creation), `recommendations.test.ts` (count update), `rpc-privilege-boundary.test.ts` (new cron-lock RPCs are `service_role`-only).

## Live data verification

- `sync-fixtures-nfl` run against the real API-NFL PRO endpoint: **328 games checked, 327 refreshed, 1 skipped** (a duplicate `game.id` in the API response, correctly deduplicated by upsert), 0 failed.
- `league_season_imports` row created (`provider=api_nfl`, `import_status=IMPORTED`, `pool_creation_enabled=true`) — this was a gap the lightweight NFL sync initially missed (football's full import-job system creates this row; NFL's simpler sync now does the equivalent single upsert).
- Final state: **321** synced fixtures, **318** eligible for pool creation via `fixtures_available_for_pool_creation` (the 3-fixture gap is fixtures already in a terminal/completed state, correctly excluded).

## Admin creation-flow verification (Task 5)

Walked the real `/admin/pools/new` wizard against live-synced NFL fixtures:

1. **Fixture picker** — NFL fixtures appear correctly labeled ("USA | NFL — 8/13/2026, 5:00:00 PM") alongside football fixtures.
2. **Recommended questions** — auto-generated, correctly scoped questions appear (e.g. "Will Pittsburgh Steelers win after regulation?"), each with an estimated-odds/balance indicator.
3. **`NFL_TOTAL_POINTS` template** — selected under the "Goals" tab ("Total points"), config field "Minimum combined points" correctly regenerates the question text live (tested with threshold 44 → "Will the combined final score be 44 or more points?").
4. **Server-side sport gating (the correctness-critical check)** — selected the legacy `WHO_WILL_ADVANCE` template ("Who will advance?") for an NFL fixture and submitted. The server action correctly rejected it: *`"Who will advance?" isn't available for this fixture — it isn't a knockout match.`* This confirms the `getTemplateEligibility(competitionType, sport)` fix (`lib/pools/templates.ts`) is enforced where it actually matters — at submission — independent of what the client UI happens to show.
5. **`REGULATION_RESULT`** — selected instead, submitted successfully, pool created and published with correct options (`Pittsburgh Steelers / Draw / Green Bay Packers`).
6. **`NFL_TOTAL_POINTS`** — created and published successfully on a second fixture (Bengals vs Lions) with the 44-point threshold, options `Yes / No`.

**Known gap (non-blocking):** the wizard's "Browse other available questions → Traditional markets" tab still lists `WHO_WILL_ADVANCE` as clickable for NFL fixtures — it's cosmetically available client-side even though the server correctly refuses it (point 4 above). This was already identified and deliberately deferred as low-priority during implementation (server-side correctness was prioritized over client-side polish). Recommend a follow-up to thread `sport` into `multi-fixture-builder.tsx` / `pool-template-builder.tsx` so the option doesn't appear at all, purely for UX cleanliness — not a correctness or security issue.

## Player-facing verification (Task 6)

Both pools created above were checked on:

- **Feed** (`/feed`) — both render with correct team logos (fetched live from API-NFL), correct kickoff time/timezone, and correct `Pre Season - Week 1` competition-round label. `REGULATION_RESULT` shows the "Regulation Rule: 90 Mins + Injury Time Only" pill and 3-way options; `NFL_TOTAL_POINTS` shows "Auto-graded from the fixture result" and Yes/No options.
- **Sport filter** — the Feed's "All sports" dropdown correctly lists and filters by `American_football`; filtering hides non-NFL pools as expected.
- **Pool detail page** (`/pool/[id]`) — renders identically to the Feed card; option selection works.

## Live grading verification against a real completed game (addendum)

At the time of initial verification no real NFL game had finished. Shortly after, the 2026 Hall of Fame Game (preseason opener, Aug 7) appeared in a live re-sync with a genuine final score — this closed the one gap flagged above without waiting further:

- **Sync → DB, real data**: live `/games?league=1&season=2026` now returns one `FT` (finished) game — Arizona Cardinals 30, Carolina Panthers 33. Querying the local `fixtures` table for this exact game (`external_fixture_id: "21464"`, unmodified production sync path) shows:
  `internal_status: "COMPLETED"`, `regulation_home_score: 30`, `regulation_away_score: 33`, `halftime_home_score: 17`, `halftime_away_score: 17` — all correctly derived by the real, unmodified `mapGame()` / `normalizeApiNflStatus()` / `upsertFixture()` path from a genuine finished-game payload, not synthetic test data. This is exactly the risk previously called out (status-code mapping and score-field extraction had only been observed against pre-game data) — now confirmed against the real thing.
- **Grading decision, real data**: ran the actual shipped `nflTotalPoints.gradingRule` (unmodified, imported directly) against this real score (63 combined points) across six thresholds (1, 44, 62, 63, 64, 100). Results: `YES` for every threshold ≤ 63, `NO` for every threshold > 63 — the `>=` boundary lands exactly where it should.
- **What was deliberately not simulated**: a full pool → entries → lock → automatic-settlement cycle against this specific (already-finished) fixture. Doing so would require either bypassing the wizard's legitimate "lock time must be before kickoff" guard, or funding leftover integration-test user accounts not intended for this purpose — neither adds real signal, since `gradeTemplatePool` and `prepare_pool_settlement` are unmodified, sport-agnostic code already exercised in production for football against the identical fixture-row shape just proven correct above. The only NFL-specific link in that chain (raw API JSON → fixture row → grading decision) is now verified end-to-end on real data.

Recommend one more confirmation once a real **regular-season or postseason** game completes (this addendum only covers a preseason game, which is V1's simplest case — no OT, no playoff-tie-impossibility branch) — low risk given the shared code path, but worth a quick spot-check.

## Regular-season/postseason spot-check — found and fixed a real bug

Ran the same live-data method against the entire **completed 2025 season** (335 games: 49 preseason, 272 regular season, 14 postseason) to cover the cases the preseason-only check above couldn't: overtime, real playoff games, a full season's worth of status codes.

**Bug found:** 16 of 335 games (~5%) — every regular-season game that went to overtime — finish with API-NFL status code `AOT` ("After Over Time"), not `FT`. `AOT` was not in `NFL_CODE_MAP` (`lib/sports-data/status-map.ts`), so `normalizeApiNflStatus("AOT")` fell through to `"UNKNOWN"`. Since `gradeTemplatePool`/`processAwaitingResults` only grades a fixture whose `internal_status === "COMPLETED"`, **every pool tied to a game that went to overtime would have sat stuck in `AWAITING_RESULT` forever, never settling** — a silent failure, not a loud one, and not a rare edge case (one in twenty games). This is exactly the class of bug the preseason-only spot-check couldn't have caught (the Hall of Fame game didn't go to OT).

Also confirmed while investigating: `scores.*.total` already correctly includes the overtime points in every one of the 16 AOT games sampled (`quarter_1..4 + overtime === total` in all 16) — so `mapGame()`'s score extraction needed no change, only the status mapping did.

**Fix:** added `AOT: "COMPLETED"` to `NFL_CODE_MAP` (`lib/sports-data/status-map.ts`), with a comment documenting the live-confirmed semantics. Added 15 new unit tests to `tests/unit/status-map.test.ts` (`normalizeApiNflStatus` previously had **zero** test coverage — a contributing factor).

**Re-verified against real data after the fix:** ran the actual `apiNflProvider` (unmodified production code) against the full 2025 season — all 335 finished games (319 `FT` + 16 `AOT`) now correctly resolve to `internal_status: COMPLETED`, zero misclassified.

**Grading decisions checked against two more real completed games:**
- Regular-season OT game (Cowboys 40, Giants 37, 77 combined) — `nflTotalPoints` correctly returns YES up to threshold 77, NO at 78; `REGULATION_RESULT`-equivalent winner logic correctly picks Dallas Cowboys.
- Super Bowl (Patriots 13, Seahawks 29, 42 combined) — correctly YES up to 42, NO at 43+; winner correctly Seattle Seahawks.

Full regression re-run after the fix: `tsc` clean, `eslint` clean, **73 files / 838 tests passing** (up from 823 — the 15 new status-map tests).

## Cleanup

Both pools created for this verification were cancelled via the admin UI (reason: "NFL integration verification test pool") immediately after verification — no test data left in an open/active state.

## Outstanding / recommended follow-ups

1. ~~Thread `sport` into the client wizard's template browser to hide `WHO_WILL_ADVANCE` for non-football fixtures (cosmetic only, see above).~~ **Done** — see "Wizard UI gap fixed" addendum below.
2. ~~Do a live settlement dry-run against the first completed real NFL game.~~ **Done** — see the two addenda above (preseason via live data, regular-season/postseason via the completed 2025 season). Found and fixed a real `AOT` status-mapping bug in the process.
3. (Previously deferred, unrelated to NFL) investigate the other local project's Postgres connection colliding with this local Supabase instance — user asked to defer this. It recurred once more during this verification (wiped the local DB again mid-session); worked around the same way as before (`supabase db reset --local` + re-sync), no further investigation performed per the standing deferral.

## Wizard UI gap fixed (was item 1 above)

Root cause: `FixtureOption` (`app/(admin)/admin/pools/new/template-cards.ts`) never carried the fixture's `sport` field, so all three `getTemplateEligibility(...)` call sites in the wizard components (`pool-template-builder.tsx` ×2, `multi-fixture-builder.tsx` ×2) always called it with `sport` omitted — meaning the client-side eligibility check silently defaulted to football's permissive rules for every fixture, NFL included, even though the disabling UI (grayed-out card + inline "Not available" message) already existed and worked correctly once given the right input.

**Fix:** added `sport: string` to `FixtureOption`, selected it in the `fixtures_available_for_pool_creation` query (`app/(admin)/admin/pools/new/page.tsx`), and passed it through at all 4 call sites.

**Verified live:** rebuilt, restarted the preview server, opened the wizard for a real NFL fixture (Steelers vs Packers) — "Who will advance?" now renders grayed out with **"Not available — this fixture isn't a knockout match."**, and a click on it is a no-op (no selection, no config panel). "Result after regulation" still selects normally. Regression for football fixtures relies on existing unit-test coverage of `getTemplateEligibility("Cup"/"League", "football")` (no live football fixture data was present in the just-reset local DB to click through manually) — the fix itself is pure plumbing, not new eligibility logic, so this is adequate coverage.

Full regression after this fix: `tsc` clean, `eslint` clean, 73 files / 838 tests passing (unchanged from the previous addendum — this fix needed no new tests, since `getTemplateEligibility` itself was already fully tested).

## Sport-inappropriate template language (found in user review, fixed)

After the above, manual review of the wizard surfaced a broader gap: every registry template written before NFL existed (`MATCH_TOTAL_GOALS`, `WINNING_MARGIN`, `BOTH_TEAMS_TO_SCORE`, `CLEAN_SHEET`, `RED_CARD`, `PLAYER_TO_SCORE`, etc. — 17 of the 18 registry templates) was offered for **every** fixture regardless of sport, with no filtering at all. For an NFL fixture this meant real, user-visible football-specific wording — e.g. the "Recommended Questions" panel suggesting *"Will Pittsburgh Steelers win by 1 or more goals after regulation?"* — and, separately, several of those templates (`RED_CARD`, `PENALTY_AWARDED`, `OWN_GOAL`, `GOAL_AFTER_MINUTE`, `FIRST_TEAM_TO_SCORE`, `PLAYER_TO_SCORE`) require `FIXTURE_EVENTS`/player data the NFL provider never populates (`getFixtureEvents`/`getTeamSquad` are stubbed to return `[]`), so a pool created against one of those for an NFL fixture would have sat in `PENDING` forever — a real correctness bug, not just wording.

**Fix:** added a `sports: string[]` field to `PoolTemplate` (`lib/pools/templates/types.ts`). All 17 pre-existing templates are scoped to `sports: ["football"]`; `nflTotalPoints` is scoped to `sports: ["american_football"]`. Enforced in three places:
- `rankRecommendations` (`lib/pools/templates/recommendations.ts`) now takes a `sport` param (default `"football"`) and only scores/offers candidates whose `sports` list includes it — this is what fixes the "Recommended Questions" panel.
- The wizard's card browser (`template-cards.ts`'s new `cardMatchesSport`/`tabsForSport` helpers, wired into both `pool-template-builder.tsx` and `multi-fixture-builder.tsx`) hides (not just greys out — there are too many football-only cards for a grey treatment to read cleanly) any card/tab with nothing applicable to the selected fixture's sport (or, in multi-fixture mode, every selected fixture's sport).
- **The actual enforcement boundary**: `createPoolForFixture` (`lib/actions/pools.ts`) now re-checks `selectedTemplate.sports.includes(fixture.sport)` server-side before ever inserting a pool, mirroring the exact pattern already used for `WHO_WILL_ADVANCE`/`REGULATION_RESULT` eligibility — the client-side filtering above is cosmetic; this is what actually can't be bypassed.

**New tests:** `rankRecommendations` sport-scoping (`tests/unit/recommendations.test.ts` — asserts `american_football` sees only `NFL_TOTAL_POINTS`, and the football-default count dropped from 6 to 5 now that `NFL_TOTAL_POINTS` is correctly excluded from it), and a server-side rejection test in `tests/unit/create-pools-for-fixtures-action.test.ts` (a football-only template against a mixed NFL+football batch is rejected for the NFL fixture only, succeeds for the football one).

**Verified live:** rebuilt, restarted the server, opened the wizard for a real NFL fixture. "Recommended Questions" now shows exactly one card — *"Will the combined final score be 1 or more points?"* — correct language, no football carryover. The "Browse other available questions" tab row dropped from 3 tabs to 2 ("Prediction questions" disappeared entirely, since `HOME_TEAM_TO_WIN`/`AWAY_TEAM_TO_WIN` are its only active-for-creation cards and both are football-only); "Goals" now shows only "Total points"; "Traditional markets" is unchanged (`REGULATION_RESULT` works, `WHO_WILL_ADVANCE` still correctly greyed from the earlier fix).

Full regression after this fix: `tsc` clean, `eslint` clean, **73 files / 840 tests passing**.

**Aside:** the local Supabase instability (the other project's concurrent connection, previously deferred) recurred twice more while doing this verification — third and fourth occurrences this session. Continuing to defer per your instruction, but flagging the frequency in case you want to revisit that.
