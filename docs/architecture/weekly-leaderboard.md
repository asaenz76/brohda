# The weekly leaderboard (Brohda 2.1 M6)

> Your record says how good you are. The leaderboard says how you are doing against everyone else right now.

One competition: **the current week**, ranked by **accuracy** on graded Picks, for Members who made enough decided Picks to mean something. Pick → Result → Record → Compete → Come back.

Everything is **arithmetic over rows that already exist** (`predictions → markets → fixtures`). Nothing is stored, cached, counted incrementally or writable by a Member. No XP, no points, no engagement score, no paid boosts, no prizes, no AI, no money. No odds, no difficulty, no Confidence, no Call BS and no comments enter the ranking.

## The rules (one sentence: "Ranked by accuracy this week, once you have made N decided Picks")

| Question | Decision |
|---|---|
| The week | Monday 00:00 → next Monday 00:00, `America/Costa_Rica`. One definition, `platform_week_bounds()`, read by the leaderboard **and** by a profile's "This week" (M5's old `graded_at` week is gone: they can no longer disagree). |
| Which week a Pick belongs to | The week its **Game** was scheduled (`fixtures.scheduled_start_utc`), not the week the grading job ran. Grading takes ~3 h (max 7.3 h seen in production), so a Sunday-night Game is graded after Monday 00:00 in Costa Rica; counting by `graded_at` would move it into the next week. Only a Pick whose Game row is gone falls back to `graded_at`, then `created_at` (same fallback as M5). |
| What counts | `GRADED` picks that are `CORRECT` or `INCORRECT`. Pending and void never count toward the record, the accuracy or the minimum. |
| Who is ranked | Decided Picks **this week** ≥ `leaderboard_weekly_min_decided_picks` (default 5, 1–50). Lifetime Picks never qualify a quiet week. Only `role = 'player'` and `is_active` and not closed: staff and deactivated accounts are never ranked (the existing leaderboard exclusion). Blocks are not applied (profiles are visible regardless of blocks today; unchanged). |
| Order | 1. accuracy (exact `correct / decided`), 2. more correct, 3. fewer incorrect (only separates 0% records: 0–3 above 0–5, so volume is never rewarded at zero), 4. Member id only to keep the list order stable. |
| Ties | Members with **identical records share a rank** (1, 1, 3) and are labelled "Tied"; within a tie the order is stable (Member id). Two requests always show the same board. |
| How many are listed | `leaderboard_top_n` (default 20, 3–100). A Member outside the list still sees their own rank, record and "of N ranked". |
| Progress | Below the minimum: "3 of 5 Picks needed to qualify · You need 2 more Picks", never a rank. |
| Reset | None. A new week is a new window; last week's picks stay exactly where they were. There is no Monday job. |
| Audience | Signed-in Members only (the same audience as profiles), and only while `leaderboard_enabled` (default **off**). |

## Settings (migration 219, all independent)

* `leaderboard_enabled` — default `false`. Applying the migration or deploying the code exposes nothing. Off = no page (`/leaderboard` behaves as before M6 and sends a visitor to `/profile`), no navigation entry, nothing computed.
* `leaderboard_weekly_min_decided_picks` — default 5. **Not** the profile percentage minimum.
* `leaderboard_top_n` — default 20.
* `leaderboard_min_decided_picks` (existing) keeps meaning "decided Picks before a **percentage** is shown on profiles" (M5). The weekly leaderboard never reads it. (The column keeps its historical name; the admin label is now "Profile percentage minimum". The retired all-time `get_prediction_leaderboard()` and `get_user_prediction_record().eligible_for_leaderboard` still read it; nothing in the app calls the former.)
* One audited, validated, idempotent Super-Admin function sets all three: `admin_set_leaderboard_policy` (audit action `settings.leaderboard_policy_updated`). A Super Admin sets policy, never a Member's rank.

## Data

`get_weekly_leaderboard(p_viewer_id, p_limit, p_at)` — one read-only, `SECURITY DEFINER`, `search_path=public` function, service role only, returning one jsonb object (week bounds, minimum, top N, total ranked, entries, and the viewer's own standing). `p_at` exists so tests and audits can ask about any week; the app never passes it. Aggregates only: no pick, market, balance or email. The page makes **one** call per request (no per-row lookups, no N+1), parsed through a fail-closed parser; if it fails the page says so and the rest of the app is unaffected.

The existing `get_prediction_leaderboard()` (ALL_TIME / WEEK / MONTH, ordinal ranks, `graded_at` week, shared minimum) was audited and **not reused**: it attributes by grading time, shares the percentage minimum, has no own-position output and is granted to `authenticated`. It is left untouched and unused.

No new index: the access path is `idx_fixtures_scheduled_start` → `idx_markets_fixture_id` → `predictions_market_id_idx`. Measured locally (one week, ~14 picks per Member, 55% accuracy): 100 Members 10 ms, 1,000 Members 45 ms, 10,000 Members (140k graded picks) ~300 ms.

## Files

`supabase/migrations/20260101000219_weekly_leaderboard.sql`; `lib/leaderboard/{types,format,config,repository}.ts`; `app/(app)/leaderboard/page.tsx`; `components/leaderboard/WeeklyLeaderboardView.tsx`; navigation `components/shell/{nav.ts,LeftNav,MobileNav,AuthenticatedShell,AuthenticatedPage}`; admin `components/admin/LeaderboardCard.tsx`, `lib/actions/leaderboard-admin.ts`.
Tests: `tests/unit/leaderboard/*`, `tests/integration/weekly-leaderboard.test.ts`, `tests/e2e/weekly-leaderboard.spec.ts` (its own Playwright project).

## Known limits (see the M6 report)

Gameable in the obvious ways (cherry-picking heavy favourites, stopping after a perfect start, making only the minimum); accepted and documented, not "solved" with odds, difficulty or an opaque score. No last-week archive, no per-sport board, no rank-change notifications.
