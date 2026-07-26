# brohda. — Platform Report

A complete, current explanation of what brohda. is and how it works, from
product concept down to the database functions that move money. Unlike
[ARCHITECTURE.md](ARCHITECTURE.md) — which is a phase-by-phase build log kept
for engineering history — this document describes the platform as it stands
today, organized by topic rather than by when each piece was built.

---

## 1. What the platform is

brohda. is a **private, invite-only social prediction app** for small
friend groups, styled like a social feed (Instagram/Threads-ish) rather than
a sportsbook. There is no public sign-up — someone has to be invited.

The core loop:

1. A **super admin** (the pool "coordinator") creates a **pool** — a
   yes/no or multiple-choice question, usually tied to a real soccer
   fixture, with a fixed entry fee.
2. Players **pick one option** and pay the entry fee from their in-app
   wallet.
3. Once the pool locks (kickoff, or a scheduled time), no more picks are
   allowed.
4. Once the real-world result is known, the pool **settles**: everyone who
   picked correctly splits the total money wagered, minus a small
   transparent "platform fee" that funds the house. Everyone who picked
   wrong gets nothing.
5. If nothing can be graded fairly (match postponed, nobody picked the
   winning side, not enough people entered, etc.) the pool **voids or
   cancels** instead, and entries are refunded.

There are no real odds and no sportsbook-style exposure for the house — it's
pari-mutuel (everyone's money is pooled and redistributed), and the house
only ever earns the disclosed percentage fee.

Layered on top of that betting mechanic is a full social product: follows,
likes, comments (with one level of replies), a leaderboard/streak system, a
stories row, search, and an Instagram-style feed and profile.

---

## 2. Tech stack

- **Next.js 16** (App Router, Server Components + Server Actions, Turbopack),
  deployed to Vercel.
- **Supabase**: Postgres (with Row Level Security), Auth, Storage, and
  Realtime (used for live in-app updates). Local dev runs the full stack via
  the Supabase CLI + Docker; there's no ORM — plain, hand-written SQL
  migrations under `supabase/migrations/`, applied in numbered order.
- **TypeScript** everywhere; **Zod** validates every Server Action's input.
- **Tailwind CSS v4** (CSS-first `@theme` tokens) + **shadcn/ui** components.
- **Vitest** for unit tests (no live Supabase needed) and integration tests
  (against a real local Supabase instance); **Playwright** is configured for
  E2E but is not the primary test layer in practice.

Almost all of the platform's real logic — money movement, settlement math,
privacy rules — lives in **Postgres functions** (`SECURITY DEFINER`,
callable only by the service role), not in application code. Next.js Server
Actions are thin wrappers: they authenticate the caller, validate input, and
call one Postgres function that does the actual work atomically. This is a
deliberate, repeated pattern across the whole codebase (see §9).

---

## 3. Roles and access

Three roles, stored on `user_profiles.role`:

| Role | Can enter pools? | Can create/grade pools? | Can move money / change roles? |
|---|---|---|---|
| `player` | Yes | No | No |
| `admin` | **No** | Yes (create, publish, comment-moderate) | No |
| `super_admin` | **No** | Yes | Yes (the only role that can) |

- **Players** are the participants — they browse the feed, pick options,
  and everything social (follow, like, comment) is theirs to do.
- **`admin`** is a narrower staff role, added after the original
  admin/player split, for people who need to run the day-to-day pool
  operation (create pools, moderate comments, see the admin panel) without
  being trusted with money movement, account/role changes, or seeing raw
  wallet ledgers. Enforced by a second SQL helper,
  `is_admin_or_above(uid)`, deliberately kept separate from
  `is_super_admin(uid)` so every wallet/settlement/reversal/reporting gate
  keeps meaning exactly "super_admin, and only super_admin."
- **`super_admin`** is the full coordinator role: everything `admin` can do,
  plus wallet adjustments, settlement confirmation/reversal, user role and
  active-status changes, and pool/fixture deletion.
- **Both `admin` and `super_admin` are blocked from entering pools at all**
  — they coordinate and grade pools, they don't play in them. This is
  enforced both in the UI and at the database layer (`create_pool_entry`
  rejects non-player callers).

Auth is invite-only: an admin generates an `/invite/{token}` link (no
automated email send), the invitee sets a password on that page, and a
matching `user_profiles` row + wallet row is created automatically. The very
first super admin account is bootstrapped by a one-time CLI script
(`pnpm create-super-admin`) since invite-only registration has no path to
create the first user.

---

## 4. Core domain model

### Wallet

Every user (and one singleton `house` account) has a `wallet_balances` row.
All money movement — entry fees, payouts, refunds, admin adjustments,
reversal clawbacks — goes through exactly one Postgres function,
`apply_wallet_transaction`. It's `SECURITY DEFINER`, idempotent (an
`idempotency_key` means retrying a request never double-applies it), row-locks
the balance before checking/writing so concurrent debits against the same
wallet serialize correctly, and never lets a balance go negative. Every call
writes a permanent row to `wallet_transactions`, which is **append-only**:
`UPDATE`/`DELETE` are revoked even for the service role, by a trigger. This
table deliberately has **no foreign key** to `pools`/`entries`/`settlements`
— if it did, an append-only ledger row would make the pool/entry/settlement
it references permanently un-deletable, which conflicts with letting old
pools eventually be cleaned up (§8).

