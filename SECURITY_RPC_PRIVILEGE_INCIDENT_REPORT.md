# Security Incident: Production RPC Privilege Exposure

## Incident Status

**CONTAINED**

The database-level vulnerability is closed and verified from the real production API boundary using the public anon key. The application-code release (git push, Vercel deploy) remains paused pending founder review of this report, per the incident runbook.

## Exposure Window

Not precisely determinable from tools available in this environment (no access to Supabase's SQL Editor query-history or PostgREST/API-gateway request logs from here). What can be established:

- The production project ("brohda", ref `wovfovohynwxgfwdztti`) was created **2026-07-23**.
- Seven trigger/event-trigger functions (see Root Cause) never had an explicit grant statement in *any* migration, on either environment — their broad grant has existed identically since each was first created, which places at least part of this exposure's shape at project inception.
- For the money/settlement-moving functions, the earliest concrete evidence is indirect: `apply_wallet_transaction`'s parameter list changed in migration `20260101000056` without restating its privilege narrowing — a mechanism confirmed to reset a function's grants to Postgres's PUBLIC-execute default (see Root Cause). That migration's content places this specific mechanism in the codebase from early in the project's history, but this only explains one function's PUBLIC grant, not the uniform anon+authenticated grant found across all 61 public-schema functions in production.
- Best-supported conclusion: the exposure most likely existed for all or nearly all of the production project's lifetime (2026-07-23 through remediation on 2026-08-06), not something newly introduced by this release's migrations.

## Affected Functions

Full enumeration of all 61 `public`-schema functions, their `SECURITY DEFINER`/`INVOKER` mode, and pre-remediation production grants, is preserved at `/Users/andresaenz/Claude/PollPools-production-backups/function_audit_raw.json` (captured before any change was made). Summary of what was wrong:

**Every one of the 61 functions** had `EXECUTE` granted to `anon` and `authenticated` in production, regardless of what its own migration specified. Twelve of them also had `EXECUTE` granted to the `PUBLIC` pseudo-role (which every current and future database role inherits): `apply_wallet_transaction`, `claim_import_job_chunks`, `cleanup_import_job_chunk_payloads`, `recalculate_import_job_progress`, `enforce_pool_fee_immutability`, `enforce_pool_option_semantics_immutability`, `forbid_audit_log_mutation`, `forbid_pool_grading_evidence_mutation`, `get_competition_fixture_aggregates`, `rls_auto_enable`, `set_updated_at`, `validate_admin_hierarchy`.

None of the money/settlement/mutation functions check `auth.uid()` internally — their entire authorization boundary is the Server Action layer (`requireUser()`, `requireSuperAdmin()`, `CRON_SECRET`) sitting in front of a Postgres RPC that PostgREST exposes at `/rest/v1/rpc/<name>`. The publicly-shipped `NEXT_PUBLIC_SUPABASE_ANON_KEY` is sufficient to authenticate as `anon`; a real user login is sufficient to authenticate as `authenticated`. With the grant in place, either was sufficient to call these functions directly, bypassing every application-layer guard.

The six functions specifically named in the incident trigger, with their full signatures:

| Function | Signature |
|---|---|
| `close_own_account` | `(p_user_id uuid)` |
| `confirm_pool_refund` | `(p_pool_id uuid, p_void_reason pool_void_reason, p_idempotency_key text, p_admin_id uuid, p_grading_version integer)` |
| `confirm_pool_settlement` | `(p_pool_id uuid, p_admin_id uuid, p_grading_version integer, p_idempotency_key text, p_winning_option_id uuid)` |
| `create_pool_entry` | `(p_pool_id uuid, p_user_id uuid, p_option_id uuid, p_amount bigint, p_idempotency_key text)` |
| `apply_wallet_transaction` | `(p_account_type wallet_account_type, p_user_id uuid, p_type wallet_transaction_type, p_direction wallet_direction, p_amount bigint, p_admin_id uuid, p_reason text, p_idempotency_key text, p_pool_id uuid, p_entry_id uuid, p_settlement_id uuid, p_destination text)` |
| `advance_or_cancel_locked_pool` | `(p_pool_id uuid, p_admin_id uuid)` |

The full audit found **54 additional functions** with the same class of drift — see Phase G classification below.

## Corrected Privileges

Restored via `supabase/migrations/20260101000107_security_incident_restore_rpc_privileges.sql`, sourced from each function's own creating/hardening migration (not invented fresh):

**Locked to `service_role` only** (30 functions): `abort_pool_reversal`, `add_pool_comment`, `advance_or_cancel_locked_pool`, `apply_wallet_transaction`, `claim_import_job_chunks`, `cleanup_import_job_chunk_payloads`, `close_own_account`, `confirm_combo_refund_fee_retained`, `confirm_pool_refund`, `confirm_pool_settlement`, `create_pool_entry`, `delete_pool_comment`, `delete_terminal_pool`, `get_competition_fixture_aggregates`, `get_platform_category_performance`, `get_platform_financial_overview`, `get_platform_monthly_activity`, `get_platform_overview`, `get_platform_top_users`, `prepare_pool_settlement`, `prepare_pool_settlement_manual`, `recalculate_import_job_progress`, `reverse_pool_settlement`, `toggle_pool_like`, `undo_pool_grading`, `void_pool_entry`.

**`authenticated` + `service_role`** (22 functions — legitimate direct calls from session-scoped Server Components/Actions, verified against actual call sites in `lib/` and `app/`): `can_view_pool_distribution`, `get_branch_member_ids`, `get_follow_counts`, `get_followers`, `get_following`, `get_leaderboard`, `get_pick_count`, `get_pool_participants`, `get_pool_participants_bulk`, `get_pool_totals`, `get_pool_totals_bulk`, `get_profile_stats`, `get_stories_row`, `get_user_analytics_overview`, `get_user_bankroll_balance`, `get_user_category_performance`, `get_user_competition_performance`, `get_user_cumulative_pnl`, `get_user_entry_history`, `get_user_financial_overview`, `get_user_monthly_activity`, `is_admin_or_above`, `is_following`, `is_super_admin`, `user_has_entered_pool`, `would_create_hierarchy_cycle`.

**`anon` + `authenticated` + `service_role`** (1 function, intentional): `check_and_increment_rate_limit` — must work pre-login (registration/login rate limiting).

**Revoked entirely, no re-grant** (1 function): `create_wallet_for_new_profile` — trigger-only, never called directly.

**Left untouched** (7 functions) — verified via `pg_get_function_result` to return `trigger`/`event_trigger`, which Postgres refuses to execute outside trigger context regardless of grants, so the broad grant they carry is not exploitable: `enforce_pool_fee_immutability`, `enforce_pool_option_semantics_immutability`, `forbid_audit_log_mutation`, `forbid_pool_grading_evidence_mutation`, `rls_auto_enable`, `set_updated_at`, `validate_admin_hierarchy`.

## Phase G: Full Classification

| Class | Count | Examples |
|---|---|---|
| SERVER-ONLY RPC | 30 | `apply_wallet_transaction`, `confirm_pool_settlement`, `create_pool_entry` |
| SAFE PUBLIC RPC (authenticated) | 22 | `get_pool_totals`, `get_leaderboard`, `is_super_admin` |
| SAFE PUBLIC RPC (anon, by design) | 1 | `check_and_increment_rate_limit` |
| SYSTEM-ONLY RPC (trigger, not directly invocable) | 7 | `set_updated_at`, `validate_admin_hierarchy` |
| SYSTEM-ONLY RPC (revoked, trigger-only) | 1 | `create_wallet_for_new_profile` |

No function was left in an `UNKNOWN — NEEDS REVIEW` state; every one of the 61 was resolved to a class with verifiable evidence (either its own migration's stated intent, or a direct call-site grep against `lib/`/`app/`, or its return type).

## Abuse Audit

**NO EVIDENCE OF ABUSE**

Read-only queries against production, no data modified:

- **Settlements** (24 total, all confirmed): every `confirmed_by_admin_id` resolves to the same one real, active `super_admin` account. Zero settlements reference a nonexistent or fabricated admin id.
- **Wallet transactions**: only two distinct `admin_id` values across the entire ledger — `null` (359 rows, the automatic/system path: entry debits, payouts, refunds, house fees) and the one real founder admin (90 rows: manual test deposits/withdrawals, all with human-written reasons like "Beta testing", "Wallet request approved: ..."). No unexplained admin identity anywhere in the ledger.
- **Pool entries** (`pool_entry_debit`, 257 rows): exactly 13 distinct entrants, every one resolves to a real, existing `user_profiles` row. Zero entries reference a nonexistent user.
- **Account closures**: zero deactivated profiles with a nonzero wallet balance or leftover `ACTIVE` entries — every `close_own_account` guard held in every case that ran.
- **Entry amounts**: uniform, small ($5–$10), consistent with normal beta-stakes activity — no anomalous single large entry.
- **Refund ledger** (`pool_refund_credit`, 102 rows) is fully explained by the append-only design: the corresponding pools were later removed via the legitimate `delete_terminal_pool` admin cleanup path (0 pools currently carry a `void_reason`, consistent with cleanup having run, not with data loss).

**Limitation, stated plainly**: I could not access Supabase's PostgREST/API-gateway request logs (IP/user-agent level) from this environment — only database-state evidence. That means I can't rule out someone having *probed* the exposed endpoint and received a response with no side effect (e.g., a read-only RPC call, or a write call that happened to fail on business-logic validation before any mutation). But every actual state change in the database traces cleanly to a real user, the one real admin, or the automatic system path — there is no financial or identity record that doesn't fit the expected, legitimate pattern.

## Data Integrity

- **Wallets**: balances reconcile with the transaction ledger; no orphaned or unexplained balance.
- **Entries**: all 257 debits trace to real, existing users; status distribution (ACTIVE/WON/LOST) and amounts are all within expected, uniform beta-stakes bounds.
- **Settlements**: all 24 confirmed by the one real super_admin; none automatic in this dataset (consistent with the founder manually confirming test settlements during beta rather than relying on the automatic path yet).
- **Refunds**: 102 refund credits, fully explained by legitimate pool lifecycle + later admin cleanup.
- **Accounts**: no account closure bypassed its guards.

## Security Migration

- **Filename**: `supabase/migrations/20260101000107_security_incident_restore_rpc_privileges.sql`
- **Commit SHA**: `c87e0977163f6025e599451c4f181e467d9c32db` (local `main`, **not yet pushed to `origin/main`** — pushing is part of the paused release runbook, awaiting founder approval per this report's own closing instruction)
- **Production application status**: **APPLIED AND VERIFIED**. Applied via `supabase db push --linked` at approximately 2026-08-06 21:52 UTC. Post-apply grants queried and matched the plan exactly. Verified independently from the real production API boundary: an unauthenticated `curl` call with the live public anon key against `apply_wallet_transaction` and `confirm_pool_settlement` both now return `HTTP 401`, `{"code":"42501","message":"permission denied for function ..."}`. A `service_role`-authenticated call to `close_own_account` with a harmless nonexistent user id returns `HTTP 400`, `{"code":"P0001","message":"wallet_not_found"}` — a normal business-logic error, confirming the legitimate server-only path is fully intact in production.

## Regression Tests

`tests/integration/rpc-privilege-boundary.test.ts` — new file, data-driven across all 53 directly-callable functions in the remediation plan (the 7 trigger functions and 1 revoke-only function are excluded, since calling them directly isn't a meaningful test of this invariant).

**Result: 107/107 passed** (53 functions × 2 roles [anon, authenticated] + 1 service_role sanity check), run against the local Supabase instance with this migration applied.

Also reconfirmed after the change, all local:
- `npx tsc --noEmit` — clean
- `npx eslint tests/integration/rpc-privilege-boundary.test.ts` — clean
- `npx vitest run tests/unit` — 817/817 passed
- Full integration suite (`.env.development.local`) — 345/345 passed (238 pre-existing + 107 new)
- `npx playwright test` (invite → registration → login, real local Supabase, anon + authenticated + rate-limit paths all exercised) — 1/1 passed

## Root Cause

Two independently-verified, distinct contributing factors — reported only to the extent each is actually established, not speculated beyond the evidence:

**1. Verified, reproducible migration-hygiene bug.** `CREATE OR REPLACE FUNCTION` with a *changed parameter list* resets a function's ACL to Postgres's PUBLIC-execute default when the replacing migration doesn't restate its own `revoke`/`grant`. Confirmed directly: `apply_wallet_transaction` was originally locked to `service_role` in migration `20260101000007` (explicit `revoke all ... from public; grant execute ... to service_role;`). Migration `20260101000056` later added a new `p_destination text` parameter via `CREATE OR REPLACE FUNCTION` — with no revoke/grant statements at all. A clean local database built from *only* the migration files (unaffected by any production-specific drift) still shows `apply_wallet_transaction` with `PUBLIC` execute today, proving this mechanism is real and would recur in any environment, not just production. This is now fixed by migration `000107`, which explicitly re-revokes `PUBLIC` (not just `anon`/`authenticated`) for every function in its plan.

**2. Not fully determinable: a separate, production-only widening.** Mechanism (1) only explains functions whose signature changed after their original narrowing. It does not explain why *all 61* public-schema functions — including ones whose migrations never touched their signature or grants at all — uniformly carried `anon`+`authenticated` execute in production while an identical, migration-only local rebuild showed the correct narrow grants for the 53 functions with explicit history. This uniform, whole-schema pattern is most consistent with a single out-of-band statement (most plausibly something like `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;` run directly against production, e.g. via the Supabase Dashboard SQL Editor) applied after the migrations ran — but I have no access from this environment to Supabase's SQL Editor query history, database audit logs, or PostgREST/API-gateway request logs to confirm who ran it or when. Reported as established fact only where directly evidenced; this specific mechanism remains the best-supported explanation, not a confirmed one.

**Local database privilege model**: also reviewed per the incident instructions. Before this fix, the clean local database (built purely from migration files, with no production-specific drift) was **not fully safe either** — `apply_wallet_transaction` carried `PUBLIC` execute locally too, via the same mechanism as above. This was not "acceptable merely because it matched migration history" and has been corrected going forward by migration `000107`, which is now itself part of the migration history and fixes this for every future environment rebuilt from these files.

## Remaining Risk

- **Genuine remaining risk**: none identified at the database-privilege layer for the functions covered by this audit and fix. All 61 public-schema functions have been individually reviewed and classified.
- **Process risk (not yet mitigated by tooling, only by the new regression test)**: the root-cause mechanism (a signature-changing `CREATE OR REPLACE FUNCTION` silently resetting `PUBLIC` grants) is a real Postgres behavior that could recur on some *future* function if a later migration changes its parameter list without restating its own revoke/grant. The new `rpc-privilege-boundary.test.ts` will fail if this happens to any of the 53 functions it covers, but a **brand-new** function added later without being added to that test's table would not be caught automatically. This is a process gap, not a currently-open vulnerability — flagging it as the one thing worth a deliberate follow-up (e.g., a lint/CI check that diffs `pg_proc` grants against an expected manifest), not something this incident response should expand scope to build right now.
- **Unrelated, previously-flagged, not touched by this incident**: the `sync-fixtures` cron overlap causing ~1M+ API-Football calls/day (matches the standing "Cron batching" deferred item) is a separate, already-known issue, not part of this security incident and not modified here.

## Release Status

**BLOCKED**

Per the incident runbook: do not resume the public launch automatically. The database-level vulnerability is contained and verified, but the following remain outstanding from the original release runbook and require your explicit go-ahead to resume:

1. This incident report itself — for your review.
2. The security-fix commit (`c87e097`) is local-only — not yet pushed to `origin/main`.
3. The original release runbook was paused mid-flight at the production-migration step (Phase D of your "STOP THE PUBLIC RELEASE" instruction) — everything after that (code push, Vercel deploy monitoring, live smoke test, cron/grading health re-check, log inspection, release tag, final `PUBLIC_LAUNCH_RELEASE_REPORT.md`) has not resumed.

Waiting for your review and explicit approval before continuing.
