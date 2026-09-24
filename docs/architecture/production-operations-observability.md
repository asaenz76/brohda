# Production Operations & Observability (Milestone R13.9)

R13.8's own production deployment audit found two concrete operational
gaps in the otherwise-correct R13.5 lifecycle-job architecture: (1)
`background_jobs.status` could only ever be `'success'` or `'error'`, so
a job that completed without throwing but left per-item failures (e.g.
grading's `failures: [...]`) or a financial `invariant_violation`
(settlement) was recorded identically to a fully clean run; (2) the admin
dashboard's job list (`lib/reports/fetch.ts`'s old `KNOWN_JOBS`) was a
hard-coded 3-entry array that had already drifted from reality — it named
`"sync-fixtures"`, but the real `job_name` recorded by
`app/api/cron/sync-fixtures-nfl/route.ts` is `"sync-fixtures-nfl"`, so
that job's health silently read "never run" indefinitely. This milestone
fixes both, and establishes the production scheduler for Brohda 2.0's six
new lifecycle jobs — without activating any product feature.

## Canonical job registry (`lib/jobs/registry.ts`)

A single, static, typed array — every cron route's identity in one place:
`id` (the exact string passed to `recordJobRun`), `displayName`, `route`,
`category` (`legacy` | `infra` | `brohda-social` | `brohda-monetary`),
`criticality` (`critical` | `standard`), and `expectedCadenceMinutes`
(the documented recommended cadence from `docs/DEPLOYMENT.md` §5).

This is deliberately **not** a database table or an admin-editable
setting. A job's identity/route/cadence is an architectural fact, not
mutable product policy — inventing a settings row for it would violate
the same "don't create configuration infrastructure merely for
abstraction's sake" instruction that shaped this milestone. What operators
*can* reasonably tune is a single global staleness-tolerance multiplier
(below), applied uniformly against every job's own registry cadence.

## Structured degraded status (`supabase/migrations/20260101000166_lifecycle_job_observability.sql`)

Widens `background_jobs.status`'s CHECK constraint to
`'success' | 'error' | 'degraded'` — additive, backward-compatible; every
existing row and every job that never produces a `'degraded'` result
(most legacy jobs) are unaffected.

`lib/jobs/record.ts`'s `recordJobRun()` now classifies a non-throwing
result via `isDegradedResult()` (`lib/jobs/health.ts`), duck-typed against
the field names every relevant job's own result type already,
independently, converged on:

- `failures: Array<...>` — grading, challenge resolution, settlement,
  market ingestion, post publication, community distribution.
- `invariantViolations: number` — settlement only, R10's
  `settle_monetary_position()` outcome for a Position "left COMMITTED,
  needs manual review."
- `failed: number` — the legacy counter shape (`lockDuePools`,
  `processAwaitingResults`, `runNflFixtureSync`) that predates the
  `failures` array convention.

This is not a new job-result schema — it reads exactly the fields these
jobs already reported and previously discarded at the `status` level.

## Financial invariant alerting

A degraded run now unconditionally calls `Sentry.captureMessage()` (the
existing, already-configured integration — no new vendor), tagged
`{ job: jobName, status: "degraded" }`, with `extra: { failureCount,
invariantViolations, failedIds }` — internal object ids only (Prediction/
Challenge/Position ids), never user or financial detail. A settlement run
with `invariantViolations > 0` is raised at Sentry `level: "error"`
("financial invariant violation requires manual review"); a run with only
per-item `failures` is raised at `level: "warning"`. Detection and
alerting only — nothing here automatically retries, repairs, or moves
money. `pnpm check-monetary-consistency` remains the manual reconciliation
tool for actually investigating a flagged Position.

## Job Health (`/admin/reports`, `lib/reports/fetch.ts`, `lib/jobs/health.ts`)

`getJobHealth()` now iterates `JOB_REGISTRY` (all 10 routes, not 3) and
computes one of six states per job via `computeJobHealth()`:

- **`never_run`** — no `background_jobs` row exists for this job id.
- **`healthy`** — a recent run, no failures, feature flag on (or no flag).
- **`no_op_healthy`** — a recent run whose own result reports
  `policyEnabled: false` (the three flag-gated ingestion/publication/
  distribution jobs only). Distinguishes "the scheduler is firing
  correctly and the job is correctly doing nothing because an admin has
  the feature off" from "the scheduler isn't firing at all" — this is the
  distinction R13.9 explicitly required.
