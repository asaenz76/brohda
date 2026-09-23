# Security, Abuse & Production Readiness (Milestone R13)

Adversarial audit and remediation gate for the complete Brohda 2.0
architecture built during R1-R12. This is not a feature milestone — it is
a hostile-system audit plus the remediation of everything launch-blocking
it found.

## Scope and method

Read-only research was parallelized across independent audit surfaces
(authorization/mutation-path audit, database security/immutability audit,
application security audit, background-jobs/secrets audit); financial
concurrency, direct-RPC attacks, and remediation were done by hand against
a real local Supabase instance. Every fix below was reproduced first,
fixed with the smallest safe forward migration or code change, covered by
a new regression test, and re-verified against the full existing suite —
never a blind patch.

## Trust-boundary map

```
Browser / untrusted client
        |  (cookie-based Supabase Auth session; Next.js Server Action
        |   same-origin CSRF protection, unmodified/default)
Next.js Server Actions (lib/actions/**)
        |  requireUser() / requireSuperAdmin() / requireAdminOrAbove()
        |  — identity is ALWAYS re-derived from the server-side session,
        |  never trusted from a client-supplied user_id/actor_id/admin_id
Supabase authenticated API (PostgREST)
        |  RLS policies (own-row by default; a handful of intentional
        |  public exceptions: communities, platform_settings, resolved
        |  free Challenges)
Postgres RPC (SECURITY DEFINER functions)
        |  EXECUTE granted to service_role only for every mutation;
        |  counterparty-sensitive RPCs re-check ownership against the
        |  passed (server-derived) id INSIDE the function body too
service_role trusted operations (lib/supabase/admin.ts)
        |  the only role that can call service_role-only RPCs; never
        |  reachable from a browser — server-only client
Wallet ledger (wallet_balances / wallet_transactions / wallet_reservations)
        |  apply_wallet_transaction() is the single choke point for every
        |  balance change, legacy pools and P2P alike; CHECK constraints
        |  (reserved_balance <= balance) hold regardless of caller
external USDT infrastructure
        (out of scope for R13 — no real funds touched; wallet ledger is
        entirely internal accounting, external settlement is a separate,
        unbuilt system)

sports provider (api_nfl)
        -> ingestion (lib/prediction-markets/ingestion/nfl.ts, cron-gated)
        -> Game / Market (fixtures, markets — no user mutation path exists)

Super Admin
        -> requireSuperAdmin() (Server Action layer)
        -> update_*_settings() RPCs (service_role-only grant AND an
           internal is_super_admin(p_admin_id) check as of this milestone)
        -> platform_settings (publicly readable, service_role-only write)
```

For every boundary: trusted input is whatever the immediately-inner layer
already validated; untrusted input is the client payload one layer out;
authorization authority is `requireUser()`/`requireSuperAdmin()` at the
Server Action layer AND the Postgres GRANT (plus, as of this milestone,
an internal check for the 9 admin-settings RPCs) at the RPC layer —
deliberately two independent layers, not one; validation authority is
Zod at the Server Action layer plus CHECK constraints at the DB layer;
the idempotency boundary is per-operation idempotency keys (Picks,
Challenges, Proposals, wallet transactions) or natural state-machine
one-shot transitions (grading); the transaction boundary is always one
Postgres transaction per RPC call (row-level `FOR UPDATE` locks, never a
multi-request saga); the audit boundary is `audit_logs`, hard append-only
via `forbid_audit_log_mutation`, written atomically with the mutation it
records for every R12+ admin action.

## Security invariants

The formal list audited against (✓ = held, verified below; every one held
after remediation):

- **Identity**: a user cannot act as another user. ✓ — no Server Action or
  RPC accepts a client-supplied acting identity; see Authorization below.
- **Picks**: a user cannot create/edit another user's Pick; a Pick cannot
  change after its effective lock (cutoff, accepted Challenge, or
  committed Position); a graded Pick's result is permanent. ✓ — the last
  of these was a genuine gap (no DB-level trigger existed) and is now
  fixed (`forbid_graded_prediction_mutation`, migration 162).
- **Markets**: a normal user cannot create, mutate, grade, or resolve
  Markets. ✓ — no Server Action exposes this path at all.
