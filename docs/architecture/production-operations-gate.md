# Production Operations Gate (Milestone R13.5)

Resolves the two remaining blockers from R13 (`docs/architecture/
security-production-readiness.md`): the Call BS reputation farming
product decision, and Brohda's three unscheduled production-critical
lifecycle jobs.

## Call BS reputation dedup rule

**Rule**: One Pick can contribute at most one Call BS reputation result
against the same opponent.

**Reputation event identity**: `(my Pick id, opposing user id)` — not the
Challenge id, and not the opponent's specific Pick id. Two resolved
Challenges sharing the same (my Pick, opponent) pair collapse to a single
counted result; two resolved Challenges involving my same Pick against
*different* opponents each count independently; my same opponent
challenged via a *different* one of my Picks also counts independently.

**Why this identity, and why it was possible to farm at all**: R7
(`20260101000154_call_bs_challenges.sql`) deliberately allows the exact
same Pick pair to be challenged, accepted, and resolved more than once
over time — `accept_call_bs()`'s own comment states a Pick already locked
by a prior accepted Challenge is "fine and expected," and only a `CUTOFF`
lock blocks acceptance. Locking a Pick only ever blocks *editing* it via
`set_pick()`; it never blocks that Pick from being referenced by another
Challenge. Combined with `challenges_one_pending_pair`'s unique index only
blocking *concurrent PENDING* duplicates (not sequential ones — a new
Challenge on the same pair is allowed once the prior one resolves), two
users could accumulate an unbounded number of resolved Challenges between
themselves, each one counting independently under R11's original
per-Challenge-row counting query.

**Raw Challenge history is untouched.** No Challenge row is deleted,
merged, or rewritten by this milestone. `challenges` remains the complete,
real social history; `get_call_bs_record()` is the one place that
*counts* it for reputation, and only that counting is deduplicated. A
future "Challenge history" UI surface (§13) could still show every
Challenge — the two concepts are deliberately kept distinct in the code
comments and in this document, not just informally understood.

**Contradictory-results audit (§8)**: can two resolved Challenges sharing
a (my Pick, opponent) pair disagree about who won? Audited and found
structurally impossible by construction: a Challenge's result comes
entirely from `decideChallengeResolution()` (`lib/challenges/
resolution.ts`), which compares the two Predictions' own `result` columns.
My Pick's `result` is fixed once GRADED and — as of R13's own
`forbid_graded_prediction_mutation` trigger — immutable thereafter at the
database level, not just by convention. Every valid opposing Pick on the
same Market is graded against the exact same deterministic Market
outcome, so it is always the logical inverse of my Pick's own result (or
VOID, uniformly, if the Market itself voids), regardless of which
specific opposing Prediction row is used or how many times the pair is
re-challenged. Verified empirically against live local data with zero
contradictions found (`tests/integration/reputation-leaderboards.test.ts`'s
own "data integrity" test queries `challenges` directly for any (Pick
pair) group with more than one distinct `result` — none exist, and this
test runs as a permanent regression, not a one-time check).

**Implementation**: read-model only, no new column or table. `get_call_
bs_record()` (`supabase/migrations/20260101000164_call_bs_reputation_
dedup.sql`) derives `(my_pick_id, opponent_user_id, outcome)` for every
RESOLVED Challenge involving the caller, then `DISTINCT ON (my_pick_id,
opponent_user_id)` collapses repeats to one row per pair before counting
wins/losses/void. No new index was needed — `challenges` already carries
indexes on `challenger_user_id`/`recipient_user_id`/`status`, and the
query remains a single bounded aggregate over one user's own rows, the
same shape R11 already established (§53 preserved: no unbounded scans, no
N+1, no per-Challenge nested query).

