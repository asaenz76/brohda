# Operations Runbook

Concise operator playbooks for the production-critical failure modes
identified in Milestone R13 (`docs/architecture/security-production-
readiness.md`). These are the "what do I do right now" procedures — see
that doc for the full audit and reasoning behind each one.

**General principle**: when something looks financially wrong, stop new
monetary activity before investigating, don't try to auto-repair. See
"Suspected financial inconsistency" below — this is the one rule that
applies across almost every incident type here.

---

## A job shows Stale, Degraded, or Failed on Job Health

**Symptom**: `/admin/reports`' Job Health card (Milestone R13.9,
`docs/architecture/production-operations-observability.md`) shows a job
in one of these states instead of `Healthy`/`No-op / healthy`.

1. **Stale** means the scheduler itself likely stopped firing for this
   job — its own `expectedCadenceMinutes * job_staleness_multiplier`
   window has passed since its last recorded run. This is distinct from
   `No-op / healthy` (scheduler firing correctly, feature intentionally
   disabled) — confirm which one you're actually looking at before
   assuming an incident. Check cron-job.org's own dashboard for that job
   first; a 401 there means `CRON_SECRET` mismatch.
2. **Degraded** means the job completed without crashing, but its own
   result reported at least one per-item failure (or, for
   `settle-monetary-positions`, a financial `invariant_violation`) — read
   `background_jobs.result` for that run (`failures`/`invariantViolations`
   fields) to find the specific affected object id(s). A degraded
   settlement run also raises a Sentry alert automatically — check there
   first for a ready-made summary before querying the database by hand.
3. **Failed** means the whole job threw — check `background_jobs.error`
   for that run, then Sentry for the full stack trace.
4. If the staleness threshold itself feels miscalibrated (too sensitive or
   not sensitive enough) for current traffic, adjust `job_staleness_
   multiplier` via `/admin/settings/brohda` (Operations) — takes effect
   immediately, no deployment needed.
5. A `degraded` or `failed` financial job (settlement, or grading/
   resolution feeding into it) should be treated as a suspected financial
   inconsistency (see that section below) if the affected object is a
   monetary Position — do not manually repair it.

---

## Sports ingestion stopped

**Symptom**: no new Markets appearing; `/admin/reports` Job Health shows
`ingest-nfl-markets` failing or not running.

1. Check `background_jobs` for the job's last run and error.
2. Confirm `platform_settings.market_ingestion_enabled` is `true` (an
   admin may have disabled it deliberately via `/admin/settings/brohda` —
   check the audit history there first).
3. Confirm cron-job.org shows the scheduled hit actually firing (a 401
   there means `CRON_SECRET` mismatch between cron-job.org and Vercel).
4. Check `API_NFL_ENABLED`/`API_NFL_KEY` (and `API_NBA_ENABLED` / `API_NHL_ENABLED` for those sports) are set and the provider isn't
   reporting an outage (see "Provider outage" below). A sport-specific failure is named in the job result's `failures` (sport + provider);
   a Free-plan provider says "Free plans do not have access to this season". To see exactly what is missing for one sport:
   `pnpm check-sport-readiness nhl|nba|nfl` (read-only; see "Reading a sport's readiness verdict" below).
5. Nothing here risks money — safe to investigate at normal pace.

## Reading a sport's readiness verdict

`pnpm check-sport-readiness nhl|nba|nfl [--json]` (read-only; database reads only, no provider calls). Each item is exactly one of:

| Status | Meaning | Is it a defect? |
|---|---|---|
| `PASS` | proven healthy | no |
| `FAIL` | the platform is broken: a job failing, inconsistent data, an odds request that errored, a Game inside the odds window that ingestion never examined, ungradeable Markets | **yes** |
| `DISABLED` | the sport is switched off by configuration (`API_<X>_ENABLED`, or no adapter) | no — nothing else is judged |
| `PROVIDER_INVENTORY_UNAVAILABLE` | the platform asked and the provider has not published that inventory (no odds yet / too few bookmakers) | no |
| `PROOF_PENDING` | nothing is wrong; the real-data proof cannot exist yet (no Game inside the odds window; no completed Game) | no |