- **Posts**: a normal user cannot create canonical Game Posts. ✓.
- **Comments**: a user cannot delete another user's comment unless
  authorized by existing moderation rules. ✓ — DB-level ownership check
  inside `remove_post_comment()`.
- **Free Challenges**: a user cannot accept a Challenge addressed to
  another user; a Challenge cannot be accepted after expiration;
  participants must have opposing Picks on the same Market. ✓ — all
  DB-enforced, already extensively tested (R7).
- **Wallet**: a user cannot directly credit their balance, spend reserved
  funds, or create negative available balance. ✓ — `apply_wallet_
  transaction()` is the single choke point; `reserved_balance <= balance`
  is a CHECK constraint, not merely convention.
- **Monetary Proposals**: a proposer cannot propose more than available
  funds; a recipient cannot accept without sufficient available funds;
  proposal terms cannot change after creation. ✓.
- **Positions**: a committed Position cannot change participants, stake,
  Market, Picks, or fee snapshot. ✓ — no UPDATE grant exists on
  `monetary_positions` for `service_role` at all; only `settle_monetary_
  position()` (owned by the migration-runner role) can touch it, and it
  only ever writes settlement status/timestamp columns.
- **Settlement**: a Position settles at most once; settlement outcome,
  fee, and amount are server-derived, never client-chosen. ✓.
- **Accounting**: value is conserved; no ordinary operation creates USDT
  value from nothing; no reservation disappears without a valid terminal
  transition. ✓ — `monetary_position_settlements`' own CHECK constraints
  enforce `fee_amount + winner_credit_amount <= stake` even against a
  hand-crafted raw insert.
- **Admin**: normal users cannot access or mutate admin configuration;
  admin configuration cannot mutate canonical sports or financial truth.
  ✓ — the 9 settings RPCs write only `platform_settings`/`audit_logs`,
  and as of this milestone also re-check `is_super_admin(p_admin_id)`
  internally, not just via the grant.
- **Reputation**: users cannot forge record/rank; money cannot alter
  reputation. ✓ by construction — the reputation RPCs derive everything
  from `predictions`/`challenges`, which have no monetary linkage.
- **Audit**: audit history cannot be edited/deleted through ordinary
  application authority. ✓ — `forbid_audit_log_mutation` blocks
  UPDATE/DELETE unconditionally, even for `service_role`.

## Findings summary

| Severity | Count | Status |
|---|---|---|
| P0 | 0 | — |
| P1 | 5 | All 5 fixed |
| P2 | 1 | Fixed (cheap, defense-in-depth) |
| P3 | 6 | Documented, deferred (see Residual risks) |

No P0 was found: no arbitrary balance creation, no unauthorized
settlement, no reproducible double-spend, no authentication bypass, no
secret exposure.

## Remediations

