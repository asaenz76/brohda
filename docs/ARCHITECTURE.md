# brohda. — Architecture

This document is generated in Phase 1 (spec §23) and should be kept current
as later phases (wallet, fixtures, pools, settlement, reversal, reporting)
land. It describes what exists today, not the full MVP scope — see
`Poll_Pools_Spec_v1.1.md` and its Appendix X for the product spec.

## Stack

- **Next.js 16** (App Router, TypeScript, Turbopack) — deployed to Vercel.
- **Supabase**: Postgres (with RLS), Auth, Storage. Local dev via the
  Supabase CLI + Docker; no Prisma — plain SQL migrations under
  `supabase/migrations/`.
- **Tailwind CSS v4** (CSS-first `@theme` config, no `tailwind.config.ts`) +
  **shadcn/ui** (built on `@base-ui/react` primitives in this install).
- **TanStack Query** for client-side data fetching (wired up in
  `app/providers.tsx`; not yet used for real queries until Phase 4+).
- **Zod** for input validation on every server action / route handler.
- **Vitest** (unit + jsdom) and **Playwright** (E2E) for testing.

## Package manager and local tooling

This machine has no Homebrew, so tooling was installed without it:

- pnpm runs via `corepack pnpm ...`, or through a global install at
  `~/.npm-global/bin` (added to `PATH`) if you want a bare `pnpm` command.
- The Supabase CLI is a project devDependency (`pnpm exec supabase ...` /
  the `pnpm supabase:*` scripts), not a global Homebrew install.
- Local Supabase (`supabase start`) needs Docker Desktop, installed
  separately.

## Folder structure

```
app/
  layout.tsx, providers.tsx, globals.css   root layout, theme/query providers, design tokens
  page.tsx                                  redirects to /feed or /login
  (auth)/          login, invite/[token], reset-password — no AppShell, no auth required
  (app)/           feed, my-picks, pool/[id], activity, profile — behind requireUser(), wrapped in AppShell
  (admin)/admin/   users, invitations, fixtures, pools, reports, audit-log — behind requireSuperAdmin()
  api/avatar/      server-side avatar upload (validate → resize → store)
  api/cron/        sync-fixtures, lock-pools, process-results — CRON_SECRET-gated, each
                    wrapped in lib/jobs/record.ts for run-history persistence

components/        AppShell, nav, Avatar, BalancePill, ThemeToggle, ui/ (shadcn primitives)
components/pools/  SocialPoolCard and its sub-components — see below

lib/
  supabase/        client.ts (browser), server.ts (RLS-scoped SSR client),
                    admin.ts (service-role, bypasses RLS, server-only),
                    middleware.ts (session refresh + route protection, used by proxy.ts)
  auth/            session.ts (getCurrentUser/requireUser/requireSuperAdmin),
                    guards.ts (pure isUsableSession/isSuperAdmin — unit-tested)
  actions/          server actions: auth, invitations, users, profile, wallet, fixtures,
                    pools, entries, settlements, notifications, reversal
  audit/log.ts      writeAuditLog() — every admin action goes through this
  rate-limit/login.ts  wraps the Postgres check_and_increment_rate_limit RPC
  utils/money.ts    formatCents/parseDollarsToCents/parsePercentToBps/formatBps — the
                    only place money is formatted/parsed
  validations/      Zod schemas + avatar magic-byte sniffing
  sports-data/      SportsDataProvider abstraction (types, status-map, timezone,
                    http retry/backoff, api-football-provider, persist, sync)
  pools/            card-state, templates, view-model, fetch, lock, settle,
                    settlement-logic, anomaly, notices, transitions, reversal-logic — see below
  notifications/    create.ts (post-RPC notification generation), fetch.ts (unread count/list)
  jobs/record.ts    recordJobRun() — wraps a cron job function with background_jobs persistence
  reports/fetch.ts  aggregate queries for /admin/reports (users, pools, revenue, job health, ledger)

proxy.ts            Next.js 16's route-protection hook (formerly middleware.ts)

supabase/migrations/  numbered SQL migrations, applied in order by the Supabase CLI

scripts/create-super-admin.ts   one-time bootstrap for the first admin account

(cron jobs are scheduled externally via cron-job.org, not vercel.json — see docs/DEPLOYMENT.md)

tests/
  unit/            Vitest + jsdom, no live Supabase needed (`pnpm test`)
  integration/      Vitest + real local Supabase (`pnpm test:integration`)
  e2e/              Playwright against the running app + local Supabase (`pnpm test:e2e`)
```

## Auth and session flow

1. Invite-only registration only (spec §7). There is no public sign-up route.
   The very first admin is created by `scripts/create-super-admin.ts`
   (`pnpm create-super-admin --email ... --password ... --name ...`), since
   invite-only registration has no bootstrap path for the first user.
2. An admin creates an `invitations` row (`lib/actions/invitations.ts:createInvitationAction`)
   and copies the generated `/invite/{token}` link — no automated email send
   in Phase 1.
3. `/invite/[token]` looks the token up server-side with the **service-role**
   client (`lookupInvitation`), never through the browser's anon key. Accepting
   creates the Supabase Auth user, the matching `user_profiles` row, marks the
   invitation accepted, writes an audit log entry, and signs the user in.
4. `proxy.ts` → `lib/supabase/middleware.ts` refreshes the session cookie on
   every request and redirects unauthenticated requests away from `(app)` and
   `(admin)` route groups. `(app)/layout.tsx` and `(admin)/admin/layout.tsx`
   additionally call `requireUser()` / `requireSuperAdmin()` server-side —
   proxy-level protection is a fast path, not the only enforcement.
5. Login (`lib/actions/auth.ts:loginAction`) is rate-limited per email via a
   Postgres-backed token-bucket (`check_and_increment_rate_limit`,
   `supabase/migrations/*_rate_limits.sql`) before calling
   `signInWithPassword`, on top of Supabase Auth's own throttling.

## RLS and privilege model

Every table has RLS enabled from its first migration. The pattern used
throughout:

- **`is_super_admin(uid)`** (`SECURITY DEFINER`, fixed `search_path`) lets
  RLS policies check role without a self-referential-policy recursion issue.
- **Column-level grants**, not just row policies, restrict what an
  authenticated player can touch: e.g. `user_profiles` grants `UPDATE` on
  `(display_name, username, avatar_url)` only — role/is_active/invited_by
  changes require the service-role client (`lib/supabase/admin.ts`), used
  exclusively from server actions after a `requireSuperAdmin()` check.
- **`public_profiles`** is a view (owned by the migration role, so it
  bypasses RLS) exposing only `id, display_name, avatar_url` for any active
  member — this is what social features (creator header, avatar stacks in
  later phases) read instead of the full `user_profiles` table.
- **Append-only tables** (`audit_logs`, `wallet_transactions`) get
  `REVOKE UPDATE, DELETE` plus a raise-trigger (`forbid_audit_log_mutation`,
  shared by both), matching spec §8.2/§19 and Appendix Y acceptance
  criterion #33. **This is unconditional — even the service role cannot
  delete these rows.** A practical consequence: a `user_profiles` row that
  has ever had an audit or ledger entry can never be hard-deleted afterward
  (the FK has no cascade on purpose); tests deactivate such users instead of
  attempting `deleteUser`, and production never hard-deletes users anyway
  (they're deactivated, per spec).
- The service role is used **only** from `lib/supabase/admin.ts` (marked
  `server-only`) for the specific operations the spec calls out as
  admin/service-only: invitation issuance + acceptance, role/is_active
  changes, audit log writes, avatar storage writes, and wallet mutations
  (via the `apply_wallet_transaction` RPC below).

## Design tokens and theming

`app/globals.css` defines the Appendix X.2 palette as CSS custom properties
under `:root` (light) and `.dark` (dark, MVP default), then re-exposes them
as Tailwind v4 theme tokens in the `@theme inline` block — both shadcn's
existing slot names (`--background`, `--card`, `--primary`, …) and the
spec's own names (`--color-surface-primary`, `--color-text-secondary`,
`--color-accent-primary`, `--color-success-coral`, `--color-warning-muted`,
`--color-danger`). Components should always reach for a semantic utility
class (`bg-surface-primary`, `text-text-secondary`, …), never a raw hex
value. `next-themes` (`app/providers.tsx`) drives the `.dark`/`.light` class
toggle; `ThemeToggle` reads/writes it. Default theme is dark per spec.

## Wallet model (Phase 2, spec §8)

`wallet_balances` (one row per user + one house row, `balance >= 0` enforced
by a `CHECK`) and `wallet_transactions` (append-only, full field set from
spec §8.2 including `pool_id`/`entry_id`/`settlement_id` reserved — nullable,
no FK yet — for Phase 4/5 reuse) are provisioned automatically: an
`AFTER INSERT ON user_profiles` trigger creates the matching wallet row for
every new profile, admin or player, so no app code path needs to remember to
do it.

**`apply_wallet_transaction(...)` is the only place money moves.** A
`SECURITY DEFINER` Postgres function (fixed `search_path`, same shape as
`check_and_increment_rate_limit`) that in one transaction: checks the
`idempotency_key` first (returns the existing row unchanged if already
applied — never double-applies), `SELECT ... FOR UPDATE`s the relevant
`wallet_balances` row, rejects a debit that would go negative, then inserts
the `wallet_transactions` row and updates the cached balance atomically.
`REVOKE`d from `PUBLIC`, granted to `service_role` only — `lib/actions/wallet.ts`
(`depositAction`/`withdrawAction`, admin-only) is the only caller today.
Verified against a real concurrency test (`tests/integration/wallet.test.ts`):
firing N concurrent debits against a wallet that can only satisfy M of them
serializes correctly via the row lock, every time.

`BalancePill` and the Activity page (`app/(app)/activity/page.tsx`) now read
real data. Admins adjust balances from `/admin/users` (`WalletAdjustmentForm`,
same inline-expand pattern as `ToggleActiveForm`).

## Sports data / fixtures (Phase 3, spec §9)