Overall verdict precedence: `DISABLED` > `BROKEN` > `PROVIDER_INVENTORY_UNAVAILABLE` > `PROOF_PENDING` > `HEALTHY` (printed "PRODUCTION READY"). The exit code is 1 **only** for `BROKEN`.
"Provider has no odds" is never reported as a platform failure, and an odds request that *errored* is never reported as "no odds". Job health is judged per sport: an ingestion failure that names
another sport (`failures[].sport`) does not make this sport's jobs unhealthy.

## Provider subscription renewals (API-Sports Pro plans)

One key authenticates every product; each product renews separately. Renew **before** the end date or that sport's fixture sync and odds start failing (visible per sport in Job Health and Sentry).

| Product | Used for | Subscription ends |
|---|---|---|
| Basketball (NBA) Pro | NBA fixtures + odds | **2026-11-07** |
| Hockey (NHL) Pro | NHL fixtures + odds | **2026-11-07** |
| American football (NFL) Pro | NFL fixtures + odds | **2026-11-12** |
| *API-NBA* (separate product) | not used (no odds endpoint) — may be cancelled | — |

These dates live here only — nothing in the app, a migration, or a config reads them.

## Money capability and the legal pages (Rules / Terms / Privacy)

* **One flag.** `platform_settings.monetary_p2p_enabled` (Admin → Settings → Brohda) is the only switch. The Rules page, the Terms, the Privacy Policy, wallet navigation and the money server actions all read it
  (`lib/monetary/capability.ts` is the consumer-facing reader; `tests/integration/legal-money-mode.test.ts` flips the flag and asserts every reader agrees). There is no second flag, mode setting or cached copy.
* **Rendering and caching.** `/rules`, `/terms` and `/privacy` are `force-dynamic` and answer `cache-control: private, no-store`: every request reads the setting live, so changing the flag in Admin Settings
  changes the pages on the **next request — no redeploy, no cache purge**. (Verify: toggle in a non-production environment, reload the three pages.)
* **What each state shows** (`lib/legal/money-mode.ts`):
  A. money ON → the full documents. B. money OFF and financial records exist → no current-feature money copy anywhere; the records disclosure the law requires appears in ONE titled section
  ("Retained wallet records and existing balances" in the Terms; "Financial records we still hold" in the Privacy Policy) plus the Company classification disclaimer. C. money OFF and no financial record ever stored → no money copy at all.
  An unreadable *flag* hides the consumer money copy; an unreadable *records check* keeps the disclosure (the pages never claim "no financial data" on a guess). Production holds ledger history, so it renders B when money is off.
* Classification of every remaining money word: `docs/legal/TERMS_PRIVACY_OWNER_COUNSEL_REVIEW.md` §8. **Do not toggle `monetary_p2p_enabled` in production to test this** — verify with the tests or a non-production environment.

## Signed-in production spot-check (manual — an automated agent must not sign in to production)

Run as a **real member** (not an admin) on https://brohda.com, once after a release that touches sports, legal pages or feeds. Nothing here changes data.

1. `/rules`, `/terms`, `/privacy` (signed in or out): with money OFF, no section talks about offers, funding, fees, Positions or wallets; the Terms and Privacy each show their one retained-records section; numbering is 1…n with no gaps; every "Section N" lands on the section it names.
2. Feed → **Discover → Sports**: tabs show NFL / NBA / NHL each with its icon; open one — Games listed, team logos load.
3. Open an **NFL** Game post: Moneyline, Spread and Total show; "Away @ Home" order; lock notice appears only after kickoff.
4. Open an **NHL** Game post (when one has a Market): same three Markets; Spread reads as a puck line (±1.5).
5. **NBA**: Games exist; Moneyline and Total appear once bookmakers publish; **no Spread** is expected until the pre-opening gate (`SPORTS_AUDIT_NHL_NBA.md` §5c). Absence of a Market for a not-yet-priced Game is normal.
6. Make a Pick on a not-yet-locked Game, change it, confirm the change saves; a locked Game refuses.
7. Team Community page (any sport): logo, follow / unfollow, posts listed.
8. Profile → Communities tab loads; Notifications opens; the wallet link is absent (money OFF) unless you hold a balance.
9. Admin (separate admin account): **Job Health** all healthy/no-op; **Events** shows each active sport.