Players can request deposits/withdrawals (`/wallet`, reviewed by an admin on
`/admin/wallet-requests`); a super admin can also adjust a balance directly
from `/admin/users` for ad-hoc cases. The house's own wallet — which accrues
the platform fee on every settlement — is visible only to `super_admin`
accounts via `/wallet`, showing a dedicated revenue breakdown (fees,
rounding remainder, reversal debits).

### Fixtures

Real match data is synced from an external provider (API-Football) behind a
`SportsDataProvider` abstraction, so no application code ever touches the
provider's raw JSON shape directly. A cron job (`sync-fixtures`, runs every
minute) refreshes every non-terminal fixture at a cadence proportional to how
close it is to kickoff (live matches sync every run; matches days out sync
every 30 minutes). Admins import fixtures for pool creation from
`/admin/fixtures` by searching a league (a real, human-readable dropdown, not
a raw numeric league ID) + season + optional date, with bulk select/import.
Imported fixtures can be individually or bulk **hidden** from the
pool-creation picker (`hidden_from_pool_creation`) without being deleted —
useful for curating which matches admins are offered without losing the
underlying synced data — and can now be **deleted outright** once no pool
references them (see §8).

### Pools and entries

A **pool** is one question with 2+ **options**. A **entry** is one player's
paid pick on one option in one pool. Entry fee and platform fee (in basis
points) are frozen the moment the first entry is placed — a database trigger
(`enforce_pool_fee_immutability`) physically rejects any later change to
`entry_fee`, `house_fee_bps`, `question`, `pool_type`, or `title`, and only
allows the lock time to move *earlier*, never later. This is the hard
guarantee that a player's expected payout math can never be changed out from
under them after they've paid in.

Placing an entry (`create_pool_entry`) is one atomic Postgres function:
confirm the user is an active player, lock the pool row, confirm it's still
`OPEN` and not past its lock time, confirm the amount matches the frozen
entry fee, insert the entry, debit the wallet, and update the option's
running vote/amount totals — all in one transaction, so a wallet debit
failure (insufficient balance) rolls back the entry too, for free.

### Settlements

A **settlement** is a snapshot of one grading attempt for a pool: the
computed winner, the gross pool, fee, net prize pool, payout per winning
entry, and any rounding remainder. A pool can accumulate more than one
settlement row over its life (e.g. if a settlement is later reversed and
re-graded) — each carries a `grading_version` so it's always clear which one
is the currently-active one (`pools.snapshot_version` points to it).

---

## 5. The four pool types

- **`WHO_WILL_ADVANCE`** and **`REGULATION_RESULT`** — the original,
  fixture-backed types. Options are tied to real teams pulled from the
  fixture. The winning side is computed automatically from the fixture's
  score: `WHO_WILL_ADVANCE` prefers the penalty-shootout score if one
  exists, falling back to the final score; `REGULATION_RESULT` always uses
  the 90-minute score only, even if extra time/penalties were played.
- **`CUSTOM`** — a free-text question with free-text options and **no
  fixture at all** (`fixture_id` is nullable specifically to support this).
  Since there's no automatic score to check, a `CUSTOM` pool is always
  graded by a super admin picking the winning option by hand
  ("Grade Manually"). This same manual-grading path can also be used as an
  override on a fixture-backed pool, if an admin doesn't want to wait on or
  trust the automatic score check.