`lib/sports-data/` is the `SportsDataProvider` abstraction — no application
code outside this folder ever sees a raw API-Football shape:

- **`types.ts`**: `SportsDataProvider` interface, `NormalizedFixture`,
  `FixtureInternalStatus` (mirrors the `fixture_internal_status` enum).
- **`status-map.ts`**: `normalizeApiFootballStatus()` maps the provider's raw
  short codes (`NS`, `1H`, `FT`, `AET`, …) to `FixtureInternalStatus`.
  Application logic reads only the normalized status, never a raw code.
  Also exports `TERMINAL_STATUSES` — the single source of truth for "stop
  polling this fixture," used both by `isTerminalStatus()` and by the sync
  job's SQL exclusion filter.
- **`timezone.ts`**: `resolveVenueTimezone()` — a curated static
  city→IANA-timezone map (API-Football reports venue city, not a timezone),
  falling back to a competition default, then `DEFAULT_TIMEZONE`. Needed for
  Appendix X.7.2's same-calendar-day void rule (Phase 4/5).
- **`http.ts`**: `fetchWithRetry()` — exponential backoff on 5xx/429/network
  errors (3 attempts), **never retries** other 4xx (permanent validation
  errors), and logs every terminal outcome to `provider_request_log`.
- **`api-football-provider.ts`**: `ApiFootballProvider implements
  SportsDataProvider`. `isEnabled()` reflects `API_FOOTBALL_ENABLED`; when
  false, `searchFixtures`/`getFixtureById` return an empty result / `null`
  without ever calling `fetch` — the import UI checks `isEnabled()` directly
  rather than inferring "disabled" from an empty search result.
  `regulationHomeScore`/`regulationAwayScore` map from API-Football's
  `score.fulltime` (the 90-minute score, even when ET/penalties were
  played — spec §16.3's exact requirement).
- **`persist.ts`**: `toFixtureRow()` — the `NormalizedFixture` → `fixtures`
  row mapping, shared by the sync job and the admin import action so the two
  can't drift apart.
- **`sync.ts`**: `runFixtureSync()` — queries every non-terminal fixture,
  computes each one's required refresh interval from its status and
  time-to-kickoff, skips fixtures refreshed more recently than that
  interval, de-duplicates by `external_fixture_id`, then fetches + upserts
  the rest via the service role.

**Cron granularity is an intentional platform adaptation, not a shortcut.**
Spec §9 wants live fixtures synced ~every 30s, but the minimum granularity
of cron-job.org (external scheduler; see docs/DEPLOYMENT.md — used instead
of Vercel Cron so this doesn't require a Vercel Pro plan) is 1 minute.
Rather than 3 separate cron entries or an in-request sleep loop, there's
**one** endpoint (`app/api/cron/sync-fixtures/route.ts`, hit on a
`* * * * *` schedule) whose internal throttling logic expresses every spec cadence
tier as a multiple of that 1-minute floor: live → every run; <6h to kickoff
→ 5min; >6h out → 30min; result-window → 2min; post-window → 10min. The
route checks `Authorization: Bearer $CRON_SECRET` and rejects if that env
var isn't set at all (never silently open).

Import (`/admin/fixtures`, `lib/actions/fixtures.ts`) lets an admin search
by league+season(+date) or by a direct fixture ID, then import (upsert)
selected results — audit-logged (`fixture.imported`) like every other admin
action.

## Pools and entries (Phase 4, spec §10-§13, §21, X.5/X.9/X.15)

**`pools`**, **`pool_options`**, **`entries`** — exact field sets from spec
§11.2/§12/§18. `pool_status`/`pool_type`/`participation_visibility`/
`entry_status` reserve their full spec-defined value sets now (same reason as
`wallet_transaction_type` in Phase 2), even though only a subset is reachable
before Phase 5 settlement/reversal.

**`create_pool_entry(...)` implements spec §13.3 step-for-step**, in the same
`SECURITY DEFINER` shape as `apply_wallet_transaction`: idempotency check →
confirm user active → lock the pool row, recheck `OPEN` + not past `locks_at`
→ confirm the option belongs to the pool and the amount matches the frozen
`entry_fee` → insert the entry (the `unique_active_user_entry_per_pool` index
is the final arbiter — a `unique_violation` returns the user's existing entry
as an idempotent success, never an error) → **calls `apply_wallet_transaction`
for the debit** (reused from Phase 2 — this is exactly the "extend
apply_wallet_transaction via `p_entry_id`" plan Phase 2/3 left for this
phase) → updates `pool_options` aggregates → stamps `first_entry_at`. If the
wallet debit raises (insufficient balance), the whole function rolls back —
entry insert included — for free, because it's one Postgres function.
`void_pool_entry(...)` is the admin-void mirror, crediting a refund the same
way. Both `REVOKE`d from `PUBLIC`, `service_role` only.

**Fee immutability (spec §11.3) is enforced twice**: `lib/actions/pools.ts`'s
`updatePoolAction` checks `first_entry_at` before allowing an edit, and a
`BEFORE UPDATE` trigger on `pools` (`enforce_pool_fee_immutability`) is the
non-negotiable DB-level backstop — rejects any change to
`entry_fee`/`house_fee_bps`/`question`/`pool_type` once `first_entry_at` is
set, and rejects moving `locks_at` later (only earlier is allowed).

**Privacy is enforced at the query/RLS layer, not the response mapper**
(spec X.15's explicit requirement, and the exact class of bug Phase 2's
missing `GRANT` taught us to watch for): `pool_options` itself is
`service_role`-only. `pool_options_public` (a view, so it bypasses RLS like
`public_profiles`) is what `authenticated` actually reads — it excludes
`DRAFT` pools and uses `can_view_pool_distribution(pool_id)` to null
`entry_count`/`total_entry_amount` per the pool's `participation_visibility`
+ whether the viewer has an entry. **`get_pool_totals(pool_id)`** is a
separate always-visible aggregate (spec §14's "total entries, gross pool"
pre-selection info is NOT gated — only the *per-option* breakdown is, per
X.5.6's specific wording: "hide per-option entry totals... which option is
leading"). `get_pool_participants(pool_id)` is the social-proof source
(X.5.6) — deliberately returns only `(user_id, display_name, avatar_url)`,
never `option_id`, so it's safe to expose regardless of
`participation_visibility`. All three are `SECURITY DEFINER`, verified
against real Postgres in `tests/integration/pools.test.ts` (pre-entry
hidden, post-entry revealed).

**Card-state derivation** (`lib/pools/card-state.ts`, spec §21/X.5.1):
`deriveCardState(pool, fixture, entryStatus)` — pure, exhaustively
unit-tested, implements the full enum now (including `SETTLED_WON`/
`READY_FOR_REVIEW`/anomaly-notice branches that are unreachable until
Phase 5, since spec wants this written once, not incrementally).

**`lib/pools/view-model.ts`** shapes raw DB rows into the X.14
`SocialPoolCardViewModel` contract (one field, `postedAt`, is a
representative extension beyond X.14's literal example interface — X.5.2
explicitly requires "Posted 18m ago" copy that needs a creation timestamp
X.14 doesn't list). **`lib/pools/fetch.ts`**'s `getPoolCardViewModels()` is
the shared multi-query orchestration (pool + options + fixture + creator +
viewer's entry + social proof) reused by Feed, `/pool/[id]`, and My Picks —
written once rather than duplicated per page.

**Auto-lock job** (`lib/pools/lock.ts` + `app/api/cron/lock-pools/route.ts`,
same `CRON_SECRET` pattern as `sync-fixtures`, same 1-minute Vercel Cron
floor): `OPEN → LOCKED` when `now() >= locks_at` **or** the linked fixture's
`internal_status` is no longer `NOT_STARTED` (spec §15's early-kickoff rule).
In the same run it also evaluates every `LOCKED` pool against
`min_total_entries` (spec §16.8's "when the lock job fires") — see the
Settlement section below for what happens next.

**UI** (`components/pools/`): `SocialPoolCard` orchestrates
`PoolCreatorHeader`/`MatchIdentity`/`RulePill`/`PoolOptionButton`/
`PoolDistributionBar`/`AvatarStack`/`LiveMatchStatus`/`PotentialPayoutFooter`/
`PoolStatusNotice`. `SlideToConfirm` is a real pointer-drag gesture (not a
styled button) with a keyboard path and a standard-button fallback — spec
calls this out as explicit Phase 4 scope, not Phase 7 polish, unlike the
rest of X.10's motion work. `EntryConfirmationSheet` is a focus-trapped
bottom sheet (X.11) generating one idempotency key per open. Team/provider
logos use plain `<img>`, not `next/image` — they come from arbitrary
external CDN domains (API-Football's, or whatever future provider), and
whitelisting every possible one isn't worth it; `next/image` stays reserved
for assets on domains we actually control (our own Supabase Storage
avatars).

**Admin** (`/admin/pools`): create (fixture picker from already-imported
`fixtures` + template choice + config → `DRAFT`) → review on the detail page
→ publish (`DRAFT → OPEN`). Editing is only rendered while `first_entry_at`
is null; the DB trigger is the real enforcement either way. Entry void
reuses the same inline-expand form pattern as `ToggleActiveForm`/
`WalletAdjustmentForm`.

## Settlement (Phase 5, spec §16-§20, X.7)

**New tables** (`supabase/migrations/20260101000010_settlements.sql`):
`settlements` (one row per grading attempt — the immutable snapshot +
interpretation record from spec §16.1/§16.5), `settlement_payouts`
(settlement_id, entry_id, amount), `notifications` (spec §20). `pools`
gains `void_reason` (a `pool_void_reason` enum covering both the X.7.1
anomaly reasons and §16.8's three outcomes).

A Phase 2 comment on `wallet_transactions.pool_id`/`entry_id`/`settlement_id`
said FKs would be "added via ALTER TABLE" once those tables existed. This
migration tried that and then reverted it: `wallet_transactions` is
permanently append-only (`REVOKE DELETE`, even from `service_role`), so a
hard FK from it makes anything it references — a pool, an entry, a
settlement — permanently undeletable too. That's correct in production
(financial history should outlive the entity), but it silently broke
integration-test cleanup the moment any test moved money, exactly like
`audit_logs.entity_id` already avoids by staying an unconstrained column.
These three columns stay plain `uuid`, same reasoning, no FK.

**Three `SECURITY DEFINER` functions**, same shape as `apply_wallet_transaction`/
`create_pool_entry`:

- **`prepare_pool_settlement(pool_id)`** — `AWAITING_RESULT → READY_FOR_REVIEW`.
  Determines the winning side from `fixtures`' score columns (there's no
  precomputed winner column — `WHO_WILL_ADVANCE` prefers penalty scores, then
  falls back to the final score; `REGULATION_RESULT` uses the 90-minute score
  only, per spec's own implementation note). Either result can come back
  ambiguous (`requires_manual_verification = true`, `winning_option_id`
  null) — the admin resolves it on the review screen rather than the system
  guessing. Also detects `NO_WINNING_ENTRIES`/`ALL_ENTRIES_WINNING`
  (§16.8) at this stage, computing the outcome but not yet moving money.
- **`confirm_pool_settlement(...)`** — `READY_FOR_REVIEW → SETTLED`. Rejects
  a stale `snapshot_version` (optimistic concurrency, §16.6) and rejects a
  non-`NORMAL` outcome (that goes through the function below instead). Pays
  every winner via `apply_wallet_transaction` (`pool_payout_credit`), credits
  the house (`house_fee_credit`), and separately credits the truncation
  remainder to the house (`rounding_remainder_credit`, Decision 3 — never
  redistributed to winners).
- **`confirm_pool_refund(...)`** — the shared void/refund machinery for
  **both** fully-automatic reasons (`MINIMUM_ENTRIES_NOT_REACHED` at lock
  time, and X.7's anomaly voids — called with `p_admin_id null`) **and** the
  two admin-confirmed §16.8 outcomes (`NO_WINNING_ENTRIES`/
  `ALL_ENTRIES_WINNING`, which spec explicitly says must be shown to the
  admin as a proposed action, not executed silently). Sets `pools.status` to
  `CANCELLED` specifically for the minimum-entries reason, `VOIDED`
  otherwise — matching spec's own wording even though §11.5's transition
  diagram only draws `LOCKED → VOIDED` (see `lib/pools/transitions.ts`'s
  comment on this literal-text-vs-diagram reconciliation).

**Winning-side determination and payout math are mirrored in pure,
unit-tested TypeScript** (`lib/pools/settlement-logic.ts`) even though the
SQL functions above are authoritative — this is documentation and
regression coverage, not a second code path anything depends on.

**Anomaly handling** (`lib/pools/anomaly.ts`, X.7): all six statuses that
never enter normal settlement (spec §16.4) are covered —
POSTPONED/SUSPENDED/ABANDONED/CANCELLED wait for X.7.2's same-calendar-day
grace window (computed via `Intl.DateTimeFormat` against the fixture's
already-resolved `venue_timezone`, no new date library); AWARDED/UNKNOWN
(added per §16.4, not named in X.7.1) void immediately since neither
describes a match that might still resume.

**`process-results` cron** (`lib/pools/settle.ts` + `app/api/cron/process-results/route.ts`,
same pattern/cadence as the other two): for every `AWAITING_RESULT` pool,
reads the linked fixture (kept current by the existing `sync-fixtures` job)
and either calls `confirm_pool_refund` (anomaly, day elapsed),
`prepare_pool_settlement` (fixture `COMPLETED`), or does nothing (still in
progress / anomaly, day not elapsed yet). Deliberately a separate job from
`lock-pools` — this step depends on fixture-sync data catching up, not a
clock.

**Notification copy lives in exactly one place**, `lib/pools/notices.ts` —
every X.7.6-11 refund/void string, X.5.14's won/lost copy, and the
LOCKED/READY_FOR_REVIEW/suspended-waiting notices `PoolStatusNotice`
renders. `SocialPoolCardViewModel.notice`/`currentUser.finalPayout`/
`refundedAmount` are now populated for real in `lib/pools/view-model.ts`
(previously hardcoded `null` pending this phase). Notification **rows**
(`lib/notifications/create.ts`) are built from this same copy source and
inserted by the TS caller *after* the settlement/refund RPC returns —
never from inside the SQL function — so presentation text never has to be
duplicated in two languages. `card-state.ts`'s `AWAITING_RESULT` branch
also gained the same anomaly-notice detection the `VOIDED` branch already
had, so the notice appears the moment the provider reports an anomaly
(X.7.3), not only once the pool actually voids.

**Admin review** (`/admin/pools/[id]`, rendered only while
`pool.status === 'READY_FOR_REVIEW'`): shows the settlement snapshot
(scores, provider status, proposed winner or a required picker when
ambiguous, gross/fee/net/winner-count/payout/remainder) and either a
**Confirm Settlement** or (when the outcome is a proposed refund) a
**Confirm Refund** button — `settlement-review-form.tsx`, same
`useActionState` + one-time-idempotency-key pattern as every other admin
form in this codebase.

## Reversal and reporting (Phase 6, spec §17, §18, §23)

**`reverse_pool_settlement(pool_id, admin_id, reason, idempotency_key)`** is
spec §17's entire dry-run-then-execute-or-block workflow as one admin-
triggered `SECURITY DEFINER` call (re-reading §17 literally: the admin's
only action is "request reversal with a reason" — the dry-run and the
conditional execute/block are what the *system* does automatically in
response, in one transaction, not a separate preview-then-confirm UI step).
Callable from `SETTLED` (first request) or `REVERSAL_FAILED_MANUAL_REVIEW`
(retry after the admin resolves a shortfall out of band — e.g. an
`admin_adjustment_credit`):

1. Locks the pool and the current settlement (`grading_version = pools.snapshot_version`).
2. Dry run: locks every winner's `wallet_balances` row and checks it can
   absorb the clawback — pure reads, nothing written yet.
3. **All winners can absorb it**: debits each winner and the house
   (`settlement_reversal_debit`, reusing `apply_wallet_transaction` exactly
   like every other money movement in this codebase), resets the reversed
   entries back to `ACTIVE` and clears `pool_options.is_winning_option` (so
   a fresh grading doesn't inherit stale WON/LOST/winner state from the
   attempt being undone), marks the settlement `reversed_at`, bumps
   `pools.snapshot_version`, sets `pools.status = 'SETTLEMENT_REVERSED'`,
   then calls `prepare_pool_settlement` again in the *same* transaction —
   landing on `READY_FOR_REVIEW` with a fresh snapshot at the new grading
   version (spec: "the pool then returns to READY_FOR_REVIEW for
   re-settlement with a new snapshot"). "Only one active settlement version
   may exist" falls out for free this way: active is just whichever
   `settlements` row matches `pools.snapshot_version` — no extra flag.
4. **Any winner can't absorb it**: nothing is written to any wallet table;
   the full shortfall report (every affected winner, not just the ones
   short — spec §17.4) is stored on `settlements.reversal_shortfall_report`
   as jsonb, and `pools.status` becomes `REVERSAL_FAILED_MANUAL_REVIEW`.

`prepare_pool_settlement` (Phase 5) needed exactly one change to support
this: its status guard now accepts `SETTLEMENT_REVERSED` in addition to
`AWAITING_RESULT` — everything else about it (read fixture, determine
winner, compute math, insert at the pool's current `snapshot_version`) was
already correct for re-settlement. `settlement_reversal_credit` (reserved
since Phase 2 alongside `settlement_reversal_debit`) stays unused — §17
only ever describes debiting money back, never crediting it.

**`abort_pool_reversal(pool_id)`**: `REVERSAL_FAILED_MANUAL_REVIEW → SETTLED`,
no wallet effect at all (spec: "no financial effect").

**`lib/pools/reversal-logic.ts`** mirrors the dry-run feasibility check in
pure, unit-tested TypeScript, same "documentation + regression coverage"
role `settlement-logic.ts` plays for Phase 5's math.

**Admin UI** (`/admin/pools/[id]`): a `SETTLED` pool gets a reversal-request
form (reason required); `REVERSAL_FAILED_MANUAL_REVIEW` gets the shortfall
table (joined to `user_profiles` for display names) plus Retry/Abort
buttons; every pool with any settlement history gets a small table at the
bottom listing every `settlements` row (grading version, outcome, winner,
confirmed/reversed timestamps) — the full audit trail across however many
grading attempts a pool has had.

**`background_jobs`** (spec §18): none of the three cron routes persisted
their run history anywhere before this phase — each just returned its
result to whatever invoked it (Vercel Cron) and it was lost. `lib/jobs/record.ts`'s
`recordJobRun(jobName, fn)` wraps each route's existing call
(`sync-fixtures`, `lock-pools`, `process-results`) with no change to the
job logic itself — times it, inserts one row (`success` + result, or
`error` + message), rethrows on failure so the route's existing error
behavior is unchanged.

**`/admin/reports`** (new `AdminNav` tab): six plain-aggregate-query
sections — user counts, pools by status, pending admin attention
(`READY_FOR_REVIEW` + `REVERSAL_FAILED_MANUAL_REVIEW`, linked), house
revenue, job health (last run per job), and a wallet-transactions-by-type
summary (the "financial reports" deliverable). No charting library, no
CSV export, no date-range pickers — matches the proportionate style of
every other admin page so far. House-revenue-excluding-reversed needs no
special filtering: since reversal is an explicit compensating debit
against the house account, the house's current `wallet_balances.balance`
already nets out anything reversed on its own.

## Phase 7 (Social Polish and Hardening, spec §23)

The final phase per spec §23's 7-phase list — every item deferred across
Phases 4-6 ("Phase 7" notes in this file) actually gets resolved here,
since there's no Phase 8 to push anything further into.

- **Rate limiting** (spec §19): `lib/rate-limit/check.ts` extracts the core
  `check_and_increment_rate_limit` RPC call (built Phase 1, only wired to
  login until now) into a shared `checkRateLimit(identifier, windowSeconds,
  maxAttempts)`. Entry submission (`entry:{userId}`, 20/min) and invitation-
  token lookup (`invite-lookup:{token}`, 20/10min) now go through it
  alongside login (`login:{identifier}`, 10/15min).
- **Ledger accordion + date grouping** (X.6): `lib/utils/date-grouping.ts`
  (pure, UTC-based, unit-tested) buckets Activity's wallet transactions into
  Today/Yesterday/This week/Earlier. Each transaction row
  (`components/activity/TransactionRow.tsx`) is now an inline-expand
  accordion (same `useState` pattern as `VoidEntryForm`) — pool-linked rows
  expand to show the pool question and, once a settlement exists, the full
  snapshot (gross/fee/net/winners/payout), including X.6.5's rounding-
  disclosure line whenever `settlements.rounding_remainder > 0`.
- **My Picks grouping**: Active vs. Settled sections, using the same derived
  `CardState` the card already computes — no new query. `POSTPONED_NOTICE`/
  `SUSPENDED_NOTICE` count as Active (outcome still pending); `VOIDED`/
  `CANCELLED_NOTICE` count as Settled (always terminal).
- **`SharePoolButton`** (`components/pools/SharePoolButton.tsx`): native
  `navigator.share()` with a clipboard-copy fallback, shown on `HIDDEN`-
  visibility pools. Required threading `pools.visibility` through
  `BuildViewModelInput`/`SocialPoolCardViewModel` (it wasn't previously
  exposed to the view-model layer).
- **`NotificationToast`**: polls a new `getNotificationPollStateAction`
  server action every 20s (reusing `getUnreadCount`/`getNotifications`, no
  new query) — the first poll only establishes a baseline so pre-existing
  unread notifications never trigger a toast on page load. Mounted once in
  `AppShell`.
- **Settled-win celebration** (X.10): one CSS `@keyframes celebrate-pop`
  animation on `PoolStatusNotice` when `notice.type === "SETTLED_WON"` —
  scoped to exactly this, not a general animation pass.
- **Accessibility**: `:focus-visible` global fallback (`app/globals.css`);
  `aria-hidden` on purely-decorative distribution bars/avatar stacks (the
  adjacent text already conveys the same info); every page gets exactly one
  `<h1>` (mostly `sr-only` — the visible nav/brand already serves as chrome)
  closing what was a hard heading-hierarchy gap on every app and admin page.
- **Error boundaries**: `app/(app)/error.tsx`, `app/(admin)/admin/error.tsx`
  — verified live by temporarily throwing in a page and confirming the
  boundary renders, then reverting.
- **Responsive pass**: verification-first (browser resize, not a redesign)
  — found and fixed two real bugs: `AdminNav`'s tab row had no
  `overflow-x-auto`, forcing the whole page body to scroll horizontally on
  mobile; every admin table wrapper used `overflow-hidden` instead of
  `overflow-x-auto`, silently *clipping* columns (e.g. the Balance column on
  `/admin/users`) rather than making them reachable via scroll.
- **Acceptance-criteria audit**: `docs/ACCEPTANCE_CRITERIA.md` checks all 24
  of X.16's original criteria plus Appendix Y's 12 v1.1-additive criteria
  against actual behavior — 36/36 pass.
- **`scripts/seed.ts`** (`pnpm seed`): reuses the real RPCs
  (`create_pool_entry`, `prepare_pool_settlement`, `confirm_pool_settlement`,
  `confirm_pool_refund`, `reverse_pool_settlement`, `apply_wallet_transaction`)
  to produce 5 demo players and 10 pools spanning every `PoolStatus` reachable
  in practice, including one with a rounding remainder and one reversed
  settlement. Not idempotent — run against a freshly reset database, after
  `pnpm create-super-admin`. Never run against production.

## Feed: status/sport/league filters, OPEN by default (post-Phase-7)

`app/(app)/feed/page.tsx` defaults to `pools.status = 'OPEN'` when no
`?status=` param is present, but a third `<select>` in
`app/(app)/feed/feed-filters.tsx` lets a player browse any status in the
curated `FEED_STATUS_OPTIONS` list (`lib/pools/status-filter.ts`): Open,
Locked, Awaiting Result, Cancelled, Voided, Settled — "All" first, the rest
alphabetical, matching in-order the ask ("ALL, OPEN, LOCKED, AWAITING
RESULT, CANCELLED, VOIDED, SETTLED in alphabetical order"). This list
deliberately excludes admin-internal statuses (`DRAFT`, `SCHEDULED`,
`READY_FOR_REVIEW`, `SETTLEMENT_REVERSED`,
`REVERSAL_FAILED_MANUAL_REVIEW`) — "All" means every status in this
curated set, not literally every `pool_status`. Selecting "All" swaps the
query's `.eq("status", ...)` for `.in("status", FEED_STATUS_OPTIONS)`; a
specific status just narrows to that one value.

Filtering by raw DB status alone reintroduces the same `locks_at` race
`deriveCardState` already corrects for on the card itself: the lock cron
only runs once a minute (not at all outside Vercel Cron), so a pool past
its lock time can sit with `pools.status` still `'OPEN'` until that job
catches up — filtering "Open" by DB status alone would show a pool no
longer available to bet on. `lib/pools/status-filter.ts`'s
`effectivePoolStatus()` corrects this: an `'OPEN'` row whose `locks_at` has
passed is treated as `LOCKED` for filtering purposes. Concretely, the DB
query fetches `OPEN` rows when filtering by Open, `OPEN` **and** `LOCKED`
rows when filtering by Locked (since some `OPEN` rows are really locked),
and refines with `effectivePoolStatus()` afterward — so "Open" only ever
shows pools genuinely still open, and "Locked" picks up both the
DB-`LOCKED` rows and the not-yet-synced `OPEN`-but-past-lock ones. Whatever status is
selected, Feed still excludes any pool the current user already has an
`ACTIVE` entry in (a second query against `entries`) — a pick moves to My
Picks' "In progress" the instant it's made, not just once the pool locks,
so Feed never shows a pool the player can still act on twice. Once a pool
settles/voids, its entry is no longer `ACTIVE` (it's `WON`/`LOST`/`VOID`/
`REFUNDED`), so browsing Feed with a Settled/Cancelled/Voided status filter
can legitimately show a pool that also appears in My Picks' History — that
overlap is intentional here, since Feed under this filter is a general
"browse past community activity" view, not an actionable-picks list.

Distinct `sport`/`competition_name` values across the current status-
filtered set become the sport/league `<select>` filters (all three drive
`?status=`/`?sport=`/`?league=` query params via
`useRouter`/`useSearchParams`; the server component does the actual
filtering). Results are always sorted `created_at` descending — most-
recently-created pool first, matching the same ordering the admin pools
list (`app/(admin)/admin/pools/page.tsx`) already used — with no sort
toggle. In practice `fixtures.sport` is always `'football'` in this app
(the sports data provider is soccer-only per spec), so the sport filter has
just the one option in this dataset; `competition_name` is where the real
variety (and therefore useful filtering) lives.

## My Picks: In progress / History (post-Phase-7)

`app/(app)/my-picks/page.tsx` only ever shows pools the player has actually
entered, split into two sections by `CardState`: **In progress** (anything
not yet concluded — `OPEN_POST_VOTE`, `LOCKED`, `LIVE`, `READY_FOR_REVIEW`,
the `POSTPONED_NOTICE`/`SUSPENDED_NOTICE` anomaly states) and **History**
(`SETTLED_WON`, `SETTLED_LOST`, `VOIDED`, `CANCELLED_NOTICE`). A pick lands
in "In progress" the moment it's made — `OPEN_POST_VOTE` (entered, pool
still open) is included rather than excluded, matching Feed's own exclusion
of already-entered pools above: the two pages are mutually exclusive by
construction (a pool is in exactly one of them for a given player at any
time), not by filtering the same CardState out of both. `OPEN_PRE_VOTE`
stays excluded, though it can't actually occur here — every row comes from
the user's own `ACTIVE`/`WON`/`LOST` entry, which always implies
`hasActiveEntry` — kept as a harmless safety net.

## Player wallet page + deposit/withdrawal requests (post-Phase-7)

Clicking the header balance pill (`components/BalancePill.tsx`, now a
`Link`) opens `/wallet` — new, since the real spec's §8.5 manual-funding
flow is entirely admin-initiated (no user-facing "request" flow was ever
specified). New `wallet_requests` table
(`20260101000013_wallet_requests.sql`): a player submits a deposit/
withdrawal request (`lib/actions/wallet-requests.ts`'s
`submitWalletRequestAction`, written via the service role like every other
wallet-adjacent mutation — `requireUser()` scopes it to the caller's own id,
never trusted from the form); an admin reviews all requests on
`/admin/wallet-requests` (new `AdminNav` tab) and Approves (which calls the
existing `apply_wallet_transaction` RPC unchanged — the approval *is* the
credit/debit) or Rejects (status update only, no money movement). No
`INSERT`/`UPDATE` grant to `authenticated` on `wallet_requests` at all —
only `SELECT` (own rows, or all rows for admins), matching every other
wallet-adjacent table's grant shape. The existing direct admin
credit/debit (`depositAction`/`withdrawAction` on `/admin/users`) is
unchanged and still available for ad-hoc adjustments outside the request
flow.

## Pre-deployment fixes (post-Phase-7)

Found during the product owner's own manual pre-deployment testing:

- **`locks_at` display/gating race**: `deriveCardState` (`lib/pools/card-state.ts`)
  now takes an optional `locksAt` and treats a pool as `LOCKED` the moment
  the clock says so, not just once `pools.status` catches up — the lock
  cron only runs once a minute (and not at all outside Vercel Cron), so a
  pool past its lock time could previously still show enabled, clickable
  options client-side even though `create_pool_entry` correctly rejected
  the entry server-side. `SocialPoolCard` also grays out a locked card
  (`opacity-70 grayscale-[0.4]`) so it visually reads as unavailable.
- **Manual admin pool-progression controls** (`lib/actions/pool-lifecycle.ts`,
  wired into `/admin/pools/[id]`): `forceLockPoolAction` (OPEN → LOCKED, any
  time — matches the spec's admin Force Lock capability, not gated on
  `locks_at`), `advanceLockedPoolAction` (LOCKED → AWAITING_RESULT or
  → CANCELLED below minimum), `checkPoolResultNowAction` (AWAITING_RESULT →
  READY_FOR_REVIEW / VOIDED / still-waiting). Each mirrors the exact
  branching the corresponding cron job (`lib/pools/lock.ts`,
  `lib/pools/settle.ts`) already does for a single pool, reusing the same
  RPCs/helpers — so an admin isn't stuck waiting up to a minute (or forever,
  locally) for grading. Note `prepare_pool_settlement` itself has no
  fixture-status guard; `checkPoolResultNowAction` has to replicate
  `processAwaitingResults`'s anomaly/grace-window/COMPLETED branching itself
  rather than calling the RPC directly, or it could push a still-live match
  into "needs manual verification."
- **Human-readable league search** (`SportsDataProvider.searchLeagues`,
  `ApiFootballProvider` against the real `/leagues?search=` endpoint): the
  fixture-import "League ID" field was a raw numeric ID the admin had to
  already know. `app/(admin)/admin/fixtures/league-search.tsx` searches by
  name (e.g. "Premier League") and feeds the selected league's ID into the
  existing fixture search via a hidden input — `searchFixturesAction`/its
  schema needed no changes.
- **Fixture-search date field** is now a real `<input type="date">` instead
  of a free-text `YYYY-MM-DD` field.
- **Admin pools list filtering** (`app/(admin)/admin/pools/pools-table.tsx`):
  client-side filter by question text, status, and locks-on date — pool
  counts here don't warrant server-side/query-param filtering.
- **Feed sort** (`?sort=newest|locking_soon` on `/feed`): sorts the
  already-fetched view-model array server-side by `postedAt`/`locksAt`
  (both already on `SocialPoolCardViewModel`) — no extra query, no
  client-side page.

## Admin wallet transaction colors + house revenue on /wallet (post-Phase-7)

Wallet transaction amounts are now colored by direction everywhere they
appear (Activity ledger, wallet requests, admin reports, settlement
notices): `text-credit` (`#16db65`) for funds added, `text-debit`
(`#ff6b6b`) for funds removed — new tokens in `app/globals.css`, kept
separate from `success-coral`/`danger` since those are reused for unrelated
status indicators (active/approved/job-health) that shouldn't shift color
just because this rule changed. Neutral totals/estimates (balances,
potential-payout estimates, fee disclosures) are untouched.

Separately: `wallet_balances` has always had a real `'house'`-type row (a
singleton, `user_id=null`) that accrues coordinator fee revenue on every
settlement via `apply_wallet_transaction` — but every wallet query in
`app/(app)/` (the header balance pill in `layout.tsx`, `/wallet`) filtered
by `user_id = auth.uid()`, which can never match a `user_id=null` row for
anyone. An admin visiting `/wallet` saw their own (always-empty) personal
wallet instead of the platform revenue they actually meant. Fixed by
branching on `user.role` in `app/(app)/layout.tsx` and
`app/(app)/wallet/page.tsx`: a `super_admin` now sees the house balance
(header pill and `/wallet`), and `/wallet` renders a dedicated
`HouseRevenueView` (`app/(app)/wallet/house-revenue-view.tsx`) — balance,
fee/rounding/reversal breakdown (reusing `getHouseRevenue()` from
`lib/reports/fetch.ts`), and a full `TransactionRow` history of house
transactions. The deposit/withdrawal request form doesn't apply to the
house account (it's user-scoped, and house revenue isn't "requested" in —
it accrues automatically from fees), so it's simply not rendered for
admins. Players are entirely unaffected — the existing personal-wallet
code path only runs when `user.role !== "super_admin"`.

## Fixture league dropdown + bulk import; expandable pools list (post-Phase-7)

`app/(admin)/admin/fixtures/page.tsx` now fetches every league the provider
knows about once, server-side (`apiFootballProvider.searchLeagues("")` —
an empty query omits the `search` param entirely and lists all leagues
rather than filtering by name), and renders them as a single `<select>`
grouped by country (`league-select.tsx`, `<optgroup>` per country) instead
of the previous type-to-search box — with the full list already in hand
there's nothing left to search for, and a native `<select>` gives free
browser type-ahead for narrowing hundreds of entries. The rest of the
by-league search flow (season, optional date, Search button) is unchanged.

Fixture import gained bulk select: `fixture-results-list.tsx` adds a
"Select all / Import selected (N)" toolbar above the results, and each
`fixture-result-row.tsx` got a checkbox alongside its existing per-row
Import button. Both paths now call the same `importFixturesAction(
fixtureIds: string[])` (`lib/actions/fixtures.ts`) directly from the client
via `useTransition` — no `<form>`/`useActionState` needed since the
single-row case is just a batch of one. The old `importFixtureAction`
(single, form-based) and `searchLeaguesAction`/`leagueSearchSchema` (type-
to-search) were removed; nothing else referenced them. Bulk import is
capped at 50 fixtures per call (`importFixturesSchema`) as a sanity bound.

`app/(admin)/admin/pools/pools-table.tsx` rows are now expandable
(chevron toggle, one at a time) to a read-only detail panel — pool ID,
match (fixture home/away/kickoff/competition, joined in
`admin/pools/page.tsx`), question, entry/coordinator fee, options with
vote tallies, settlement history, and the full entries table — all data
the full `/admin/pools/[id]` "manage" page already shows, but with zero
editable controls (no force-lock/void/settlement-review/reversal forms).
The Manage link is unchanged and still navigates to that real page for
anything actionable. All the data needed to render every row's expanded
panel is fetched once in `page.tsx` (a handful of bulk `.in(poolIds)`
queries) rather than per-expand, so toggling is instant with no loading
state.

## Instagram-style social feed redesign (post-Phase-7)

The product is pivoting from "a private sports-pool utility app" to a
mobile-first social feed where predictions are the content — feel like
Instagram/Threads/BeReal, never a sportsbook/trading platform. This is a
large, phased initiative (see the approved plan for the full 9-phase
breakdown: creator header + footer icons → nav reorg → My Picks-as-profile-
tab → follows → likes → comments → leaderboard/streaks → stories row →
search). Confirmed decisions driving all of it: predictions stay
admin/super_admin-authored only (no user-generated content/moderation
system); the social graph is follow/unfollow only (no separate "friend"
relationship); reactions are a single heart/like; the leaderboard number is
a literal count of correct predictions, not abstract points; weekly/monthly
leaderboard ranges are required at launch (a per-settlement ledger table,
not just running counters).

### Phase 1 — creator header reversal + numeric social-proof + footer icons

Two sessions ago, `PoolCreatorHeader.tsx` was changed to show the league's
crest + name instead of the pool creator, on the reasoning that "every pool
is admin-created, so naming the creator is noise." That reasoning no longer
holds: the product now wants every card to read like a social post
authored by a person, exactly because predictions are admin-created — the
admin is the "poster." This phase reverses it: `PoolCreatorHeader` shows
the creating admin's own avatar + display name + "Posted Xh ago" + a
"Public"/"Private" pill (`pools.visibility`), matching a standard social-
app post header. The league crest is gone from the header entirely;
competition name + round now render as a plain metadata line in the card
body between the header and `MatchIdentity` (`{competitionName} ·
{round}`), and `competitionLogoUrl` simply isn't rendered anywhere for now
(the column/field stays in the schema/view-model, cheap to resurrect).
`creator: { displayName, avatarUrl }` is back on `SocialPoolCardViewModel`/
`BuildViewModelInput`, and `getPoolCardViewModels` re-adds the
`public_profiles` batch lookup keyed by `pools.created_by` it had before
being removed.

`AvatarStack.tsx`'s prose-sentence social proof ("Alex has locked in a
choice.") is replaced with a numeric "{N} predicted" stat next to the
avatar overlap — one visual language for this stat everywhere, matching
the mockup, rather than maintaining two.

The card footer gained a right-aligned engagement-icon row: heart
(`Heart` from lucide-react) and comment (`MessageCircle`) render as inert,
`disabled` ghost icon buttons for now (Phases 5/6 wire real data into
them, so the footer's layout only changes once) and `SharePoolButton` — now
restyled as a plain icon-only ghost button (`variant="ghost" size="icon"`)
rather than a bordered "Share" button — moved out of the title row and
into this footer, available on **every** pool rather than only
`HIDDEN`-visibility ones.

### Phase 2 — bottom nav reorg + header bell

`MobileBottomNavigation.tsx` goes from 4 items (Feed/My Picks/Activity/
Profile) to the Instagram-style 5: **Home** (`/feed`), **Search**
(`/search`, placeholder page until Phase 9), a **centered elevated Create
button** (bespoke markup, not a list item — filled `bg-accent-primary`
circle floating above the bar via negative margin), **Leaderboard**
(`/leaderboard`, placeholder page until Phase 7), and **Profile**
(`/profile`, now rendering the current user's own `Avatar` as the tab icon
instead of a generic `User` icon). The unread-notification badge moves off
this nav entirely — the header's new `Bell` icon (next to `BalancePill`/
admin link/`ThemeToggle` in `AppShell.tsx`) now owns it, linking to
`/activity`.

The Create button's `href` is computed server-side in
`app/(app)/layout.tsx` and passed down through `AppShell` →
`MobileBottomNavigation`: for `super_admin` it's the existing
`/admin/pools/new`; for players it's a quick-entry shortcut computed by
`lib/pools/fetch.ts`'s new `getNextUnenteredOpenPoolId()` — the
soonest-locking OPEN pool the player hasn't entered, falling back to
`/feed` if none exist. That query filters on `locks_at > now()` in
addition to `status = 'OPEN'`, mirroring `status-filter.ts`'s
`effectivePoolStatus()` correction elsewhere in the app — the lock cron can
lag, so a raw `status = 'OPEN'` filter alone could shortcut a player into a
pool that's actually already locked.

`/search` and `/leaderboard` are minimal placeholder pages (reused
`EmptyFeedState`, "coming soon" copy) so the nav has somewhere to land
before Phases 9 and 7 build their real content — same route, body swapped
out later.

### Phase 3 — My Picks becomes a Profile tab

`/my-picks` no longer exists as its own page — its body (entries fetch +
In progress/History grouping) moved into
`app/(app)/profile/predictions-tab.tsx`'s `PredictionsTab({ userId })`, a
plain server component the Profile page renders for the current user.
`/my-picks/page.tsx` is now a one-line `redirect("/profile")` so any
existing deep link still lands somewhere sensible; every
`revalidatePath("/my-picks")` call (`lib/actions/entries.ts`,
`lib/actions/settlements.ts`) was repointed to `/profile`.

`app/(app)/profile/page.tsx` renders a client `ProfileTabs` component
(`profile-tabs.tsx`) with two slots — "Predictions" (the factored-out
component) and "Edit profile" (the pre-existing avatar uploader + display-
name/username form + logout button, previously always-expanded on the
page). Both slots are server-rendered once and toggled with `hidden`/
`block` on the client rather than conditionally mounted, so switching tabs
doesn't re-fetch or lose scroll position. "Predictions" is the default tab.

### Phase 4 — Follows + public profile page

New migration `20260101000015_follows.sql`: `follows(id, follower_id,
followee_id, created_at)` with `check (follower_id <> followee_id)` and a
`unique_follow` unique index on `(follower_id, followee_id)` (naturally
idempotent toggle, not a stored idempotency-key column). The table grants
**nothing** to `authenticated` — not even `SELECT` — so the follow graph is
never queried directly; it's read only through two `security definer
stable` RPCs mirroring `user_has_entered_pool`'s shape:
`is_following(follower_id, followee_id)` and
`get_follow_counts(user_id)`. Writes go through
`lib/actions/follows.ts`'s `toggleFollowAction(followeeId,
isCurrentlyFollowing)` via the service role (`requireUser()` scopes it to
the caller), rate-limited by `lib/rate-limit/follows.ts`. The same
migration extends `public_profiles` with `username` (`create or replace
view`, appended after `avatar_url` — Postgres allows a replaced view to
append columns but not reorder them, since the view's OID and existing
grant to `authenticated` only survive if the column list is extended, not
rearranged).

`components/profile/FollowButton.tsx` is a client component with
optimistic toggle (`useTransition`, flips local state immediately, reverts
on error) — mirrors `FixtureResultRow.tsx`'s plain-async-server-action-via-
`startTransition` pattern rather than `useActionState`, since there's no
form/FormData involved.

New `app/(app)/profile/[username]/page.tsx`: looks up the target by
`username` via `public_profiles`, 404s if not found, redirects to
`/profile` if it's the viewer's own username. Renders avatar, display
name, follower/following counts (`get_follow_counts`), `FollowButton`, and
a "Predictions" section reusing Phase 3's `PredictionsTab` — but called
with `statuses={["WON", "LOST"]}` (a new optional parameter, default
`["ACTIVE", "WON", "LOST"]` for the owner's own `/profile`) so a visited
profile only ever shows settled picks, never in-flight `ACTIVE` entries.
`PredictionsTab`'s own `wallet_balances` lookup is harmlessly RLS-scoped to
the *profile owner's* balance when called this way — invisible to anyone
but that owner, and irrelevant here since a settled/locked pool never
triggers `EntryConfirmationSheet` anyway.

### Phase 5 — Likes (single heart)

New migration `20260101000016_pool_likes.sql`: `pool_likes(id, pool_id,
user_id, created_at)` with a `unique_pool_like` unique index on `(pool_id,
user_id)`, plus a denormalized `pools.like_count integer default 0`
(mirrors `pool_options.entry_count`'s precedent — avoids a `count(*)` on
every card render). Both are maintained atomically by
`toggle_pool_like(p_pool_id, p_user_id)`, a `security definer` **plpgsql**
function (not `sql`, since it branches: delete-if-exists else insert, then
adjust the counter either direction, all in one round trip) that returns
the new liked boolean. `service_role`-only execute — even the toggle goes
through `lib/actions/likes.ts`'s `toggleLikeAction(poolId,
isCurrentlyLiked)` via the service role, not a direct RPC call from the
client. `pool_likes` itself grants `SELECT` to `authenticated` (RLS-scoped
to `user_id = auth.uid()`, unlike `follows`' no-grant-at-all) since the
spec only needs "did I like this" + the count, no public "who liked this"
list — `pools.like_count` is already readable via `pools`' existing
grant, no separate exposure needed.

`SocialPoolCardViewModel` gains `likeCount`/`isLikedByCurrentUser`,
populated in `lib/pools/fetch.ts` by the same batched-lookup shape as the
`entries`/`settlement_payouts` fetches (one `pool_likes` query scoped to
the viewer, keyed by `pool_id`). `components/pools/LikeButton.tsx` is a
client component with optimistic toggle (capture `wasLiked` before
flipping state, revert both the boolean and the count delta together on
error) — same `useTransition`-without-`useActionState` shape as
`FollowButton`. It replaces the inert heart placeholder in
`SocialPoolCard.tsx`'s footer row from Phase 1; the comment icon next to it
stays inert until Phase 6.

### Phase 6 — Comments

New migration `20260101000017_pool_comments.sql`: `pool_comments(id,
pool_id, user_id, body, created_at)` with `check (char_length(body)
between 1 and 500)`, plus a denormalized `pools.comment_count`. v1 scope is
flat (no nested replies), matching the plan.

**Deviation from the plan worth calling out**: the plan's draft RLS text
said comments should inherit the pool's `visibility` (`<> 'HIDDEN'`).
Implemented literally, that would have been a regression — `pools`' own
RLS policy (`members_can_read_published_pools`) only gates on `status !=
'DRAFT'`, never on `visibility`; `HIDDEN` is purely a Feed-listing filter,
and a `HIDDEN` pool's detail page is already directly readable by any
member (Decision 7, see `app/(app)/pool/[id]/page.tsx`'s header comment).
Gating comments on `visibility` would have made them *less* accessible
than the pool they're attached to. The shipped policy instead mirrors
`status != 'DRAFT'` (with a super-admin override), i.e. "readable wherever
the pool itself is."

`add_pool_comment(pool_id, user_id, body)` and
`delete_pool_comment(comment_id, user_id)` are both `security definer`
plpgsql, `service_role`-only execute. Deletion checks the caller owns the
comment or `is_super_admin()` inside the function itself, since there's no
DELETE grant to `authenticated` at all. No moderation system beyond that
self/admin-delete affordance and a tighter rate limit
(`lib/rate-limit/comments.ts`, 10/min — free text is a materially
different abuse surface than a toggle).

**Bug fixed in passing**: `getPoolCardViewModels(poolIds, userId)`'s new
`isLikedByCurrentUser` (Phase 5) was keyed off the same `userId` used to
look up *whose entries* a card represents — correct for Feed/My
Picks/pool-detail (viewer === owner there) but wrong on the Phase 4 public
`/profile/[username]` page, where `PredictionsTab` passes the *profile
owner's* id as `userId` while a *different* person is viewing. That made
the like button briefly show the profile owner's like state instead of
the actual viewer's. Fixed by adding an optional third `viewerId` param
(default `userId`) that only the interactive social bits — likes now,
anything future — key off; `currentUserEntry` deliberately still keys off
`userId`, since showing "what they picked" is the entire point of viewing
someone's predictions. `PredictionsTab` and `SocialPoolCard` both gained a
required `viewer: { id, isSuperAdmin }` prop threaded from each page's own
`requireUser()` call, needed anyway for `CommentSheet`'s
delete-affordance check (only the comment's author or a super admin sees
the trash icon — enforced again server-side in `delete_pool_comment`,
this is purely a UI affordance).

`components/pools/CommentSheet.tsx` mirrors
`EntryConfirmationSheet.tsx`'s focus-trapped bottom-sheet shape (same
Escape/backdrop-dismiss/Tab-cycling effect). It lazy-loads the comment
list on open via `getPoolCommentsAction` (a plain read through the
RLS-respecting client, not the service role — comments are already
readable per the policy above) rather than being pre-fetched into every
card's view-model, since most cards' sheets are never opened.

### Phase 7 — Leaderboard / Rankings

Terminology: the number shown is a **count of correct predictions**, not
points.

New migration `20260101000018_leaderboard.sql`: `user_profiles` gains
`correct_predictions_count bigint`, `current_streak integer`, `best_streak
integer`, all defaulting to 0. New `correct_prediction_log(id, user_id,
pool_id, settlement_id, created_at)` — one row per `WON` entry at
settlement time, the only thing that makes weekly/monthly ranges possible
(`count(*) where created_at >= range_start`) without scanning
`entries`/`settlements`; all-time reads skip it entirely and use the
denormalized counters directly.

`confirm_pool_settlement` and `reverse_pool_settlement`
(`supabase/migrations/20260101000010_settlements.sql` and
`20260101000011_reversal_and_reporting.sql`) are both **re-created in
full** here — `create or replace function` replaces a plpgsql body
wholesale, there's no way to "patch in" a few lines, so this migration
carries forward their entire previous bodies verbatim plus the additions
below:

- `confirm_pool_settlement`: each newly-`WON` entry appends a
  `correct_prediction_log` row and increments
  `correct_predictions_count`/`current_streak`/`best_streak`
  (`greatest(best_streak, current_streak + 1)`, evaluated against the
  pre-increment row per normal SQL `UPDATE ... SET` semantics); every
  newly-`LOST` entry's user gets `current_streak` reset to `0`. Both are
  no-ops for `VOID`/`REFUNDED` entries, since those never reach this
  function at all — produced by `confirm_pool_refund` instead, correctly
  skipped rather than counted as a break, matching how `card-state.ts`
  already treats them as distinct from `WON`/`LOST`.
- `reverse_pool_settlement`: **this needed a genuine fix, not just
  parallel bookkeeping.** This function resets reversed entries back to
  `ACTIVE` and immediately re-settles (a fresh `settlements` row, later
  re-confirmed) — without undoing the original increments, a winner whose
  pick is *still* correct after the correction would get double-counted.
  So for every winner being clawed back: the matching
  `correct_prediction_log` row is deleted and
  `correct_predictions_count`/`current_streak` are decremented
  (floored at 0). Streak rollback is a documented best-effort — exact only
  when no other pool settled for that user between the original
  confirmation and its reversal, which holds in the overwhelming common
  case since reversal is a same-day admin operation; exact rollback would
  need a full per-settlement streak-delta history, judged disproportionate
  for this phase. `best_streak` is deliberately left untouched (a
  high-water mark, not worth clawing back).

`get_leaderboard(p_scope, p_range, p_caller_id)` — `security definer
stable`, granted to `authenticated` directly (unlike the service-role-only
RPCs elsewhere, this is a plain read same as `get_pool_totals`).
`p_scope`: `'global'` or `'following'` (caller plus everyone they follow,
via `follows`). `p_range`: `'all_time'` (orders by the denormalized
counter) or `'weekly'`/`'monthly'` (left-joins a `correct_prediction_log`
aggregate filtered by `date_trunc`). Both branches use `rank() over
(order by ... desc)` and cap at 100 rows — a ranking list was never meant
to show the entire user base.

`app/(app)/leaderboard/page.tsx` replaces the Phase 2 placeholder.
`leaderboard-filters.tsx` drives `?scope=&range=` the same URL-param way
`feed-filters.tsx` drives Feed's filters. `components/leaderboard/Podium.tsx`
renders the top 3 center-biggest-first (rank 1 gets `order-2`, flanked by
2/3) with gold/silver/bronze rank badges overlapping the avatar;
`RankedList.tsx` renders the rest, current viewer's row tinted with
`bg-accent-primary/10`. Both link each row to `/profile/[username]` when
the entry has one (leaderboard rows without a username, i.e. that player
never set one, render as plain unlinked text — consistent with Phase
9 Search being similarly username-gated). `StreakWidget.tsx` is a
connected-node progress bar (`Check` icons, filled up to `current_streak`,
capped display at 10 with a `+N` overflow label) ending in a 🔥 emoji when
active, plus a `best_streak` footnote — pure presentation over the two
integers already on `user_profiles`, no new data.

### Phase 8 — Stories row

New migration `20260101000019_stories.sql`: `user_profiles` gains
`stories_last_seen_at timestamptz` (nullable — null means "never
visited," treated by the app layer as "everything currently active counts
as new," not "show nothing"). One column per viewer, not a per-
`(viewer, followee)` pair, kept deliberately cheap per the plan.

"New activity" (v1, narrow on purpose): a followed user created a new
`ACTIVE` entry, or — if they're a `super_admin` — published a new
(non-`DRAFT`) pool, either one after the viewer's `stories_last_seen_at`.
`get_stories_row(p_viewer_id, p_since)` is `security definer stable`,
mirrors `get_pool_participants`'s reasoning exactly: entries aren't
broadly readable via RLS, so this goes through a function that only ever
surfaces *that someone did something*, never *what* — the pool-published
branch checks `created_at`, not `updated_at`, since a pool's `updated_at`
gets bumped by every later lifecycle transition (lock, settle, etc.), and
using it would re-flag a followed admin's already-old pool as "new" every
time it changes state. Both branches deliberately skip the possibility of
a pool created in `DRAFT` long ago and only published today — using
`created_at` under a non-`DRAFT` filter is the cheap, good-enough proxy
the plan asked for, not an exact "published_at" timestamp (which doesn't
exist and wasn't worth adding for this).

`app/(app)/feed/page.tsx` reads the viewer's *old*
`stories_last_seen_at` first, calls `get_stories_row` with it (falling
back to the Unix epoch when null), and only *then* overwrites the column
to `now()` via the service role (not covered by `user_profiles`' existing
self-update grant, same as every other system-maintained column there) —
ordering matters, since bumping the timestamp before reading would make
every visit look like there's nothing new. This is a deliberate
side-effecting read inside a Server Component's render, the same shape
Next.js apps commonly use for "viewing marks it seen," rather than a
separate click-triggered action like `markNotificationsReadAction`.

`components/feed/StoriesRow.tsx` renders a horizontal-scroll bubble row
above `FeedFilters`: a "Your turn" bubble first (reuses Phase 2's
`getNextUnenteredOpenPoolId`, called again here since it isn't threaded
through from the layout — cheap query, not worth plumbing), then one
purple-ringed avatar bubble per followed user with new activity, each
linking to `/profile/[username]` when they have one (same
has-a-username-or-render-unlinked convention as the leaderboard rows).

### Phase 9 — Search

The final phase of the redesign. No migration — v1 scope is plain
`display_name`/`username` search over the already-`select`-granted
`public_profiles` view, nothing else. Predictions/hashtag search is a
larger, separable follow-up explicitly out of scope here.

`app/(app)/search/page.tsx` runs two independent `.ilike()` queries (one
against `display_name`, one against `username`) and merges/dedupes the
results in JS, **not** a single `.or("display_name.ilike.%x%,username.ilike.%x%")`
call — `.or()` takes a raw PostgREST filter-expression string built by
interpolating the search term directly into it, so untrusted input
containing that syntax's own delimiters (`,`, `(`, `)`) could inject
additional filter clauses. `.ilike()`'s pattern argument is a normal bound
value with no such risk, so two safe calls plus a JS-side merge was
simpler and safer than trying to escape the `.or()` string correctly.

`search-input.tsx` drives `?q=` the same URL-param way
`feed-filters.tsx`/`leaderboard-filters.tsx` drive their filters, but debounced
(300ms `setTimeout`, cleared and reset on every keystroke) — unlike a
native `<select>`'s `onChange`, a raw text input firing a `router.push` per
keystroke would thrash navigation. Results link to `/profile/[username]`
when the match has one, otherwise render unlinked (same convention as
Phase 7/8's rows) — a `display_name` match without a `username` is
findable but not yet clickable, consistent with `/profile/[username]`
being the only routing key that exists.

This closes out the Instagram-style social feed redesign: Phase 1
(creator header + footer icons) → Phase 2 (nav + Create shortcut) → Phase 3
(My Picks as a Profile tab) → Phase 4 (follows + public profile) → Phase 5
(likes) → Phase 6 (comments) → Phase 7 (leaderboard/streaks) → Phase 8
(stories row) → Phase 9 (search). Every phase after the third added
exactly one migration + one server-action module + (where relevant) one
rate-limit wrapper + a view-model extension, and was verified against a
running local Supabase instance with its own integration tests before
moving to the next.

## Multi-platform share sheet (post-redesign)

`SharePoolButton.tsx` no longer goes straight to `navigator.share()`/
clipboard — it opens `components/pools/ShareSheet.tsx`, a bottom sheet
(same focus-trap shape as `EntryConfirmationSheet.tsx`/`CommentSheet.tsx`)
listing explicit platform targets: WhatsApp (`wa.me` intent), Facebook
(`sharer.php`), Email (`mailto:`), Instagram, Copy Link, plus a "More" tile
that defers to `navigator.share()` when the browser supports it (for
whatever else the OS offers — SMS, Telegram, AirDrop, etc.), hidden
otherwise. Brand icons are small inline SVGs (official glyphs, brand
colors) since `lucide-react` carries no logo icons by design.

Instagram has no web-share URL for arbitrary links (only native
app-to-app intents, and only for images) — its option copies the link and
shows an inline hint to paste it into a Story or DM, rather than silently
doing nothing or bouncing the user out of the app to no effect.

`copyLink()` wraps `navigator.clipboard.writeText` in a try/catch and
surfaces a real `role="alert"` error state on rejection (shown for both
the Instagram and Copy Link options) rather than failing silently —
clipboard-write can legitimately be denied (permissions-policy-restricted
embeds, an unfocused tab, older browsers), not just in this app's own
sandboxed dev-preview environment where it was caught during verification.

## What's stubbed, on purpose

- `provider_request_log` has no admin viewer UI yet (RLS-readable by
  super admins already) — add one if/when debugging sync behavior needs it.
- The Reports page has no date-range filtering or export — it's a
  point-in-time snapshot, intentionally, per Phase 6's proportionality
  decision. Add filters if real usage shows they're needed.
- CSP still allows `unsafe-inline` (see Security review below) — a known,
  accepted limitation, not an oversight.

## Security review (Phase 7)

Full pass over every table's RLS + grants, confirming the recurring
"policy without a matching `GRANT`" bug class (bit this codebase twice
before, per project memory) doesn't recur:

- Every RLS-enabled table has a matching `authenticated` grant **except**
  two, both deliberately grant-less:
  - **`rate_limits`**: reachable only through the `check_and_increment_rate_limit`
    `SECURITY DEFINER` function, never read/written directly by a client.
  - **`pool_options`**: reachable only through the `pool_options_public` view
    (which strips distribution data pre-entry per X.9) — the base table
    itself must never be queried directly by an authenticated client.
- All 15 `SECURITY DEFINER` functions pin `search_path = public` and
  `revoke all ... from public` (the one gap found —
  `create_wallet_for_new_profile()`, trigger-only and therefore low-risk
  regardless — closed in `20260101000012_hardening.sql`).
- Append-only tables (`audit_logs`, `wallet_transactions`) reject
  `UPDATE`/`DELETE` unconditionally, including for the service role.
- Rate limiting now covers all three surfaces spec §19 names: login,
  entry submission, and invitation-link lookup.
- Security headers (CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options: DENY`) were already fully in place from an earlier
  phase — no changes needed here.
- **Resolved**: `style-src` no longer blanket-allows `unsafe-inline`. It's
  split into `style-src-elem 'self'` (blocks an injected `<style>`/`<link>`
  — the real CSS-exfiltration vector) and `style-src-attr 'unsafe-inline'`
  (keeps the two legitimate dynamic `style={{}}` usages — the drag slider
  and the pool distribution bar — working, since there's no nonce mechanism
  for continuously-variable inline style attributes short of a CSSOM
  rewrite). Browsers that don't understand the split fall back to the
  original `style-src`, so there's no regression.

## Pool template registry (Phase 1: fixture-score templates)

A data-driven registry replaces the old pattern of hardcoding a new
template end-to-end (SQL grading branch + `templates.ts` branch + Zod
branch + wizard UI branch + notices branch) for every new pool type. Each
registry entry (`lib/pools/templates/types.ts`'s `PoolTemplate`) declares
its own `questionBuilder`, `requiredConfigFields`, `requiredDataSources`,
`availabilityCheck`, and `gradingRule` — a pure function from a
`FixtureDataBundle` + admin-entered config to a deterministic
`YES | NO | VOID | PENDING` result with an evidence trail. Never natural-
language interpretation; missing data (e.g. a `null` regulation score on a
technically-`COMPLETED` fixture) always yields `PENDING`, never an assumed
zero.

**One shared `pool_type`, not one per template.** Adding a Postgres enum
value needs its own migration (`ALTER TYPE ... ADD VALUE` can't run in the
transaction that creates the type), so a single new value,
`TEMPLATE_GRADED`, covers every registry template — which specific one is
identified by two new nullable `pools` columns, `template_id` (registry
key) and `template_config` (jsonb). All 11 Phase-1 templates
(`lib/pools/templates/match-result.ts` + `goals.ts`) are binary YES/NO, so
they reuse the same fixed `[Yes, No]` `pool_options` pair `COMBO` already
established — no `pool_options` schema change. The existing
`WHO_WILL_ADVANCE`/`REGULATION_RESULT`/`COMBO`/`CUSTOM` pool types and their
SQL-driven grading are completely untouched; the wizard's template step
shows them alongside registry cards purely as catalog metadata (name/
description), since their settlement path isn't a `gradingRule`.

**Settlement bridge reuses proven RPCs, adds no new money-movement SQL.**
`lib/pools/templates/grade.ts`'s `gradeTemplatePool(pool, fixtureRow)` is
the one place fixture status is checked (only `COMPLETED` triggers grading
— every anomaly status is still handled upstream, unmodified, by the
existing `processAwaitingResults`/`checkPoolResultNowAction` logic) — this
single check *is* the "centralized fixture-status normalizer"; no
individual `gradingRule` ever branches on status itself. On `YES`/`NO`, it
calls the same `prepare_pool_settlement_manual` RPC `CUSTOM`/`COMBO` already
use, then directly `UPDATE`s `settlements.winning_option_id`/
`pool_options.is_winning_option` — mirroring `gradeComboLegsAction`'s exact
pre-stamp pattern — using a new `winning_option_reason` value
(`TEMPLATE_GRADED`, distinct from a plain `MANUAL_ADMIN_OVERRIDE`) and
inserting one row into the new append-only `pool_grading_evidence` table
(reason + a structured `evidence` jsonb array). A super-admin still clicks
confirm (`TemplateSettlementReviewForm` → `confirmTemplateSettlementAction`,
mirroring `ComboSettlementReviewForm`) before any payout — grading and
payout stay separate. `pool_grading_evidence` deliberately has no FK on
`pool_id` (mirrors `audit_logs.entity_id`) so `delete_terminal_pool` never
needs to touch it — grading evidence survives a hard-deleted pool forever.
Idempotency: calling `gradeTemplatePool` twice for the same settlement is a
no-op past the first evidence row (checked before re-stamping), on top of
`prepare_pool_settlement_manual`'s own snapshot-version idempotency.

**Wizard UI** (`app/(admin)/admin/pools/new/pool-template-builder.tsx`)
gained category tabs (Match result / Goals / Combos) built from
`listByCategory()`; selecting a registry template dynamically renders its
`requiredConfigFields` (`TEAM_SIDE` radio of the fixture's actual team
names, or `INTEGER` with bounds) and shows the live `questionBuilder`
output as a read-only preview before financials, same pattern the legacy
cards already used.

**Scope**: only `DataSource: "FIXTURE"` is wired up this pass — all 11
templates grade purely from `fixtures` columns already synced today
(`regulation_home/away_score`, `halftime_home/away_score`), so **zero new
API-Football calls** were needed. `FIXTURE_EVENTS`/`FIXTURE_STATISTICS`/
`FIXTURE_PLAYERS`/`LINEUPS` are typed in `types.ts` now so later phases
(match events, statistics, player props, the structured/manual custom-prop
builders, and a COMBO rebuild onto this same registry) can slot in without
another architecture change — none of that is implemented yet.

## Analytics (post-Phase-7)

Two pages share one foundation (`lib/analytics/types.ts`, `date-ranges.ts`,
`timezone.ts`, `metrics.ts`'s `buildMetric`, `streaks.ts`, `format.ts`, and
the `components/analytics/*` chart components built on `recharts`):

- **`/graphs`** (`requireUser()`) — a player's own performance. Every RPC
  (`get_user_analytics_overview`, `get_user_financial_overview`,
  `get_user_category_performance`, `get_user_competition_performance`,
  `get_user_monthly_activity`, `get_user_cumulative_pnl`,
  `get_user_bankroll_balance`, `get_user_entry_history`) reads `auth.uid()`
  internally — no parameter ever selects whose data comes back — so
  they're granted to `authenticated`. Activity metrics (pools entered,
  category/competition breakdowns) are entry-dated; financial metrics (net
  result, realized ROI) are realization-dated by `settlements.created_at`,
  never mixed — see `20260101000071_analytics_financial_rewrite.sql`.
- **`/admin/analytics`** (`requireSuperAdmin()`) — the same shape,
  platform-wide instead of self-scoped. `lib/analytics/adminAnalyticsService.ts`
  calls a parallel set of `get_platform_*` functions
  (`20260101000074_platform_analytics_functions.sql`) that mirror the
  `get_user_*` definitions exactly minus the `user_id = auth.uid()`
  filter, plus `get_platform_top_users` (a per-user leaderboard, no
  per-user equivalent needed). These are granted to `service_role` only —
  never `authenticated` — since they return every user's financial data;
  enforcement is "only `createAdminClient()` can call it," matching
  `pool_options`/`delete_terminal_pool`'s lockdown pattern, not an
  internal role check. `/admin/reports` (current-state operational
  reporting: house revenue, pools-by-status, job health) is untouched —
  `/admin/analytics`'s job is trends over time and the top-users table,
  which Reports doesn't have.

An `admin_hierarchy` schema (`user_profiles.parent_admin_id`,
`get_branch_member_ids()`, `20260101000063`/`20260101000066`/
`20260101000068`) exists for a future "admin sees only their own branch"
scoping, but is currently unused by any query — there's exactly one
`super_admin` today and no real branch to scope against yet, so
`/admin/analytics` deliberately stays platform-wide rather than wiring
untested cross-user RLS for a capability nobody can exercise. Wire it up
when there's a second admin and a real need to restrict what they see.

## Local development

```bash
corepack pnpm install          # or: pnpm install, once pnpm is globally available
pnpm supabase:start            # requires Docker Desktop; applies migrations
cp .env.example .env.local      # fill in the keys `supabase start` prints
pnpm create-super-admin --email you@example.com --password 'xxxx' --name "Admin"
pnpm seed                      # optional — demo players + pools in every status
pnpm dev
```

Testing:

```bash
pnpm test              # unit — no live Supabase needed
pnpm test:integration   # RLS + wallet + fixtures + pools/entries + settlement + reversal checks — needs `pnpm supabase:start` first
pnpm test:e2e           # Playwright — needs local Supabase + SUPABASE_SERVICE_ROLE_KEY
```

`pnpm test:integration` includes the wallet concurrency test spec §23 calls
out as the gate before Phase 4 pool features begin — it never gets weaker as
new tables reference `apply_wallet_transaction`, so re-run it after any
change that touches wallet locking. `tests/integration/pools.test.ts` extends
this same rigor to entries: concurrent entry attempts for one user/pool
resolve to exactly one entry and one debit, an entry racing the lock time
is rejected deterministically, and the `pool_options_public` privacy view
actually hides/reveals distribution data at the right moments (not just in
theory). `tests/integration/settlements.test.ts` covers both settlement
interpretations (regulation score vs. penalties), the manual-verification
fallback, stale-snapshot/duplicate-confirmation rejection, both §16.8
proposed-refund flows, below-minimum auto-cancellation, an X.7 anomaly void
that's idempotent across repeated cron passes, and RLS on
`settlement_payouts`/`notifications`. `tests/integration/reversal.test.ts`
covers the happy path (winner + house debited, old settlement marked
reversed, pool lands back on `READY_FOR_REVIEW` with an incremented
`grading_version`, re-confirming settles it correctly a second time), the
blocked path (a winner's balance can't absorb the clawback → `REVERSAL_
FAILED_MANUAL_REVIEW` with a correct per-winner shortfall report and zero
wallet writes), a successful retry after the admin tops the winner back up,
the abort path (back to `SETTLED`, zero financial effect), and that
reversing a pool a second time after it's already moved on to
`READY_FOR_REVIEW` is rejected rather than double-debiting.

The `ApiFootballProvider` adapter test (`tests/unit/api-football-provider.test.ts`)
mocks `fetch` and runs in the default unit suite — no API key needed to
verify request construction / response mapping. Live import and sync
(`API_FOOTBALL_ENABLED=true` + a real `API_FOOTBALL_KEY` in `.env.local`) is
a separate, manual verification step against the real API-Football service.