**Scope boundary respected**: Prediction reputation
(`get_user_prediction_record`, `get_prediction_leaderboard`) is completely
untouched — this is a Call-BS-only fix. No Elo, XP, opponent-strength
weighting, or hidden trust score was introduced; the existing plain
wins/losses/void record is unchanged in shape, only in how it counts.
Money never enters the calculation — `get_call_bs_record()`'s own query
never references `monetary_proposals`/`monetary_positions`, verified both
by direct inspection and by a dedicated test proving a real, funded,
committed Monetary Position between the same two users leaves their Call
BS record unchanged.

**Dead code found and documented, not removed**: `lib/challenges/
repository.ts`'s `getChallengeRecordForUser()` — a *non*-deduplicated raw
tally — was found during this audit (§12: "search for every consumer of
Challenge W/L data"). It has exactly one caller anywhere in the codebase:
its own dedicated test (`tests/integration/call-bs-challenges.test.ts`).
It is not wired into any UI surface, so no user-facing screen was ever
showing inconsistent numbers. Left in place (it may be genuinely useful
for a future raw-Challenge-count display, per §13's own distinction) but
is explicitly NOT the reputation source — `get_call_bs_record()` is the
one canonical semantic for reputation, confirmed as the only consumer
wired into `lib/reputation/repository.ts` and from there into
`ReputationSummary.tsx`, the sole UI surface displaying a Call BS record.

## Production lifecycle job automation

Three jobs — grading, Call BS resolution, P2P settlement — previously ran
only via manual CLI invocation. Each now also runs automatically via a
cron route, using the exact same canonical domain function the CLI script
already called; no job logic was duplicated into a route.

| Job | Canonical runner | Cron route | Lock | Batch config | Job history | Schedule |
|---|---|---|---|---|---|---|
| Grading | `runGradingJob()` (`lib/predictions/grading.ts`) | `/api/cron/grade-predictions` | `try_acquire_cron_lock` via `recordJobRun` | `platform_settings.grading_batch_size` (default 200) | `background_jobs` | Every 2 minutes (recommended) |
| Call BS resolution | `resolveAcceptedChallenges()` (`lib/challenges/resolution.ts`) | `/api/cron/resolve-challenges` | same | `platform_settings.challenge_resolution_batch_size` (default 200) | `background_jobs` | Every 2 minutes, offset after grading (recommended) |
| P2P settlement | `runSettlementJob()` (`lib/monetary/settlement-runner.ts`, new — extracted from the CLI script) | `/api/cron/settle-monetary-positions` | same | `platform_settings.settlement_batch_size` (default 500, R12) | `background_jobs` | Every 2 minutes, offset after grading (recommended) |

### Ordering (§30)

Challenge resolution reads `predictions.result`, which only grading
produces; settlement reads both Picks' graded results indirectly through
`settle_monetary_position()`'s own eligibility check. Rather than chaining
these synchronously in one request (fragile — a partial failure in stage
1 would need to somehow still trigger or skip stage 2), each job is
independently idempotent and simply finds nothing to do until its
prerequisite has run on an earlier tick. A resolution or settlement
attempt against not-yet-graded Picks safely reports `stillPending`/
`notEligible` and tries again next tick — proven directly in
`tests/integration/cron-jobs.test.ts`'s "Picks not yet graded" test.

### Failure isolation (§22-23, §26)

Both `runGradingJob()` and `resolveAcceptedChallenges()` previously had no
per-item try/catch — a single bad Prediction or Challenge would abort the
whole batch (and, via `recordJobRun()`'s own rethrow, mark the entire
job's `background_jobs` row as `error`, even though earlier items in the
same run had already succeeded and committed). Both now wrap each loop
iteration in its own try/catch, pushing `{ predictionId, error }` /
`{ challengeId, error }` into a `failures` array on the summary — the
exact shape `lib/prediction-markets/ingestion/nfl.ts` already established
for this pattern. Settlement's own loop (`scripts/settle-monetary-
positions.ts`) already had correct per-item isolation; it was extracted
into `runSettlementJob()` unchanged so the cron route and the CLI script
share it rather than duplicating it.

### Idempotency and concurrency (§35-36, §66)

All three jobs are idempotent at the domain boundary, independent of the
`try_acquire_cron_lock` overlap guard (which is defense in depth, not the
correctness boundary, per §20):

- Grading: `markPredictionGraded()` scopes its own UPDATE with `.eq(
  "lifecycle_state", "PENDING")` — a second concurrent write to an
  already-graded row is a safe no-op.
- Resolution: `markChallengeResolved()` scopes its own UPDATE with `.eq(
  "status", "ACCEPTED")` — same guarantee.
- Settlement: `settle_monetary_position()` (R10) locks the Position row
  `FOR UPDATE`, checks terminal state first, and returns `already_settled`
  rather than re-processing.

`tests/integration/cron-jobs.test.ts` proves this against the real cron
routes, not just the underlying functions: each job is invoked twice in
sequence (second invocation processes nothing new) and concurrently via
`Promise.all` (no duplicate grading, no duplicate resolution notification,
exactly one settlement row per Position).

### Batching (§27)

`grading_batch_size` and `challenge_resolution_batch_size` were added to
`platform_settings` (migration `20260101000165_lifecycle_job_batch_
config.sql`), replacing the hard-coded TypeScript default-parameter
batch size each runner's discovery query previously used (`limit = 200`
in both `listPendingPredictions()` and `listUnresolvedAcceptedChallenges
()`) — classified identically to `settlement_batch_size` (R12), which
this milestone extends `update_operations_settings()` to also manage, in
the same atomic-update-plus-audit pattern, with the same internal
`is_super_admin()` check R13 already added. An operator can change any of
the three batch sizes from `/admin/settings/brohda` with no deployment.

### Job enablement (§31)

No new feature-enablement switch was added for any of the three jobs —
none is needed. `monetary_p2p_enabled` continues to mean exactly what R9/
R10/R12 already established: it blocks *new* proposals and acceptances
only. It was never checked by `settleMonetaryPosition()` and still isn't
— the settlement cron route has no feature-flag awareness at all, proven
directly by `tests/integration/cron-jobs.test.ts`'s "settlement continues
even while monetary_p2p_enabled is false" test, run through the real cron
route.

### Observability (§32-33)

Every run of all three jobs is recorded in the existing `background_jobs`
table via `recordJobRun()` — job name, success/error, started/finished
timestamps, duration, and the full summary (including any `failures`
array) as the stored `result`. No new monitoring product was built; this
reuses the exact mechanism the 7 pre-existing cron jobs already rely on,
and the same `/admin/reports` Job Health surface already reads it.

### Cron route response shape (§37)

Each route returns exactly the job's own summary object (counts and a
bounded `failures: [{ id, error }]` list) — no wallet balances, no
private user data, no full Position details, no raw stack traces.

### Timeout / partial-batch retry (§38-39)

Each item within a batch is its own independent, already-committed
transaction (a single row UPDATE for grading/resolution, one atomic RPC
call for settlement) — if the underlying process were killed mid-batch
(a platform timeout), every item processed before that point stays
correctly committed, and the next scheduled tick's own discovery query
naturally picks up whatever remains (still PENDING / still ACCEPTED /
still COMMITTED). No in-memory cursor is used or needed.

## Scheduler configuration

Uses the exact same architecture as the 7 pre-existing cron routes — no
new scheduler framework, job queue, or lock implementation was
introduced (§17). See `docs/DEPLOYMENT.md` §5 for the full inventory
table and cron-job.org configuration, now including these three routes.
Cadence: every 2 minutes for all three, staggered so grading fires first
— chosen to keep the full social/monetary lifecycle from depending on
manual operation without polling so aggressively that it meaningfully
competes with the 1-minute legacy-pool jobs for the same database. This
is a reasonable operational default, not a consequential product
decision — an operator can tighten or loosen it at any time entirely
within cron-job.org's own dashboard, outside this repository. Nothing
about correctness depends on the exact interval (proven by the
idempotency/concurrency tests above).

## Hard-coding audit (§73)

| Value | Classification | Where it lives |
|---|---|---|
| One-Pick-per-opponent Call BS reputation rule | Product invariant | Encoded directly in `get_call_bs_record()`'s own query logic — correctly hard-coded, per this milestone's own explicit instruction that this rule "may legitimately be encoded as reputation semantics" |
| Grading/Challenge-resolution/settlement batch sizes | Configurable operational policy | `platform_settings.grading_batch_size` / `challenge_resolution_batch_size` / `settlement_batch_size` — admin-configurable, no deployment needed |
| Cron route identity (`/api/cron/grade-predictions` etc.) | Infrastructure configuration | Route file path — inherent to the framework, not a runtime value |
| `try_acquire_cron_lock` job-name strings (`"grade-predictions"` etc.) | Infrastructure configuration | Must match the route's own identity 1:1 for the lock to mean anything; not meaningfully "configurable" independent of the route itself |
| cron-job.org schedule/cadence | Deployment configuration | Lives entirely in cron-job.org's own external dashboard, outside this repository — a Vercel/scheduler cron expression is inherently deployment-layer, matching §28's own explicit carve-out |
| `CRON_SECRET` | Provider-secret configuration | Environment variable, reused unchanged from the 7 pre-existing routes — no new secret mechanism introduced |
| Feature enablement for the three jobs | Deliberately absent | No switch exists or was added — none of R9/R10/R12's existing feature flags (`monetary_p2p_enabled` etc.) gate these jobs, and no new one was introduced; disabling *new* commitments must never imply disabling *fulfillment* of existing ones (§31) |

No mutable operational policy was left unnecessarily hard-coded, and
nothing was moved into configuration merely because a loop contained a
number — each value above was classified before any code was written.

## Readiness reassessment

**SOCIAL TECHNICAL READINESS: GO** (reconfirmed). Call BS reputation
farming is resolved; automated grading and Challenge resolution run
through the exact same canonical, already-audited domain functions R13
found safe, now proven safe through their real production entry points
too (`tests/integration/cron-jobs.test.ts`).

**MONETARY P2P TECHNICAL READINESS: GO** (reconfirmed, with particular
scrutiny per this milestone's own §59). Automated settlement introduces a
new production execution *path* into financial settlement, but not new
financial *logic* — the cron route calls the identical `settleMonetary
Position()` R10 already built and R13 already audited; it derives
nothing itself. Feature-disabled-does-not-block-settlement, exactly-once
settlement under concurrency, and accounting correctness were all
re-verified specifically through the new cron path (not just the
underlying function), and match direct canonical settlement exactly.

**PRODUCTION OPERATIONS READINESS: GO** (upgraded from R13's NO-GO). All
three previously-manual lifecycle jobs now have a production cron route,
authenticate against the existing `CRON_SECRET` mechanism, use the
existing lock/job-history infrastructure, are bounded and retry-safe, and
are proven idempotent and concurrency-safe through their real entry
points. The production build now includes a CI gate. Nothing here means
these are actually scheduled in a live, deployed cron-job.org account —
see "Technical vs. deployed" below.

## Technical vs. deployed

Per this milestone's own explicit boundary: **PRODUCTION OPERATIONS
READINESS: GO** means the repository now contains the required
automation and operational controls. It does not mean cron-job.org has
these three jobs actually configured in a live account, hosted Supabase
has been migrated, or anything has been deployed. `docs/DEPLOYMENT.md`
§5's configuration table documents the intended production schedule; an
operator still has to actually create these three cron-job.org entries
against the real deployed URL before they run in production.

## Legal / compliance boundary

Unchanged from R13: technical readiness does not constitute legal or
regulatory approval for monetary P2P. Nothing in this milestone makes or
implies a licensing, KYC, AML, or jurisdictional-eligibility
determination.
