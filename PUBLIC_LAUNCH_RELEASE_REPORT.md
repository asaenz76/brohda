# Public Launch Release Report

## Release Status

**DEPLOYED**

All Phase 1–9 work, the production release verification runbook, and containment of a security incident discovered mid-release are complete and verified against live production.

## Important note on migration sequencing (expected, documented divergence)

The original release runbook assumed migrations `20260101000104`, `105`, and `106` were still pending at the point production verification began. During execution, a security incident was discovered (RPC `EXECUTE` privilege exposure — see below) that required an out-of-band migration, `20260101000107`. By the time the incident was contained and the runbook resumed, **all four migrations (`104` through `107`) had already been applied to production** — `104`–`106` during the original migration step, `107` during incident containment.

This is **not an error** — it is the correct, expected result of pausing the standard runbook to contain an active security exposure and resuming afterward. No migration was skipped, reapplied, or reverted; migration history was never rewritten. This was reconfirmed by direct query against production before continuing (`supabase migration list`: 107/107 applied, zero pending) rather than assumed.

## Git

- **Final commit SHA**: `7304999e65f86663f9152b85964413743fe0fabe`
- **Branch**: `main`
- **Tag**: `brohda-rc1` (annotated, pushed to `origin`)
- **Push status**: confirmed — `origin/main` verified to contain both incident-response commits (`c87e097`, `7304999`) via `git merge-base --is-ancestor`; local and remote `main` are byte-identical (0 ahead, 0 behind after push)

## Database

- **Migrations applied**: 107/107, zero pending, verified via `supabase migration list` immediately before and after the security-fix migration, and reconfirmed at the start of this final verification pass.
- **Migrations verified** (content + post-apply state, this release):
  - `20260101000104` — `correct_prediction_log` FK drop (append-only ledger, no longer blocked by pool/settlement deletion) + supporting index. Verified: FK constraints gone, index present, 40 pre-existing rows correctly reference now-deleted pools/settlements without error (the intended effect).
  - `20260101000105` — `close_own_account()` full scrub (nulls `bio`/`pronouns`/`gender`/`stories_last_seen_at` alongside pre-existing fields). Verified: all 4 original guards intact, exactly the intended fields nulled.
  - `20260101000106` — `wallet_transactions` composite index (`type`, `entry_id`). Verified: index present, correct definition.
  - `20260101000107` — Security incident containment (RPC privilege restoration). Verified: grants match plan exactly across all 61 public-schema functions; verified from the real production API boundary.
- **Backup confirmation**: Manual SQL backup created and verified (no PITR — Supabase Free plan, an accepted business decision for this beta given the small scale and absence of real-money activity; see below).
  - Schema: `brohda_prod_schema_20260806T230901Z.sql` — 189,797 bytes
  - Data: `brohda_prod_data_20260806T230901Z.sql` — 19,909,969 bytes, 63 tables, ends cleanly (not truncated), confirmed to already reflect the applied security fix
  - Timestamp: 2026-08-06T23:09:01Z
  - Storage: `/Users/andresaenz/Claude/PollPools-production-backups/` (local, outside the git tree)
  - `provider_request_log` (3.5M+ rows, a diagnostic API-call log with no financial/identity content) excluded from the data dump for practical size reasons — noted explicitly, not silently dropped.

## Test Results

All suites re-run at the end of this release, after the security fix, against the final commit:

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | Clean, 0 errors |
| `npx eslint .` | Clean, 0 errors |
| `npx vitest run tests/unit` | **817/817 passed** (73 files) |
| Integration suite (`.env.development.local`, never `.env.local`) | **345/345 passed** (36 files — 238 pre-existing + 107 new RPC privilege-boundary tests) |
| `npx playwright test` | **1/1 passed** (invite → registration → login, full local Supabase stack) |
| `npx next build` (production build) | Succeeded, 41 routes generated correctly |

## Production Deployment

- **Status**: Ready
- **URL**: `https://brohda.com`
- **Deployment ID**: `dpl_488r2BfuXHd4mmbZerM4dvXstVnP`
- **Commit**: matches `7304999` (deployed automatically via the connected GitHub → Vercel integration on `git push origin main`; confirmed by deployment creation timestamp immediately following the push, and by the deployment ID appearing in live request logs for `https://brohda.com` during smoke testing)
- **Deploy path**: existing configured Vercel Git integration — no second/parallel deploy path was created or used.

## Production Smoke Test

