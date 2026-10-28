# A Member's record (Brohda 2.1 M5)

> Your profile tells the story of how often you were right, how you did when someone called BS, and who you played.

The record is **arithmetic over canonical rows**. Nothing is stored, cached, counted incrementally or writable by a Member. No XP, points, levels, badges or ranking, no AI.

## Stat-source map

| Stat | Canonical source | Persisted? | Derived how |
|---|---|---|---|
| Picks: correct / incorrect / void | `predictions` (GRADED rows) | no | `member_record_summary()` (migration 218); parity with the existing `get_user_prediction_record()` is tested |
| Accuracy % | same | no | `correct / (correct + incorrect)`; void is never in the denominator; shown only at ≥ `leaderboard_min_decided_picks` decided picks, otherwise the raw record |
| Recent form (last 10) | decided picks ordered by Game start | no | `member_record_summary()` |
| Current streak / best correct streak | same | no | same; void and pending are ignored (they neither extend nor break a run) |
| This week | `fixtures.scheduled_start_utc` (the Game's week) | no | same; the platform week from `platform_week_bounds()` (Monday, `America/Costa_Rica`), shared with the M6 weekly leaderboard so the two always agree (M5 originally used `graded_at`; changed in migration 219) |
| Backed with Confidence | `confidence_prediction_stakes` joined to graded picks | no | a count of picks and their decided record (never an amount or a score) |
| Sport / sport-season | `predictions → markets → fixtures` (`sport`, `season`) | no | same; a pick with no stored season is left out of the season list (fail closed), never inferred from the date |
| Call BS record | `challenges` (RESOLVED) | no | existing `get_call_bs_record()` (one result per my pick and opponent) |
| Call BS %, most played | same | no | `wins / (wins + losses)` at the same minimum; `member_call_bs_opponents()` (most matchups, then most recent, then id) |
| Head-to-head vs you | `challenges` (RESOLVED) | no | existing `getHeadToHeadRecords()` (unchanged) |
| History | `predictions` | no | paged, 20 a page, stable order |

## Semantics (decisions)

- **Order of picks** is the order the *Games* were played (`fixtures.scheduled_start_utc`), not the order grading ran. Only a pick whose Game row is gone falls back to `graded_at`, then `created_at`.
- **Void** is counted on its own line and is ignored by accuracy, form and streaks.
- **Streak**: the run the most recent decided picks are in ("4 correct in a row", "3 misses in a row", a single pick reads "Last pick correct/incorrect"). **Best** = the longest run of correct picks ever, shown when it is more than one pick and is not already the current correct run; a current run of misses never hides it (M6 fix: M5 compared run lengths regardless of kind).
- **Tiny samples**: the raw record ("1–0") always; a percentage only once a Member has `leaderboard_min_decided_picks` decided picks (the existing, Super-Admin-configurable setting; no new setting). The same rule drives the identity line everywhere (profile header, comments, participants). **Production note:** that setting is currently `1`, so nothing is hidden there until the owner raises it (5 is the schema default and the recommendation).
- **Call BS**: RESOLVED only. Pending, declined, expired (including `PICK_CHANGED`) and accepted-but-unresolved never count.
- **Most Call BS played** is a count of settled matchups, not a "rival": the product has no rule for what makes a rival, so nobody is labelled one.
- **Seasons**: the season list appears only when a sport spans more than one season (with one season the sport row already is the season).

## Public vs own

The public profile shows the same graded-only aggregates it already showed (accuracy, Call BS record) plus form, streak, week, sport/season, Confidence-backed pick *counts* and the most-played opponents — nothing that exposes a pending pick, a Confidence amount, a balance or any private field. The own profile shows the same card; the own predictions list also includes pending picks, as before. The record is read through the service role by the server; the two new functions are not executable by `anon` or `authenticated`.

## Free vs Brohda+

There is no Brohda+ or entitlement code in the product today (nothing to gate). Everything here is free: it is the competitive identity. See the report for what could later be Brohda+ (longer history, filters, trends) — not implemented, no paywall.

## Cost

`getMemberRecord` = two read-only database functions + one profile lookup, a constant number of reads however long the history is (veteran with 1,000 picks and 150 Call BS: ~18 ms end to end locally, the function ~16 ms). No new index: `idx_predictions_graded_user_result` and the Market/Fixture primary keys serve it. If the read fails the profile renders without the card (logged as `[member-record]`).

## Files

`supabase/migrations/20260101000218_member_record_summary.sql`; `lib/member-record/{types,format,repository}.ts`; `components/profile/RecordCard.tsx`; `components/identity/UserIdentity.tsx` (tiny-sample rule); `lib/predictions/repository.ts` (`listUserPredictionsPage`); `app/(app)/profile/{page,predictions-history}.tsx`, `app/(app)/profile/[username]/page.tsx`.
Tests: `tests/unit/member-record/format.test.ts`, `tests/unit/record-card.test.tsx`, `tests/integration/member-record.test.ts` (reference implementation, personas, privacy, timing), `tests/e2e/profile-record.spec.ts`.