**R13-1 — P1 — 10 directly-callable mutation RPCs had no privilege-boundary
regression test.** `accept_call_bs`, `add_post_comment`, `call_bs`,
`confirm_pool_grading_only`, `decline_call_bs`, `delete_old_provider_
request_log_rows`, `remove_post_comment`, `seed_legacy_pool_for_tests`,
`set_pick`, `void_pool_no_refund` — all currently `service_role`-only
(safe today), but none were covered by `tests/integration/rpc-privilege-
boundary.test.ts`, the exact regression test this project's own prior
production incident (`SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md`) built
specifically to catch a future accidental grant-widening. Root cause:
these functions were added across R5-R8 without an accompanying update to
that test's table. Fix: added all 10 (`tests/integration/rpc-privilege-
boundary.test.ts`), confirmed all currently reject anon/authenticated
(171/171 passing, up from 151). Includes `set_pick` — the single most
safety-critical mutation RPC in the whole system.

**R13-2 — P1 — production Next.js had 2 critical unauthenticated RCE
CVEs.** `next@16.2.10` fell inside the vulnerable range for GHSA-p293-
qw3h-jr36 (Windows RCE) and GHSA-2xp9-vwfh-vxw4 (Image Optimization RCE
via AVIF), plus 4 additional high-severity CVEs (middleware/proxy bypass,
Server Actions DoS/SSRF, rewrites SSRF), all fixed `>=16.3.3`/`>=16.2.11`.
`sharp@0.35.3` (used in the production avatar-upload path,
`app/api/avatar/route.ts`, processing untrusted user images) carried a
high-severity libheif CVE, fixed `>=0.35.4`. Fix: upgraded to
`next@16.3.6` and `sharp@0.35.4` (smallest-safe-change: same major
version, latest stable patch line). `pnpm audit --prod` dropped from 50
vulnerabilities (2 critical, 24 high) to 11 (0 critical, 10 high, 1
moderate) — every remaining finding traces through `@sentry/nextjs`'s
build-time-only webpack/babel toolchain (`fast-uri`, `brace-expansion`,
`browserslist`, `baseline-browser-mapping`), never executed in the
deployed request-handling path. Full regression (typecheck, lint, unit,
production build) re-run clean after the upgrade.

**R13-3 — P1 — `predictions.result`/`graded_at`/`selected_outcome` had no
DB-level immutability guarantee.** Full UPDATE grant existed on
`predictions` for `service_role`, with no field-level trigger — unlike
sibling tables in the same R1-R12 range (`markets`, `posts`,
`communities`, each of which got a dedicated `forbid_*_mutation`
trigger). The permanence of a graded Pick's result rested entirely on
"no application code path calls a raw UPDATE on these columns" — the
weaker of the two guarantees this project otherwise prefers, and a real
gap given `predictions.result` is the exact source of truth
`settle_monetary_position()` reads to move real money. Fix: new trigger
`forbid_graded_prediction_mutation` (migration 162) blocks any change to
`result`/`resolved_outcome_snapshot`/`graded_at`/`lifecycle_state`/
`selected_outcome` once a row is GRADED, regardless of caller — verified
both negatively (4 direct tamper attempts via the service-role client, in
`tests/integration/predictions.test.ts`) and positively (the full R5/R7/
R9/R10/R11 grading-dependent test suites — 221 tests — still pass
unmodified, proving the legitimate PENDING -> GRADED transition is
untouched).

**R13-4 — P1 — R12's 9 `update_*_settings()` RPCs trusted `p_admin_id`
without an internal check.** Unlike `reverse_pool_settlement()` (which
explicitly does `if not is_super_admin(p_admin_id) then raise
exception`), all 9 admin-settings RPCs relied solely on the Postgres
EXECUTE grant (`service_role`-only) plus the calling Server Action's
`requireSuperAdmin()` gate. Given this exact codebase has already
suffered two real, documented EXECUTE-grant-drift incidents
(`SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md`; `20260101000134_free_mode_
rpc_grant_remediation.sql`), relying solely on the grant for 9 financial/
product-policy-mutating functions was a real, if dormant, gap. Fix: new
migration (161) adds `is_super_admin(p_admin_id)` as the first statement
in all 9 functions, mirroring the established `reverse_pool_settlement()`
pattern exactly; grants explicitly restated (unchanged). Verified
empirically both that the grant is unchanged (still `service_role`-only)
and that a direct call with a non-super-admin id is rejected even when
made with full `service_role`/superuser privilege — 9 new regression
tests in `tests/integration/admin-brohda-settings.test.ts`.

**R13-5 — P1 — no test proved legacy pool entries and P2P reservations
coexist correctly on one shared wallet.** Explicitly called out as
launch-critical (this milestone's own task). Architecturally already safe
by construction — `create_pool_entry()` debits the wallet by calling the
exact same `apply_wallet_transaction()` R8 already hardened with the
available-balance check, not a second independent implementation — but no
test exercised both real RPCs together. Fix: two new integration tests
(`tests/integration/wallet-reservations.test.ts`, "Cross-product" describe
block) prove end-to-end: a real PAID pool entry debits the wallet, a
subsequent P2P proposal that would overcommit the remaining available
balance is correctly rejected, and one that fits within actual available
funds succeeds and leaves the combined wallet state (`total`/`reserved`/
`available`) correct across both products at once.

**R13-6 — P2 — `wallet_reservations.user_id` used `ON DELETE CASCADE`,**
inconsistent with the explicit non-cascading precedent its own migration
cites (`wallet_transactions.user_id`). A hard-deleted `user_profiles` row
would have silently cascade-deleted reservation history, breaking the
reservation-to-ledger correlation the same migration's own comment
describes as a design goal. Currently dormant — no hard-delete code path
exists anywhere (`close_own_account()` only ever soft-scrubs, verified by
direct read) — but cheap and safe to fix now, before it can ever become
reachable. Fix: migration 163 drops and recreates the FK as `NO ACTION`,
matching `wallet_transactions.user_id` exactly. Zero observable behavior
change today (`tests/integration/wallet-reservations.test.ts` and
`close-account.test.ts` both re-verified green).

**Also fixed along the way (found while verifying R13-5):** a real bug in
the new cross-product test itself — the Supabase JS client's PostgREST
query builder requires a column used in `.order()` after an
`.insert().select()` to also be present in the `.select()` projection, or
it returns a misleading "column does not exist" error even though the
column genuinely exists (confirmed via direct `psql` and a raw `curl`
against PostgREST, which both saw the column fine). Not a security
finding — a test-authoring gotcha, now documented in this doc and fixed
in the test itself.

## Call BS reputation farming — PRODUCT / ABUSE DECISION REQUIRED

Per this milestone's own explicit instruction (§50/§104), this is
reported rather than silently fixed.

**The question**: can two users repeatedly Call-BS each other in a way
that artificially inflates a head-to-head or overall Call BS record?

**What was verified**: the only uniqueness constraint on `challenges` is
`challenges_one_pending_pair` — a partial unique index blocking a second
*concurrently-PENDING* Challenge between the same two predictions. It does
**not** limit the total number of *resolved* Challenges between the same
pair over time, across different Markets, or overall. The rate limit
(`call_bs_rate_limit_window_seconds`/`max_attempts`, R12-configurable)
throttles *velocity* only, not lifetime count. R7 deliberately permits
multiple accepted free Challenges sharing a Pick, and R11's `get_call_bs_
record()` counts every RESOLVED Challenge for a user, unconditionally.

**The mechanism**: because a free Challenge's outcome is genuinely
determined by the real, authoritative sports result (not by mutual
agreement — collusion cannot manufacture a specific market outcome), two
colluding accounts cannot arbitrarily choose who "wins." However, they
*can* deliberately and repeatedly pick opposite sides of markets where one
side is an overwhelming, near-certain favorite (a real, observable market
condition), then Call-BS each other on those Picks, over and over,
indefinitely — subject only to the rate limit's velocity cap, not any
lifetime cap. This would let a pair of accounts (one acting as a
compliant "sacrifice") manufacture an arbitrarily large, favorable Call BS
win/loss record for one of them, with no code-level exploit — just
repeated, rate-limited, legitimate-looking activity.

**What this is not**: it is not a security bug (no authorization, data
integrity, or financial invariant is violated), and it involves no real
money (Call BS is R7's free feature). It is a genuine, structural product/
abuse-policy question: should there be a lifetime cap on resolved
Challenges between the same pair, a diminishing-returns weighting, or
should this simply be accepted as within-scope for a free social feature?

**Explicitly not resolved by R13**: no cap, deduplication rule, or
scoring change has been invented or added. This is reported as **PRODUCT
/ ABUSE DECISION REQUIRED — CALL BS REPUTATION FARMING**, for the
decision-maker to resolve as a deliberate product choice, the same way
R5's Pick-status-eligibility question and R7's monetary-fee question were
each resolved by direct decision rather than invented silently.

## Open product decisions carried forward

- **R5's Pick-eligibility gate** (`NOT_STARTED`-only hard-coded) —
  confirmed still unresolved (R12 already reported this; R13 did not
  re-derive or change it). Reported again here for completeness: **NOT
  EXPOSED — PRODUCT DECISION REQUIRED**, not a launch-blocker.
- **Call BS reputation farming** — see above, new this milestone.
- **The three unscheduled money-moving jobs** (grading, Call BS
  resolution, P2P settlement) — see "Background jobs" below: **PRODUCTION
  OPERATIONS DECISION REQUIRED**.

## Authentication

Every authenticated surface derives identity exclusively from
`requireUser()`/`requireSuperAdmin()`/`requireAdminOrAbove()`
(`lib/auth/session.ts`), which calls `supabase.auth.getUser()` against the
server-side cookie session — never a client-supplied field. Deactivated
accounts are excluded (`isUsableSession()` checks `is_active`). Role
lookups happen server-side per request (no cached/stale role trusted
across a session). No Server Action or RPC accepts a client-supplied
`user_id`/`actor_id`/`admin_id` as the *acting* identity — the one
apparent exception (`lib/actions/wallet.ts`'s admin deposit/withdraw,
which does take a client-supplied `userId`) is correct by design: it is
the admin-to-user wallet-adjustment surface, itself gated by
`requireSuperAdmin()`, with the *actor* id always server-derived and every
call audit-logged.

## Authorization

All 12 audited mutation surfaces (Profile, Follow, Pick, Comments, Call
BS, Monetary Proposals, Wallet, Settlement, Admin settings, Audit history,
Game/Market, Post creation) came back CONFIRMED-SAFE with no findings.
Counterparty-sensitive RPCs (`accept_call_bs`, `decline_call_bs`,
`accept_monetary_proposal`, `decline_monetary_proposal`,
`withdraw_monetary_proposal`, `remove_post_comment`) re-check ownership
**inside the SQL function body** against the passed, server-derived id —
not merely in TypeScript — so a hypothetical direct-RPC caller with the
right credentials still cannot act as a different user. Settlement
(`settle_monetary_position`) has no user-reachable entry point at all —
called only from the standalone CLI script. Market/Game mutation and
canonical Post creation have no Server Action exposing them to normal
users.

## Database security

**RLS**: every R1-R12 table has RLS enabled. The only two `USING (true)`
policies in the R1-R12 range (`communities`, `platform_settings`) are both
intentionally public, non-financial data. No table holding wallet-adjacent
or user-private data has an overly permissive policy.

**SECURITY DEFINER**: 25 functions introduced/redefined in R1-R12, all 25
set a fixed `search_path = public` (no schema-injection risk), zero use
dynamic SQL (`EXECUTE`/`format()`-built query strings) anywhere in the
R1-R12 migration range — confirmed by direct grep across all 26 files.

**IDOR**: `get_user_prediction_record`/`get_call_bs_record`/`get_
prediction_leaderboard` (R11) accept an arbitrary `p_user_id` and are
`authenticated`-callable — this is intentional, not a leak: these are the
exact public reputation/leaderboard records the product displays on every
profile page by design (R11's own explicit "transparent, 100%-money-
independent" reputation model), and none of the three touches
wallet/email/PII fields.

**Cascade/delete**: no CASCADE exists on any financial-history FK in
R1-R12 except the now-fixed `wallet_reservations.user_id` (R13-6). No
hard-delete path exists anywhere in the app; `close_own_account()` only
ever soft-scrubs, and its zero-balance check transitively blocks closure
while any monetary Position is outstanding (via the `reserved_balance <=
balance` invariant), with zero new code required.

**Immutability**: `monetary_positions` and `monetary_position_settlements`
have no UPDATE/DELETE grant for `service_role` at all — a genuine DB-level
guard, not merely "no code path calls it." `audit_logs` retains its
pre-existing hard append-only trigger. `predictions.result`/`graded_at`
now has an equivalent DB-level guard as of R13-3.

**Numeric safety**: every financial `bigint` amount and basis-point rate
column introduced in R1-R12 carries an explicit CHECK constraint (`stake
> 0`, `fee_bps` 0-10000, `fee_amount + winner_credit_amount <= stake`,
etc.) — verified to hold even against a hand-crafted raw insert, since
CHECK constraints are not RLS-bypassable.

## Sports ingestion / Posts / Conversation / XSS / SQL injection

No `dangerouslySetInnerHTML` exists anywhere in `app/`/`components/` —
zero raw-HTML injection points. All user-generated content (comments,
display names, admin notification copy with its `{{question}}`
placeholder substitution) renders through plain JSX text interpolation,
relying on React's default escaping. No dynamic SQL exists anywhere in
the R1-R12 migration range; `get_prediction_leaderboard`'s `p_period`
parameter is validated against an explicit allow-list before use, never
interpolated. Post comment body is DB-capped at 2000 chars
(`post_comments.body` CHECK) behind the admin-configurable 500-char
product default — the two limits stay correctly distinct.

## Wallet / Monetary / Settlement

Covered exhaustively by the pre-existing R8-R10 test suites (concurrent
reservation overcommit, duplicate-acceptance retry, accept-vs-decline
race, two-concurrent-settlement-attempts, admin-ad-hoc-debit-cannot-dip-
below-reserved-floor, reversal-vs-reservation conflict) plus this
milestone's own new cross-product test (R13-5). `monetary_position_
settlements`' CHECK constraints enforce conservation (`fee_amount +
winner_credit_amount <= stake`) unconditionally. Settlement is
idempotent by construction (`settle_monetary_position()` locks the
Position row `FOR UPDATE`, checks terminal state first, returns
`already_settled` rather than re-processing).

## Admin/configuration

Covered by R12's own extensive test suite plus this milestone's new
internal-role-check tests (R13-4). The entire Brohda settings surface
remains `super_admin`-only; financial (P2P fee) non-retroactivity was
re-verified end-to-end in R12 and is unaffected by this milestone's
changes.

## Rate limiting / abuse model

Comments, Call BS, and monetary Proposals are all server-side rate-limited
(`check_and_increment_rate_limit`, admin-configurable window/attempts as
of R12). This limits *velocity* per identifier, not distinct accounts —
**Sybil resistance is not claimed**: nothing in this architecture prevents
a determined actor from creating multiple accounts to multiply their
effective rate. This is standard for a social product at this stage and
not treated as a launch-blocker, but it is the honest limit of what the
current rate-limiting provides — stated plainly rather than overclaimed.
Call BS reputation farming (see above) is the one concrete manifestation
of this limit that was identified and is reported as an open decision.

## Application security (CSRF / CORS / headers / CSP / errors / secrets)

- **CSRF**: no custom middleware exists; Next.js 16's built-in Server
  Action same-origin protection is active, unmodified, with no widened
  `allowedOrigins`.
- **CORS**: no CORS headers are set anywhere in the app; browser
  same-origin default applies. Cron routes are correctly gated by a
  bearer-token check, not CORS.
- **Security headers**: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options:
  DENY`, `Strict-Transport-Security` (2-year max-age + preload) are all
  configured (`next.config.ts`).
