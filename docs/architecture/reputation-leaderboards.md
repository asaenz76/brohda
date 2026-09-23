# Reputation + Leaderboards (Milestone R11)

## Goal and non-negotiable principle

R11 turns Brohda's existing immutable `predictions`/`challenges` history
into visible social reputation. The one non-negotiable rule the whole
design follows: **reputation comes from predictions, not money.** A user
with $0 and a user with $10,000 are evaluated using the exact same
prediction record. No query in this milestone ever reads
`wallet_balances`, `wallet_transactions`, `wallet_reservations`,
`monetary_proposals`, `monetary_positions`, or
`monetary_position_settlements` — verified directly, and enforced by a
dedicated regression test (`tests/integration/reputation-leaderboards.test.ts`'s
own "Financial isolation" and "Money never affects prediction reputation"
suites).

## Repository truth this design depends on

- **A legacy pool leaderboard already exists** — `get_leaderboard()`
  (`p_scope`/`p_range`/`p_caller_id`), route `/leaderboard`, built
  entirely on `entries`/`user_profiles.correct_predictions_count`/
  `correct_prediction_log`. R11 never touches this table, this RPC, or
  this route. Prediction Network reputation lives at its own route
  (`/leaderboard/predictions`) behind its own RPCs
  (`get_prediction_leaderboard`, `get_user_prediction_record`,
  `get_call_bs_record`), with one small, additive discoverability link
  added to each page pointing at the other — neither page's own existing
  content was otherwise touched.