- **`stale`** — the *latest* row (regardless of what it reports) finished
  longer ago than `expectedCadenceMinutes * job_staleness_multiplier`.
  Staleness is checked **before** no-op classification: a stale no-op is
  reported `stale`, never `no_op_healthy`, because a scheduler that has
  actually stopped firing must never be masked by "well the feature's off
  anyway."
- **`degraded`** — the latest row's own `status = 'degraded'` (see above).
- **`failed`** — the latest row's own `status = 'error'`.

`getJobHealth()` reads `background_jobs` via `lib/supabase/server`'s
request-scoped client — the *same* RLS-gated table and the *same*
pre-existing `admins_read_background_jobs` policy
(`using (public.is_super_admin(auth.uid()))`, migration
`20260101000011`) every other consumer of that table already relies on.
No new authorization code was written for this dashboard; RLS already
made it Super-Admin-only, and
`tests/integration/lifecycle-job-observability.test.ts` proves this
directly (an ordinary player's own client reads zero rows; a super admin's
reads them).

## Staleness tolerance: one knob, not ten

`platform_settings.job_staleness_multiplier` (default `3`,
1-20, `20260101000166`) is the *only* new admin-configurable value this
milestone introduces — following the exact "operationally mutable, not
per-job" precedent already established by `settlement_batch_size`/
`grading_batch_size`/`challenge_resolution_batch_size`. A per-job
threshold table was considered and rejected: ten independent knobs for a
single, rarely-changed alerting-sensitivity preference would be exactly
the kind of configuration infrastructure built "merely for abstraction's
sake" the canonical engineering rule warns against. `update_operations_
settings()` gained a sixth parameter (`p_job_staleness_multiplier`); the
old 5-arg signature is explicitly dropped (not just superseded) per the
now-standard signature-change discipline
(`SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md`).

## Retry and concurrency safety (unchanged, reconfirmed)

This milestone adds no new locking or retry mechanism — `try_acquire_
cron_lock`/`release_cron_lock` (`20260101000108`) and each job's own
established idempotency (grading's `PENDING`-scoped `UPDATE`, settlement's
`COMMITTED`-scoped eligibility check) already make every job safe against
a duplicate cron-job.org invocation or a genuine concurrent request. A
`'degraded'` classification changes what gets *recorded*, never what a
job *does* — no behavior change to any job's own execution semantics.

## Route/navigation visibility gap: deliberately deferred

R13.8 found that Brohda 2.0's routes (`/markets`, `/feed`, `/post/[id]`,
`/leaderboard/predictions`, nav tabs) are reachable by any authenticated
user regardless of the `platform_settings` feature flags — the flags gate
*data creation*, not *page reachability*. R13.9's own scope is operations
and observability, not product visibility architecture; introducing a
new "social launch visibility" flag/mechanism now would be a genuinely
separate, non-trivial feature (deciding redirect-vs-hide behavior across
several pages and nav items, its own tests) unrelated to job scheduling or
alerting. Accepted as-is for this milestone: the actual risk is low (every
such route currently renders an honest empty state — zero Markets, zero
Posts, zero Predictions in production — never fabricated content or
another user's data), and the decision of whether/how to gate visibility
belongs to the controlled-social-activation milestone that actually turns
the flags on, where the full page/nav inventory is already in scope.

## Production scheduler configuration

The six Brohda 2.0 jobs (`ingest-nfl-markets`, `publish-posts`,
`distribute-posts`, `grade-predictions`, `resolve-challenges`,
`settle-monetary-positions`) are configured in cron-job.org at the exact
cadences declared in `lib/jobs/registry.ts` (identical to the
already-published `docs/DEPLOYMENT.md` §5 table), using the existing
`Authorization: Bearer $CRON_SECRET` mechanism — no new authentication
scheme. All three flag-gated jobs are expected to report
`no_op_healthy` while their corresponding `platform_settings` flag stays
`false`; the three always-on lifecycle jobs (grading, resolution,
settlement) are expected to report `healthy` with zero eligible rows,
since the underlying Brohda 2.0 product tables remain empty until a
future, separately-authorized social-activation milestone.