- **CSP**: a real production CSP is configured (`default-src 'self'`,
  scoped `connect-src` derived from `NEXT_PUBLIC_SUPABASE_URL` at build
  time, `frame-ancestors 'none'`). `script-src` still carries
  `'unsafe-inline'` with no nonce in production — a defense-in-depth gap
  (not currently exploitable, given zero XSS injection points found), left
  as a documented P3 rather than fixed here (a nonce-based CSP is a
  meaningfully larger change touching every inline script, out of
  proportion to a currently-theoretical risk).
- **Error leakage**: sampled and grepped across all of `lib/actions/*.ts`
  — zero instances of a raw Postgres/Supabase error message reaching the
  client; every Server Action maps caught errors to a curated, generic
  string.
- **Secrets**: no committed or exploitable secret found anywhere in the
  working tree (tracked or untracked). `.env.local` holds a real
  production service-role key locally, as expected for a developer
  machine — gitignored, never committed, confirmed via full git history
  search. The client bundle (`.next/static/chunks/`) contains zero
  occurrences of the service-role key; the only JWT present is the public
  anon key, as expected.
- **Logging**: only 10 `console.*` calls exist across `lib/`/`app/`
  (excluding tests); none logs a full request/user object, auth headers,
  or wallet/financial details.

## Dependency security