- **`COMBO`** — a fixed **Yes/No** pair whose winner is derived from N
  independently-graded **legs** (conditions), e.g. "Will Mbappé, Bellingham,
  and Dembélé each score at least 1 goal?" as three separate legs. An admin
  checks each leg met/not-met after the match; **"Yes" wins only if every
  leg is met**, otherwise "No" wins automatically. Each leg also carries an
  independent **Did Not Play (DNP)** flag: if a named player never actually
  took the pitch, that invalidates the entire premise of the bet regardless
  of how the other legs graded or which side anyone picked — DNP is an
  absolute override that voids and fully refunds the whole pool
  (`void_reason = COMBO_PLAYER_DID_NOT_PLAY`), distinct from grading that
  leg as simply "not met."

Every pool also has an optional `title` (a short context line, e.g. "2026
World Cup Semifinal, France – England") separate from `question` (the actual
bet), usable by both `CUSTOM` and `COMBO` pools where there's no fixture
header to display it under.

---

## 6. Pool lifecycle

### Database status (`pools.status`)

```
DRAFT → SCHEDULED → OPEN → LOCKED → AWAITING_RESULT → READY_FOR_REVIEW → SETTLED
                                                                        ↘ VOIDED
                                                                        ↘ CANCELLED
SETTLED ⇄ SETTLEMENT_REVERSED ⇄ REVERSAL_FAILED_MANUAL_REVIEW   (post-settlement recovery)
```

- **`DRAFT`** — being configured by an admin, not visible to players.
- **`OPEN`** — published, players can enter.
- **`LOCKED`** — no more entries. Triggered automatically once `locks_at`
  passes or the fixture kicks off early, by a once-a-minute cron job
  (`lock-pools`); an admin can also force-lock early at any time.
- **`AWAITING_RESULT`** — locked, waiting for the real-world result.
- **`READY_FOR_REVIEW`** — a grading attempt has been prepared and is
  waiting for an admin to confirm it (or resolve an ambiguous score by
  hand).
- **`SETTLED`** — money has moved; terminal (barring a reversal).
- **`VOIDED`** — refunded because of a match anomaly (postponed, abandoned,
  etc.) or a "nobody/everybody picked the winner" edge case.
- **`CANCELLED`** — refunded because the pool never reached its minimum
  entry count, or an admin manually cancelled it.
- **`SETTLEMENT_REVERSED`** / **`REVERSAL_FAILED_MANUAL_REVIEW`** — see §8.

### Client-facing status (`CardState`)

The database status alone isn't quite what a player should see — the lock
cron only runs once a minute, so a pool can sit at `OPEN` in the database for
up to a minute after its real lock time has passed. `deriveCardState()`
(`lib/pools/card-state.ts`) corrects for this and every other such race,
producing the actual state a card renders as: `OPEN_PRE_VOTE`,
`OPEN_POST_VOTE` (already entered), `LOCKED`, `LIVE`, `READY_FOR_REVIEW`,
`SETTLED_WON`, `SETTLED_LOST`, `VOIDED`, `POSTPONED_NOTICE`,
`CANCELLED_NOTICE`, `SUSPENDED_NOTICE`. This same effective-status logic is
reused for Feed's status filter, so filtering by "Open" never shows a pool
that's actually already locked.

---

## 7. Money mechanics

`gross_pool = sum of every active entry's amount`
`net_prize_pool = floor(gross_pool × (10000 − house_fee_bps) / 10000)`
`payout_per_winning_entry = floor(net_prize_pool / winning_entry_count)`

Division always floors — the leftover remainder from that floor division is
never redistributed to winners; it's swept into the house's own wallet as a
transparent "rounding remainder" credit, so every cent is always accounted
for between winners and the house.

**Settlement outcomes** (`settlements.outcome`):

- **`NORMAL`** — a real winning side exists with real entries on it. Winners
  are paid, the house gets its fee + the rounding remainder.
- **`NO_WINNING_ENTRIES_REFUND`** — nobody picked the side that actually
  won. Everyone gets a full refund, **no fee charged**.