## Grading stopped

**Symptom**: Picks stay PENDING past their Market's resolution; no
`prediction_graded` notifications sending.

1. As of Milestone R13.5, grading runs automatically via `/api/cron/
   grade-predictions` (cron-job.org-scheduled, see `docs/DEPLOYMENT.md`
   §5). Check `background_jobs` for that job's last run and error, and
   confirm cron-job.org shows the scheduled hit actually firing (a 401
   there means `CRON_SECRET` mismatch).
2. If it isn't firing (or you need an immediate rerun without waiting for
   the next tick), run manually: `pnpm grade-predictions` against
   production (it has its own `assertProductionWriteConfirmed` guard —
   follow its prompt). This calls the exact same canonical
   `runGradingJob()` the cron route does — nothing is reimplemented.
3. Grading is one-shot and idempotent (`markPredictionGraded()` only ever
   transitions PENDING -> GRADED, and a graded row is DB-level immutable
   as of R13) — safe to re-run after any failure, and safe even if it
   overlaps the next scheduled cron tick.
4. Check `background_jobs.result.failures` for any per-Prediction errors
   isolated during the run (R13.5 added per-item failure isolation) —
   those specific rows stay PENDING and are retried automatically on the
   next tick; everything else in that batch still graded normally.

## Call BS resolution stopped

**Symptom**: accepted Call BS Challenges never move to RESOLVED even
though both Picks are GRADED.

1. Runs automatically via `/api/cron/resolve-challenges`, scheduled after
   grading (it reads `predictions.result`, which only grading produces).
   Check `background_jobs` for its last run.
2. Manual rerun: `pnpm resolve-challenges` — calls the same canonical
   `resolveAcceptedChallenges()`. Idempotent and safe to re-run.
3. A Challenge staying "still pending" is often just timing — confirm
   both of its Picks are actually GRADED first (see "Grading stopped"
   above) before treating this as its own incident.

## Settlement runner failed

**Symptom**: committed Monetary Positions with both Picks GRADED but
`settlement_status` still `COMMITTED`; `check-monetary-consistency`
reports `committed_position_graded_but_unsettled` anomalies.

1. Runs automatically via `/api/cron/settle-monetary-positions`,
   scheduled after grading. Check `background_jobs` for its last run —
   the stored result includes `settledWin`/`settledVoid`/
   `invariantViolations`/`failures` counts.
2. **Immediate safety consideration**: if you suspect something is
   systemically wrong with settlement (not just one bad Position), set
   `platform_settings.monetary_p2p_enabled = false` via `/admin/settings/
   brohda` first. This stops *new* proposals/acceptances only — it never
   blocks the cron route (or a manual rerun) from continuing to settle
   already-committed Positions correctly (proven directly by
   `tests/integration/cron-jobs.test.ts`), so investigating never leaves
   real committed obligations stranded.
3. If it isn't firing (or you need an immediate rerun): run manually:
   `pnpm settle-monetary-positions` against production. This calls the
   same shared `runSettlementJob()` (`lib/monetary/settlement-runner.ts`)
   the cron route uses — nothing is reimplemented. Settlement is
   idempotent per-Position (`settle_monetary_position()`
   locks the row, checks terminal state first, returns `already_settled`
   rather than re-processing) — safe to re-run.
4. The runner isolates per-Position failures (explicit try/catch in the
   loop) — one bad Position never strands the rest of the batch.
5. If a specific Position keeps failing (`invariant_violation` or
   `not_eligible`), STOP settling that one and treat it as a suspected
   financial inconsistency (below) rather than retrying blindly.

## Reconciliation reports a financial mismatch

**Symptom**: `pnpm check-monetary-consistency` or `pnpm check-wallet-
reservations` reports an anomaly.