See R13-2. Post-remediation: 0 critical, 10 high (all build-time-only
Sentry toolchain transitives, not production-reachable), 1 moderate.
`shadcn` was reclassified from `dependencies` to `devDependencies`
(confirmed never imported at runtime — CLI scaffolding tool only),
reducing production-audit noise going forward.

## Migration audit

All 157 migrations (through this milestone's own 4 new ones: 160-163)
applied cleanly to a fresh local database via `supabase db reset --local`
multiple times during this milestone, most recently as the basis for the
definitive final regression run. No migration was edited after having
been applied — every fix in this milestone (R13-1 through R13-6) is a new
forward migration, per this project's own established, unbroken
discipline. `CREATE OR REPLACE FUNCTION` calls in the R13-4 migration
preserve their exact existing parameter lists (confirmed the ACL is
untouched by direct grant inspection) and additionally restate their
`revoke`/`grant` explicitly anyway, matching the project's own convention
throughout rather than relying on that implicit preservation alone.

## Background jobs

7 of 10 production-relevant jobs are cron-route-exposed, `CRON_SECRET`-
gated, and overlap-safe via `recordJobRun()`'s `try_acquire_cron_lock`
wrapper — this exact overlap-lock mechanism was itself built in direct
response to a real prior incident (`sync-fixtures` stacking ~20x
concurrent runs). `docs/DEPLOYMENT.md` §5 was stale (missing 3 of the 7
actual routes) and has been corrected as part of this milestone.

**PRODUCTION OPERATIONS DECISION REQUIRED**: `grade-predictions`,
`settle-monetary-positions`, and `resolve-challenges` have no cron route
and no scheduler of any kind — manual-only by explicit prior design. In
production, without a human running these, Predictions never grade,
Challenges never resolve, and Positions never settle. See
`docs/DEPLOYMENT.md` §5 for the full framing and options. This blocks
**PRODUCTION OPERATIONS READINESS** below, independent of the underlying
code's own correctness.

## Residual risks (P3, explicitly deferred)

1. Production `script-src` CSP still uses `'unsafe-inline'` (no nonce) —
   defense-in-depth gap, not currently exploitable.
2. `user_profiles.display_name`/`username` have no DB-level CHECK
   constraint backing their Zod validation, while a direct `UPDATE` grant
   + ownership-only RLS exists — bypassable length/format via a direct
   PostgREST call (not XSS; React still escapes it).
3. Admin notification-copy fields have only a non-empty CHECK, no upper
   bound.
4. `lock-pools`/`process-results` cron loops isolate failures via
   `{error}` checks + `continue` rather than explicit per-iteration
   `try/catch` (unlike `sync-fixtures-nfl`/`settle-monetary-positions`) —
   self-heals via the lock TTL on the next tick regardless.
5. Sentry's own build-time toolchain carries 11 dependency advisories
   (fast-uri/brace-expansion/browserslist/baseline-browser-mapping) — not
   production-request-reachable, deferred pending a future `@sentry/
   nextjs` major upgrade evaluated on its own terms.
6. `connect-src`'s Supabase origin is baked from `NEXT_PUBLIC_SUPABASE_
   URL` at build time — an operational check (confirm the deploy pipeline
   injects the real production URL before `next build`), not a code
   defect.

## Legal / compliance boundary

Technical security and legal/regulatory readiness are separate. Nothing
in this milestone constitutes legal or compliance approval for monetary
P2P — no licensing, KYC, AML, or jurisdictional-eligibility conclusion is
made or implied here. That requires separate, qualified review.

## Legacy coexistence (R14 decision input)

Paid pools, free pools, pool settlement, and withdrawals all remain
functional and untouched by this milestone (verified: the full pre-
existing pool/settlement/wallet-request test suites pass unmodified). The
shared wallet ledger between legacy pools and P2P was stress-tested
end-to-end this milestone (R13-5) and holds coherently. **Classification
for R14: no material conflict.** Both products already shared the same
`apply_wallet_transaction()` primitive by construction before this
milestone; R13 only added the missing test proving it, changing no
behavior. This is factual engineering evidence for R14's own future
decision, not a recommendation to remove legacy pools.

## Production readiness matrix

| Area | Ready? | Evidence | Remaining risk |
|---|---|---|---|
| Authentication | Yes | Server-derived identity everywhere, zero findings | None |
| Authorization | Yes | 12/12 mutation surfaces confirmed-safe, DB-level ownership checks | None |
| RLS / DB privileges | Yes | Every R1-R12 table RLS-enabled; 25/25 SECURITY DEFINER functions search_path-safe; R13-1 closed the one grant-test coverage gap | None |
| Picks / locking | Yes | R13-3 closed the one DB-level gap; extensive existing race coverage | None |
| Sports ingestion | Yes | No dynamic SQL, cron-gated, overlap-locked, per-fixture failure isolation | None |
| Conversation | Yes | Zero XSS points, DB-capped input size, rate-limited | None |
| Call BS | Conditional | Core mechanics safe; reputation farming is an open product decision, not a security gap | See "Call BS reputation farming" |
| Wallet ledger | Yes | Single choke point, CHECK-enforced invariants, R13-5 proves cross-product coherence | None |
| Reservations | Yes | Full lifecycle tested; overcommit races proven blocked | None |
| Monetary Proposals | Yes | Ownership + balance checks at DB layer, race-tested | None |
| Positions | Yes | No UPDATE/DELETE grant exists at all — DB-level immutability | None |
| Settlement | Yes | Idempotent, conservation-enforced, non-retroactive fee snapshot re-verified | None |
| Reputation | Conditional | Forgery-proof, money-independent; farming is the one open question | See above |
| Admin/configuration | Yes | R13-4 closed the internal-check gap; atomic audit, optimistic concurrency | None |
| Audit history | Yes | Hard append-only, unconditionally | None |
| Privacy | Yes | No financial/PII leakage found in any audited surface | None |
| Reconciliation | Yes | Existing wallet/monetary reconciliation scripts cover R1-R12 state | None |
| Background jobs | No | 3 of 10 production-critical jobs are unscheduled by design | **PRODUCTION OPERATIONS DECISION REQUIRED** |
| Observability | Conditional | `background_jobs` run-history + Sentry (optional DSN) exist; no dedicated health endpoint | Acceptable for initial launch scale; revisit if uptime SLAs tighten |
| Migration path | Yes | Clean reset from empty DB, no edited migrations, 157/157 apply cleanly | None |
| CI | Conditional | Lint/typecheck/unit/integration/E2E all gated; no production-build step in CI | Add a `pnpm build` CI step (cheap, recommended, not itself launch-blocking since local builds are verified clean) |
| Production build | Yes | Clean build post-upgrade, all routes registered, no secret leakage in the client bundle | None |
| Repository integrity | Yes | See below | None |
| Legacy coexistence | Yes | No material conflict, evidence above | None |

## Repository integrity

- Branch: `brohda/prediction-network-m0-m2` — unchanged all session.
- HEAD: `c4d5b5502651625722f1114546dc92d43c17be27` — identical to this
  milestone's own starting baseline (also R12's). Nothing committed,
  nothing pushed, at any point across R9-R13.
- Migration head: `20260101000160` at the start of R13 → `20260101000163`
  now (4 new forward migrations, all additive, none editing an
  already-applied file).
- The 4 pre-existing untracked files (`NFL_INTEGRATION_ARCHITECTURE_
  NOTE.md`, `NFL_LAUNCH_VERIFICATION_REPORT.md`, `UNIVERSAL_SPORTS_
  ARCHITECTURE_PROPOSAL.md`, `docs/audits/brohda-repository-cleanup-
  inventory.md`) remain untouched, confirmed again this milestone.
- `SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md` (tracked, pre-existing) —
  read in full as essential context; not modified.
- No stray Docker containers: only local `_PollPools`-named containers
  were restarted (via `supabase db reset --local`, run several times this
  milestone); the unrelated `theaichurch` Supabase stack, and its
  `next-server` process independently occupying port 3000, were both left
  untouched (confirmed via `lsof`/`docker ps` before use, a different port
  used for this milestone's own dev-server verification).
- No production data, hosted Supabase project, or external USDT was
  touched at any point.

## Extension pattern

A future SECURITY DEFINER RPC must: set `search_path = public` explicitly;
avoid dynamic SQL unless the interpolated value is validated against a
fixed allow-list first (as `get_prediction_leaderboard` already does for
`p_period`); if it accepts an actor/admin id parameter for audit-logging
purposes, add an internal role check mirroring `reverse_pool_settlement()`
/ the R13-4 pattern rather than relying on the grant alone; be added to
`tests/integration/rpc-privilege-boundary.test.ts`'s `PROTECTED_RPCS`
table in the same migration that introduces it — this milestone's own
"configuration discovery"-style gap (10 untested functions) is the
concrete argument for doing this immediately, not as later cleanup.