| Area | Result |
|---|---|
| Landing / login | **PASS** — loads correctly, correct branding ("brohda." / "The Social Prediction Platform."), no console errors |
| Registration | **PASS** — correctly shows "Registration is currently closed. Ask an admin for an invitation" (expected for an invite-only platform, not a bug) |
| Auth-gated routes (`/feed`, `/wallet`, `/admin/pools`) | **PASS** — all correctly redirect unauthenticated requests (HTTP 307) rather than erroring or leaking data |
| Production request logs | **PASS** — zero error/warning/5xx entries across the reviewed window; every request (cron + the smoke-test requests above) returned 200/307/304 as expected |
| Pool detail, comments, profiles, leaderboard, activity, deep wallet/admin flows | **NOT independently smoke-tested with a real login** — no production test credentials were available in this environment, and creating one wasn't in scope (no real-money entry was created solely for testing, per the standing constraint). These flows are covered instead by the full automated suite (817 unit + 345 integration tests, many of which exercise exactly these flows end-to-end against a real Postgres instance) plus the production build succeeding with all 49 routes compiling and type-checking correctly. Flagging this explicitly rather than claiming a check that wasn't actually performed. |

## API-Football / Automatic Settlement

- **Cron jobs**: `lock-pools`, `process-results` firing every ~1 minute; `sync-fixtures` every ~4 minutes (self-paced by its own runtime). All three: **0 errors** in the review window, latest run timestamps current (within the last minute at time of check).
- **Pool backlog**: zero pools stuck in `LOCKED`/`AWAITING_RESULT`/`READY_FOR_REVIEW`.
- **Settlement integrity**: all 24 settlements in the ledger resolve to the one real, active `super_admin` account (or `null` for the automatic path); zero unexplained admin identities.
- **Refund integrity**: 102 refund-credit ledger entries, fully explained by legitimate pool lifecycle events and subsequent admin cleanup (`delete_terminal_pool`).
- **API-Football provider health**: reachable and returning data (4,196 successes in the most recent 15-minute window), but still showing the **previously-flagged, already-deferred** rate-limiting pattern (381 errors in the same window) caused by `sync-fixtures`' known cron-overlap issue (matches the standing "Cron batching" item on the DO-NOT-TOUCH list for this deployment). **Not modified in this release** — confirmed still present, not new, not touched, per your explicit instruction.

## Known Deferred Items

Restated in one place, per the engagement's standing practice — none of these were touched this release:

- **Identity System, Reputation titles, Memory/story engine** — explicitly out of scope for the entire 9-phase engagement.
- **Settlement-confirmation path consolidation, Cron batching** (the `sync-fixtures` overlap causing elevated API-Football request volume/429s, confirmed still present above) — flagged, not fixed; recommended priority follow-up.
- **Admin hierarchy work** — handled separately, not part of this engagement.
- **Beta fee/stake immutability** — temporary, must be reverted once beta testing ends (per standing memory; the beta-end trigger has not occurred).
- **Provider correction auto-repoll architecture** — deferred.
- **CSP `unsafe-inline` / cron-secret non-constant-time comparison** — both rated low risk by the architecture review (no live exploit path for CSP; low practical risk for cron-secret timing), tracked but not fixed.
- **200% Feed bottom-nav label tightness** — non-blocking, deferred unless functionally unusable (it is not).
- **`wallet_transactions_type_entry_idx` created without `CONCURRENTLY`** (migration `000106`) — minor, low-risk given current table size; noted for awareness, not a blocker.
- **Process gap from the security incident** (see incident report's Remaining Risk): the root-cause mechanism — a signature-changing `CREATE OR REPLACE FUNCTION` silently resetting a function's grants to Postgres's `PUBLIC`-execute default — could recur for a *future* new function not yet covered by `rpc-privilege-boundary.test.ts`. Recommended follow-up: a CI check diffing `pg_proc` grants against an expected manifest. Not built in this release — flagged as the one deliberate follow-up worth scheduling.

## Production Issues Found

1. **RESOLVED THIS RELEASE**: RPC `EXECUTE` privilege exposure across all 61 `public`-schema functions (see `SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md` for full detail — discovered, contained, verified from the real API boundary, zero evidence of abuse found, permanent regression test added).
2. **PRE-EXISTING, DEFERRED, NOT TOUCHED**: `sync-fixtures` cron-overlap causing elevated API-Football call volume and intermittent 429s (see Known Deferred Items above).

No other genuine production issues were found during this release's verification.

## Final Recommendation

**READY WITH MINOR KNOWN ISSUES**

The security incident that emerged mid-release is fully contained, verified from the real production API boundary (not just the database), backed by a fresh verified backup, covered by a permanent regression test, and showed no evidence of abuse across the full financial/identity ledger. Every pre-production gate (tsc, eslint, 817 unit tests, 345 integration tests, e2e, production build) passes clean on the final deployed commit. Production is live, serving correctly, with clean logs and healthy automatic grading/settlement.

The "minor known issues" qualifier refers only to the pre-existing, already-deferred `sync-fixtures` cron-overlap/API-Football rate-limiting pattern — not to any residual security or financial-integrity concern, both of which were directly and independently verified as clean in this release.