- **`ALL_ENTRIES_WINNING_REFUND`** — everybody picked the side that won.
  Since there's no losing money to redistribute, it's simplest and fairest
  to just refund everyone in full, no fee.
- **`NO_WINNING_ENTRIES_FEE_RETAINED`** — a COMBO-specific outcome that used
  to retain the platform fee even on a full refund. **This is retired**:
  per a later product decision, a COMBO pool's "nobody picked correctly"
  case now goes through the same full-refund-no-fee path as every other
  pool type. The database function still exists (old settlement rows may
  still carry this outcome value historically) but the app no longer calls
  it.
- **Below-minimum-entries cancellation** — if a `LOCKED` pool never reached
  its configured minimum entry count, it's automatically routed to
  `CANCELLED` with a full refund, no admin action needed.

**COMBO's Did Not Play override** produces a full refund with
`void_reason = COMBO_PLAYER_DID_NOT_PLAY`, taking priority over every other
leg-grading outcome.

---

## 8. Settlement, reversal, and cleanup workflows

### Automatic settlement (fixture-backed pools)

A cron job (`process-results`, same once-a-minute cadence) watches every
`AWAITING_RESULT` pool. For a completed fixture it calls
`prepare_pool_settlement`, which determines the winning side from the
fixture's score. If the result is unambiguous, it lands on
`READY_FOR_REVIEW` with a proposed winner for a super admin to confirm
(`confirm_pool_settlement`) with one click. If it's ambiguous, the admin
picks the winner by hand on the same review screen. For match anomalies
(postponed, suspended, abandoned, etc.) the cron waits out a same-calendar-day
grace window (computed against the fixture venue's actual timezone) before
voiding automatically.

### Manual grading (CUSTOM pools, and as a fixture override)

`prepare_pool_settlement_manual` mirrors the automatic function but skips
the fixture lookup entirely and always requires the admin to pick the
winner by hand — used for every `CUSTOM` pool (which has no fixture to
check), and available as a super-admin override on any other pool type.

### COMBO grading

A single form lets the admin check each leg met/not-met (and flag DNP where
applicable) and settles the pool in one step — there's no separate
ambiguity-resolution screen, since the leg checkboxes alone fully determine
the winner.

### Undo grading (pre-confirmation only)

`undo_pool_grading` lets a super admin back a pool at `READY_FOR_REVIEW` out
to `LOCKED` if grading hasn't been confirmed yet — e.g. the wrong grading
path was used, or the admin wants to re-grade before committing. Since
nothing has been confirmed, no money has moved yet; this is a pure
state-machine revert, distinct from the reversal flow below.

### Reversal (undoing a confirmed settlement)

`reverse_pool_settlement` is the recovery path for a settlement that turns
out to have been wrong *after* money already moved. One admin-triggered,
all-or-nothing transaction:

1. Dry-runs whether every affected winner's wallet can absorb having their
   payout clawed back.
2. If **everyone** can absorb it: debits every winner and the house, resets
   the reversed entries back to `ACTIVE`, clears the stale winning-option
   flag, and immediately re-prepares a fresh settlement at a new grading
   version — landing back on `READY_FOR_REVIEW` for correct re-grading.
3. If **any** winner can't absorb it: nothing is written to any wallet at
   all. The pool moves to `REVERSAL_FAILED_MANUAL_REVIEW` with a full
   per-winner shortfall report, so an admin can top someone up out-of-band
   and retry.
4. `abort_pool_reversal` backs a `REVERSAL_FAILED_MANUAL_REVIEW` pool back to
   `SETTLED` with **zero** financial effect, if the admin decides not to
   pursue the reversal after all.

A reversal also rolls back the leaderboard: the affected winners'
`correct_predictions_count`/`current_streak` are decremented (their
`correct_prediction_log` row is removed), while `best_streak` is left
untouched — it's treated as a permanent historical high-water mark, never
clawed back.

### Deleting terminal pools and fixtures (super-admin cleanup)

A super admin can permanently **delete** any pool that's reached a terminal
state (`SETTLED`, `VOIDED`, or `CANCELLED`) and never had a real entry, or
that's terminal after having had real entries — the one thing that's
**never** allowed is deleting a pool that's still mid-lifecycle. This is one
atomic Postgres function, `delete_terminal_pool`:

- Rolls back the leaderboard for any `WON` entry being deleted (same
  decrement/`best_streak`-preserved precedent as a settlement reversal).
- Deletes the pool's settlement payouts, prediction-log rows, entries,
  settlements, combo legs, and options, in FK-safe order.
- Nulls out (rather than deletes) any notification that pointed at the pool,
  so a player's notification history survives even though the pool it
  referenced is gone.
- Leaves `wallet_transactions` completely alone — by design, those rows
  have no foreign key to the pool at all (see §4), so the permanent
  financial ledger is unaffected by a pool being cleaned up later.

The admin pools list (`/admin/pools`) supports both single-pool delete and a
bulk "select all settled/voided/cancelled → delete selected" flow with a
two-step confirmation. Fixture cleanup (`/admin/fixtures`) falls out of this
for free: a fixture's existing "zero pools attached" guard is naturally
satisfied once its pools become deletable, with no separate code path
needed.

---

## 9. Recurring architectural patterns worth knowing

- **Money and privacy-sensitive logic lives in Postgres, not TypeScript.**
  `apply_wallet_transaction`, `create_pool_entry`, `prepare_pool_settlement*`,
  `confirm_pool_settlement`/`confirm_pool_refund`, `reverse_pool_settlement`,
  and `delete_terminal_pool` are all `SECURITY DEFINER` functions, revoked
  from `PUBLIC` and granted only to `service_role`. Every one of them locks
  the rows it touches and does everything in one transaction, so a failure
  partway through rolls back cleanly instead of leaving half-applied state.
  Server Actions are thin callers, never a second implementation of the same
  logic.
- **Privacy is enforced at the query layer, not the response mapper.** The
  base `pool_options` table is grant-less — an authenticated client can never
  query it directly. `pool_options_public` is a view that nulls out
  `entry_count`/`total_entry_amount` per the pool's visibility rule and
  whether the viewer has an entry; that's the only thing the app ever reads.
  A handful of other narrow, single-purpose `SECURITY DEFINER` read
  functions (`get_pool_totals`, `get_pool_participants`, `get_followers`,
  `get_stories_row`, `get_leaderboard`, …) exist specifically to expose *only*
  the narrow slice of otherwise-ungranted data a feature actually needs,
  never the whole underlying table.
- **Append-only ledgers never get a foreign key from a mutable entity.**
  `wallet_transactions` and `audit_logs` reject `UPDATE`/`DELETE`
  unconditionally (even for the service role). Both stay unconstrained
  `uuid` columns pointing at pools/entries/settlements/users rather than
  real foreign keys, on purpose — a hard FK from an undeletable ledger would
  make everything it ever referenced undeletable too.
- **Idempotency keys everywhere money or a one-shot action is involved.**
  Every wallet-moving RPC call takes one, so retried/duplicate calls (double
  form submits, browser retries) never double-apply.

---

## 10. Social features

- **Follows** — simple follow/unfollow, no separate "friend" concept. The
  underlying `follows` table grants nothing directly to `authenticated`; it's
  read only through narrow functions (`is_following`, `get_follow_counts`,
  `get_followers`, `get_following`).
- **Likes** — a single heart per pool per user (`pool_likes`), with a
  denormalized `pools.like_count` kept in sync by one atomic toggle function.
- **Comments** — flat by default, with **one level of replies** (a reply
  can't itself be replied to, enforced in the insert function, not just by
  convention). A comment's author or any `admin`/`super_admin` can delete it;
  deleting a top-level comment cascades to its replies and the pool's
  `comment_count` is adjusted by the whole deleted thread's size.
- **Leaderboard** — ranks players (never staff) by **win rate**
  (correct ÷ total graded picks), with `correct_predictions_count` as the
  first tiebreaker and total picks as the second (so 10/10 outranks 1/1 at
  the same 100% rate); genuine ties share the same rank number, Olympic-style.
  Supports `global` vs `following` scope and `all_time`/`weekly`/`monthly`
  ranges — the weekly/monthly ranges read a dedicated append-style
  `correct_prediction_log` (one row per win, at settlement time) rather than
  scanning every entry. `current_streak`/`best_streak` are also tracked per
  player, with `best_streak` deliberately never decremented once achieved.
- **Stories row** — a narrow "who you follow did something new" indicator: a
  followed player made a new active pick, or a followed staff member
  published a new pool, since the viewer last checked.
- **Search** — plain display-name/username search over active profiles.
- **Notifications** — settlement/refund/reply notifications, each linking
  directly to the relevant pool or ledger entry; a header bell shows the
  unread count and a toast appears for new ones while the app is open.

Predictions themselves stay staff-authored only (`admin`/`super_admin`) —
there is no user-generated pool content or moderation system for pool
questions, only for comments.

---

## 11. Admin panel

Under `/admin/*`, gated by `requireAdminOrAbove()` (most pages) or
`requireSuperAdmin()` (money-moving pages specifically):

- **Users** — role/active-status management, wallet adjustments
  (super-admin only).
- **Invitations** — generate invite links.
- **Fixtures** — search/import from the sports data provider, hide/unhide
  from pool creation, delete unused ones.
- **Pools** — create, publish, force-lock, grade (automatic review,
  manual, or COMBO leg grading), cancel, reverse a settlement, and delete
  terminal pools (individually or in bulk).
- **Wallet (Ledger) Requests** — approve/reject player deposit/withdrawal
  requests.
- **Reports** — point-in-time snapshots: user counts, pools by status,
  items needing attention, house revenue, background-job health, and a
  wallet-transactions-by-type summary.
- **Audit Log** — every admin action (invites, role changes, wallet
  adjustments, pool lifecycle transitions, deletions) is written here via a
  single shared `writeAuditLog()` helper.

---

## 12. Background automation (cron)

Three Vercel Cron routes, all on Vercel Cron's 1-minute floor, each secured
by a bearer-token check against `CRON_SECRET` and each recording its own
run history (success/error + timing) to a `background_jobs` table so nothing
runs silently and unobserved:

- **`sync-fixtures`** — refreshes fixture data at a cadence proportional to
  how close each match is to kickoff.
- **`lock-pools`** — flips `OPEN → LOCKED` once `locks_at` passes or the
  fixture kicks off, and evaluates every newly-`LOCKED` pool against its
  minimum-entry requirement.
- **`process-results`** — advances `AWAITING_RESULT` pools once their
  fixture data is current: prepares settlement, processes an anomaly void,
  or waits.

---

## 13. A known gotcha worth remembering: PostgREST's `.in()` URL length limit

Any query using `.in(column, ids)` encodes every id directly into the
request URL. Once a list of ids gets long enough (in practice, once the
platform has accumulated several hundred historical pools), the URL exceeds
PostgREST's length limit and the request fails outright with a bare "URI too
long" error — one that several call sites across the codebase didn't check
for, so affected pages (the player Feed, the admin pools list) would
silently render as empty rather than error visibly. The fix is a shared
`fetchInChunks<Row>(ids, fetchChunk)` helper (`lib/pools/fetch.ts`) that
splits any id list into batches of 150 and merges the results — used at
every `.in()` call site that can plausibly see a large id list. Any new code
querying by a list of pool/entry/user ids that could grow large should use
this helper rather than calling `.in()` directly.

---

## 14. Testing approach

- **Unit tests** (`pnpm test`) — pure logic with no live database: money
  math, card-state derivation, settlement/reversal math mirrors, notice
  copy, validation schemas.
- **Integration tests** (`pnpm test:integration`) — run against a real local
  Supabase instance and exercise the actual SQL functions directly (wallet
  concurrency, entry creation races, settlement/reversal/cancellation flows,
  pool deletion's FK-safe cascade and leaderboard rollback, the
  `fetchInChunks` fix). Server Actions gated by `requireUser()`/
  `requireSuperAdmin()` need a real Next.js request/cookie context and can't
  be invoked directly from a Vitest process — those are verified live in the
  browser instead, while the integration tests target the underlying RPC
  each action calls.
- **`pnpm seed`** populates a freshly reset database with demo players and
  pools spanning every reachable status, using the platform's real RPCs, so
  seeded data obeys the exact same invariants real traffic does.

---

## 15. Intentionally out of scope / stubbed

- No public sign-up — invite-only by design.
- No pool content moderation beyond comments (predictions are always
  staff-authored).
- No CSV export or date-range filtering on the Reports page — a
  point-in-time snapshot, on purpose.
- CSP still allows `unsafe-inline` for styles — a documented, accepted
  limitation rather than an oversight.