1. **Stop creating new monetary commitments first** — set
   `platform_settings.monetary_p2p_enabled = false` via `/admin/settings/
   brohda` (Monetary P2P section). This blocks new proposals/acceptances
   only; it never blocks settlement of an already-committed Position and
   never freezes an existing reservation, so nothing in flight is harmed.
2. Do not attempt an ad hoc repair. Read the reconciliation report's
   `kind`/`detail` fields carefully — they name the exact anomaly class
   and the specific row(s).
3. Escalate with the full report output before touching any data.
4. Re-enable `monetary_p2p_enabled` only after the root cause is
   understood and either fixed or confirmed benign.

## Provider outage (sports data)

**Symptom**: `ingest-nfl-markets`/`sync-fixtures-nfl` failing repeatedly;
stale Game/Market state.

1. This is expected to fail closed, not silently corrupt state — confirm
   no Market shows a fabricated/guessed result. Grading only ever derives
   a result from the linked Game's own final score; it never fabricates
   one if the provider hasn't reported it.
2. Wait for provider recovery; the ingestion job is idempotent and safe
   to leave failing/retrying on its normal schedule.
3. If the outage is prolonged and affects live Markets with real P2P
   Positions riding on them, consider disabling `monetary_p2p_enabled`
   for new commitments until data resumes (existing commitments are
   unaffected either way).

## Admin accidentally disables a feature

**Symptom**: a product area suddenly stops working after a settings
change.

1. Check `/admin/settings/brohda/history` — every change is durably
   audited with actor, timestamp, before/after, scoped to just the
   changed domain's fields.
2. Re-enable the setting via `/admin/settings/brohda` — this always takes
   effect immediately, no deployment needed.
3. For Monetary P2P specifically: disabling never traps existing funds or
   blocks existing settlement, so there's no urgency-driven reason to
   panic-re-enable before understanding why it was disabled.

## Database migration failure

**Symptom**: `supabase db push` (production) or a deploy step fails
mid-migration.

1. Do not edit the failed migration file. This project's own unbroken
   discipline (confirmed across R9-R13) is forward-only migrations —
   diagnose the failure, then write a new migration to fix or complete
   what's needed.
2. Confirm via `supabase migration list --linked` (or equivalent) exactly
   which migrations applied before the failure.
3. Test the fix against a fresh local `supabase db reset --local` before
   reapplying to production.

## Application deployment rollback

**Symptom**: a bad deploy needs to be reverted.

1. Vercel: roll back to the previous deployment via its dashboard —
   standard Vercel rollback, no project-specific steps.
2. If the bad deploy included a new migration already applied to
   production, a code rollback alone may leave the DB ahead of the
   rolled-back code's own expectations — check whether the new
   migration's columns/functions are additive (safe to leave applied) or
   would break the older code path before rolling back code only.

## Suspected account abuse

**Symptom**: a user reports harassment via repeated Challenges, or
suspicious rapid-fire activity from one account/IP.

1. Rate limits (Call BS, comments, monetary proposals) are server-side
   and admin-configurable (`/admin/settings/brohda`) — tightening the
   window/attempts takes effect immediately if needed.
2. This architecture does not claim Sybil resistance — multiple accounts
   can multiply effective rate. If abuse is confirmed, account
   deactivation (`is_active = false`) is the available lever; there is no
   automated ban/mute system.
3. Call BS reputation farming (repeated Challenges between the same pair
   on predictable-outcome Markets) is a known, documented, open product
   question — see the security doc — not something to "fix" ad hoc during
   an incident.

## Suspected financial inconsistency (the general rule)

1. **Stop new monetary commitments**: `platform_settings.monetary_p2p_
   enabled = false`. This is the one lever that exists today for this —
   it never blocks existing settlement or traps existing funds.
2. Do not attempt to manually correct wallet balances, reservations, or
   settlement rows without first running and fully reading `pnpm check-
   monetary-consistency` and `pnpm check-wallet-reservations`.
3. Preserve evidence (the reconciliation report output, relevant row IDs)
   before any corrective action.
4. Escalate. Re-enable monetary activity only once the cause is
   understood.