- **`predictions` RLS is own-row-only**, with no public-read policy
  (confirmed by reading its own migration's RLS section). Exactly like
  the pre-existing `get_leaderboard()`/`get_profile_stats()`/
  `get_pick_count()` already do for their own tables, all three of R11's
  new functions are `security definer`, deliberately bypassing that RLS
  to expose only safe, already-Pick-public aggregate fields — never by
  loosening `predictions`' own RLS policy.
- **No cursor-pagination convention exists anywhere in this codebase**
  (confirmed by an exhaustive audit of every RPC's own argument list) —
  every existing "paginated" RPC is plain `LIMIT`/order, some via
  `.range()`. `get_prediction_leaderboard()` uses plain `LIMIT`/`OFFSET`
  for the same reason: introducing a keyset cursor here would be
  inventing a new pattern, not following an established one.
- **The platform's real timezone convention is not UTC.**
  `lib/analytics/timezone.ts`'s `DEFAULT_ANALYTICS_TIMEZONE =
  "America/Costa_Rica"` is the existing, already-decided platform-wide
  default used for admin/platform-scoped aggregates (e.g.
  `get_platform_monthly_activity`, always called with this constant, never
  a per-viewer zone). A leaderboard's period boundary is exactly that kind
  of shared, non-per-viewer aggregate — so `get_prediction_leaderboard()`
  reuses this exact existing decision rather than inventing a new one or
  silently defaulting to server/UTC wall-clock time the way the legacy
  pool `get_leaderboard()` does today (a pre-existing inconsistency this
  milestone does not attempt to fix).
- **`user_profiles.prediction_current_streak`/`prediction_best_streak`
  columns already exist but are explicitly deferred** — added in
  `20260101000142_prediction_policy_and_reputation_hooks.sql`, never
  written or read (`20260101000145_prediction_streak_columns_deferred.sql`),
  reserved for a future "founder-owned reputation design" milestone. R11
  does not implement streaks, does not write to these columns, and does
  not retire them — they remain exactly as deferred as before.
- **`close_own_account()` already refuses to close any account with a
  nonzero balance** — irrelevant here since R11 never touches wallet
  state, but noted for completeness: a scrubbed (`is_active = false`)
  account's historical predictions/Challenges remain in the canonical
  record; only the leaderboard's own `is_active = true` filter (reused
  verbatim from the legacy `get_leaderboard()`'s own exclusion) keeps a
  closed account off the public leaderboard, exactly mirroring how it
  already excludes `admin`/`super_admin` accounts.

## Canonical prediction record

For each user: `correct`, `incorrect`, `void` (each a plain `COUNT(*)
FILTER`), `decided = correct + incorrect`, and `accuracy = correct /
decided` — **null when `decided = 0`**, never a fabricated 0%. VOID is
counted (shown contextually, e.g. "2 void") but never enters the
`decided` count or the accuracy denominator. This is computed by
`get_user_prediction_record(p_user_id)`, called from
`lib/reputation/repository.ts`'s `getUserPredictionRecord()` — the one
place this calculation exists in the codebase.

### Final Pick, graded Picks only

`predictions` already guarantees one current row per (user, Market) —
R5's own editable-Pick/revision-history architecture means a Pick's
revision history lives in a separate audit trail, never as additional
`predictions` rows. R11 adds nothing to enforce this; it is already true
by construction, and is verified anyway (`tests/integration/reputation-leaderboards.test.ts`'s
"multiple Markets on the same Game each count as an independent
prediction outcome" test proves the *positive* case — two distinct
Markets on one Game correctly produce two reputation outcomes, not one
collapsed count). Only `lifecycle_state = 'GRADED'` rows ever contribute;
a `PENDING` Pick contributes nothing, whether it will eventually grade
CORRECT, INCORRECT, or never grade at all.

## Leaderboard eligibility and ranking

### Minimum sample (§9)

`platform_settings.leaderboard_min_decided_picks` (default `5`) — a
genuinely open product decision, not a founder-sourced number, flagged
explicitly here and in this milestone's own completion report (mirrors
R9's own "Option B" precedent for min/max stake). Read live on every
call; changing it takes effect immediately, with no deployment and no
schema change. A user below the minimum still has their full, real record
visible on their own Profile (§28) — the minimum controls leaderboard
*ranking* eligibility only, never record *visibility*. A user with
`decided = 0` is **never** eligible, regardless of how the minimum is
configured (even a minimum of `0`) — this is a TRUE INVARIANT, not a
policy the config can override.

### Ranking formula (§11, §49-50)

Eligible users (`role = 'player'`, `is_active = true` — reused verbatim
from the legacy `get_leaderboard()`'s own exclusion filter; `decided > 0`
and `decided >= configured minimum`) are ordered by:

1. `accuracy DESC` — exact `NUMERIC` comparison (Postgres's arbitrary-
   precision numeric division), never a JS floating-point comparison.
2. `decided DESC` — a bigger, equally-accurate sample outranks a smaller
   one at the same accuracy.
3. `correct DESC`.
4. `user_id ASC` — a final, fully stable tie-break so no two rows can
   ever compare as equal.

Rank numbers come from `ROW_NUMBER()`, **not** `RANK()`/`DENSE_RANK()` —
every row gets a unique, sequential rank; no two users ever display the
same rank number. This is a deliberate divergence from the legacy pool
leaderboard's own `RANK()`-with-shared-ties convention (that domain's own
product choice, for a different kind of ranking with genuine real-world
ties expected at low volume) — Prediction Network reputation's own tie-
break chain is designed specifically so genuine display-level ties never
happen, matching the task's own explicit "for V1, sequential deterministic
row numbers are simplest" guidance.

## Periods

`ALL_TIME | WEEK | MONTH` — no daily/rolling/season/custom range, per the
task's own explicit "keep V1 small" guidance. The period-assigning
timestamp is `predictions.graded_at` (the moment an outcome becomes
final), never `created_at` (a Pick may be made days before the Game) —
`WEEK`/`MONTH` boundaries are computed via `date_trunc('week'/'month', now()
at time zone 'America/Costa_Rica') at time zone 'America/Costa_Rica'`
(the ISO-week/calendar-month Postgres itself defines, evaluated in the
platform's own timezone). Verified directly:
`tests/integration/reputation-leaderboards.test.ts`'s "Period semantics"
suite proves a Pick graded 30 days ago is excluded from `WEEK` but still
present in `ALL_TIME`.

## Call BS record

A **separate**, wallet-independent head-to-head record from R7's free
Challenges — `get_call_bs_record(p_user_id)` counts only `status =
'RESOLVED'` rows (PENDING/DECLINED/EXPIRED never reach `RESOLVED`, so they
are excluded by construction, not by an extra filter), attributing
wins/losses relative to whichever side (`challenger_user_id` or
`recipient_user_id`) the user was on, with VOID counted separately. A
single Pick may participate in several distinct accepted Challenges
(R7's own multiplicity, §22-23) — each one counts independently toward
the Call BS record, while the underlying Pick still contributes **at
most once** to the prediction record, regardless of how many Challenges
it won or lost. Verified directly: the "multiple accepted Challenges on
the same Pick each count independently, without inflating prediction
accuracy" test has one Pick win three separate Challenges and confirms
the prediction record shows exactly `+1 correct`, never `+4`.

Money never touches this record either: a monetary Position escalating
(or standing independently of) a free Challenge never creates, modifies,
or duplicates a Call BS record entry — `get_call_bs_record()` reads
`challenges` only, never `monetary_proposals`/`monetary_positions`.

## Financial isolation (§92)

No R11 query ever joins a wallet/monetary table. This was true by
construction from the first line of SQL written (the design started from
"predictions and challenges only," not "predictions and challenges, plus
whatever else seemed useful") and is verified by a dedicated regression
test proving a funded, monetary-Position-holding user and a free-only user
with identical Pick results get byte-for-byte identical
`UserPredictionRecord`s, and that a free-only user can legitimately reach
leaderboard rank #1.

## Community-scoped leaderboard: not built in R11 (deliberate, documented)

Explicitly optional per the task's own language ("R11 may support
Community-scoped leaderboard if it can be derived cleanly"). Repository
truth found: TEAM/LEAGUE Communities have clean FK-based joins
(`communities.team_id`/`league_id` → `teams`/`leagues`), but no canonical
"sport" entity exists at all — SPORT Communities use a plain `sport_key`
text column, and `fixtures.sport` is itself a plain text field, not an FK
into any taxonomy. Combined with the real deduplication hazard §67 warns
about (`post_communities` fans one Post into many Communities; a naive
join would double- or triple-count a single Pick), building this
correctly for all three Community types would have roughly doubled this
already large milestone's scope, with no existing product signal (a
milestone-map line, existing UI, or founder request) demanding it now.
Deferred, not silently dropped — this is the same "Option B, document the
gap" discipline this codebase has applied consistently since R9.

## Call BS leaderboard: not built in R11 (deliberate, explicitly permitted)

The task's own §51 explicitly permits skipping a dedicated Call BS
leaderboard page ("do not make it a blocker for core prediction
leaderboard unless required by the milestone map") as long as the Call BS
*record* exists on Profile — it does. No dedicated ranking page was built
for it.

## Query architecture: 100% derived, nothing materialized

Every number in this milestone is computed live, on read, directly from
`predictions`/`challenges` — no new table, no cached/denormalized
counter, no trigger, no background job. This is a deliberate choice, not
an oversight: a materialized counter pattern *does* already exist in this
codebase (`user_profiles.prediction_correct_count`/
`prediction_incorrect_count`, updated transactionally inside
`recordGradedPredictionResult()`, called from the grading job itself) —
but it tracks correct/incorrect only (no VOID), is scoped to the
pre-existing "Market Predictions" Profile tab (an unrelated, untouched
R3-era surface — its own display was confirmed unaffected by R11), and
would need a live, all-time-only read model extended with a *second*,
separately-computed weekly/monthly log (mirroring the legacy pool
leaderboard's own `correct_prediction_log` append-table) to support
R11's own period-scoped leaderboard at all. Given the current, genuinely
modest production scale and the explicit "do not materialize merely
because leaderboards exist" instruction, a live aggregate query — indexed
appropriately — is the smallest architecture that is correct. Because
nothing is stored, there is nothing to ever drift out of sync, and no
reconciliation table is needed (§38): the canonical truth *is* the query
result, every time it runs.

If production scale ever demands Option C (a materialized/cache table),
the existing `prediction_correct_count`/`prediction_incorrect_count`
counter pattern already proves that "materialize inside the grading job
itself" is a viable, tested pattern in this codebase — a natural seam to
extend, not a design that needs inventing from scratch.

### Indexes (§66)

Two new partial indexes, each justified by an actual R11 query shape:

- `idx_predictions_graded_user_result (user_id, result) WHERE
  lifecycle_state = 'GRADED'` — serves `get_user_prediction_record()`'s
  per-user aggregate directly, and narrows the leaderboard's full
  `GROUP BY` scan to graded rows only.
- `idx_predictions_graded_at (graded_at) WHERE lifecycle_state = 'GRADED'`
  — lets the `WEEK`/`MONTH` leaderboard queries range-scan just the
  current window's graded rows.

No index was added purely speculatively; both directly mirror
`predictions_lifecycle_state_idx`'s own existing partial-index
convention (which instead scopes to `PENDING`, for the grading job's own
opposite need).

## Security

All three functions: `revoke all ... from public, anon`, `grant execute
... to authenticated, service_role` — mirroring
`get_leaderboard()`/`get_profile_stats()`/`get_pick_count()`'s own exact
grant shape. Any authenticated viewer may read anyone's reputation,
exactly as broadly as a Pick or a RESOLVED free Challenge is already
itself visible as social content (§42) — this is not a new privacy
surface, it is the same visibility Brohda's product already grants,
computed and presented differently. No email, wallet, balance, deposit
history, or monetary Position amount is ever returned by any of the
three functions — their `RETURNS TABLE` shapes structurally cannot leak
those fields; they were never selected from in the first place. `anon`
cannot call any of the three (verified directly). There is no write
surface at all — a user cannot forge their own record, rank, or Call BS
history, since nothing about reputation is ever written by anything
other than the read-only aggregate queries themselves reading immutable
grading/Challenge-resolution history.

## UI

- **Profile** (`components/reputation/ReputationSummary.tsx`): mounted on
  both the viewer's own profile and any other user's public profile.
  Shows Predictions / Record / Accuracy / (contextual VOID) / Call BS
  (only when any Call BS history exists). Empty state ("No graded
  predictions yet") when there is truly no graded history at all;
  "Not ranked yet" shown distinctly from the record itself whenever a
  real record exists but falls below the configured minimum — these are
  two different questions, never conflated. Deliberately does not modify
  or replace the pre-existing "Market Predictions" tab's own older
  correct/incorrect line (`market-predictions-tab.tsx`) — that display
  predates R11, reads from the separate, older counter described above,
  and remains untouched; R11's own reputation surface is additive.
- **Leaderboard** (`/leaderboard/predictions`): a new, separate route —
  simple ranked list (rank, avatar, name, record, void count, accuracy),
  a `WEEK`/`MONTH`/`ALL_TIME` period tab-switcher mirroring the legacy
  leaderboard's own `searchParams`-driven filter pattern, plain
  previous/next pagination. No wallet/stake/winnings/ROI column exists
  anywhere in this UI. One small, additive link was added to the
  pre-existing legacy `/leaderboard` page (and one back, from the new
  page) — neither page's own existing content was otherwise modified.
  Verified responsive at mobile width (375px) with no horizontal overflow.

## R12 boundary

R11 establishes the raw, transparent prediction and Call BS record and
its leaderboard. It deliberately does not add: streaks (columns already
exist, deferred to a future milestone by an earlier migration's own
explicit reservation), badges, an XP/points economy, a secret rating
algorithm, Community-scoped ranking, or a dedicated Call BS leaderboard.
Any of these remain available for a future milestone to add additively,
exactly the way every prior milestone boundary in this codebase has been
handled.
