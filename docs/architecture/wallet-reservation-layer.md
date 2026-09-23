# Wallet Reservation Layer (Milestone R8)

**Status**: Implements `docs/BROHDA_2_0_MILESTONE_MAP.md` Milestone R8 in full. Records CURRENT STATE only. Extends the existing, canonical wallet/ledger system established well before Brohda 2.0 — no second wallet, no monetary Challenge/Position (R9's own concern; see `docs/architecture/call-bs-challenges.md` for the explicit boundary R7 already drew and this milestone does not cross).

## Existing balance semantics (verified before writing any code)

`wallet_balances.balance` (`bigint`, cents, `CHECK (balance >= 0)`) means **total owned balance** — confirmed directly by reading `apply_wallet_transaction()`'s own pre-R8 debit check, `balance - amount >= 0`, a pure ownership floor with no notion of "spendable minus commitments." That meaning is preserved **exactly unchanged** by this milestone. R0.5's findings were re-verified against current repository truth rather than assumed: `apply_wallet_transaction()` is the one mutation point for `wallet_balances` (row-locked `FOR UPDATE`, replay-safe by `idempotency_key`); no reservation/hold/pending-commitment concept existed anywhere; pool entry debits immediately (confirmed: `create_pool_entry` inserts the `entries` row and debits in the same transaction, no deferred state); a pending withdrawal request reserved **nothing** — submitting one only inserted a `wallet_requests` row, meaning a user could spend the same balance in a paid pool before an admin ever reviewed the withdrawal. Nothing contradicted R0.5; no STOP-and-report was warranted.

## Reserved / available: formula, not a second stored number

```
total     = wallet_balances.balance                (unchanged meaning)
reserved  = wallet_balances.reserved_balance        (new, §30 below)
available = total - reserved                        (always derived, never stored)
```

`available` has no column of its own anywhere — it can never itself drift out of sync with the two numbers that define it, by construction.

## Reservation source of truth: a deliberate hybrid (§30)

`wallet_reservations` rows are the canonical, permanent **audit** record of every hold — who, how much, why, when created, when it ended, and (once consumed) which ledger transaction it produced. `wallet_balances.reserved_balance` is a **materialized total**, kept in lock-step by the three RPCs below, never summed live from reservation rows on the hot path. This was a deliberate choice among the three models the task described, not a default: `apply_wallet_transaction()` already takes `SELECT ... FOR UPDATE` on the exact `wallet_balances` row it needs, so reading a plain column on that already-locked row costs nothing extra — a derived-sum model would need a second query and a second lock on every single debit, for no correctness benefit. `lib/wallet/reconciliation.ts`'s `checkWalletReservationConsistency()` independently proves the two never disagree (see Reconciliation below) rather than assuming the materialized total is always right.

## Lifecycle

`ACTIVE → RELEASED` or `ACTIVE → CONSUMED`, both terminal and mutually exclusive (`wallet_reservations_released_at_shape`/`consumed_at_shape`/`consumed_transaction_shape` CHECK constraints tie each terminal state to its own timestamp and, for CONSUMED, to a real correlated ledger transaction). No ambiguous boolean — status is its own enum, checked structurally. No partial reservation, no partial release, no partial consume: R8's own product need (a full withdrawal amount, and the expected shape of a future full Challenge stake) never demonstrated a reason for one, so the simplest safe lifecycle was kept.

## Reserve

`reserve_funds(userId, amount, purpose, idempotencyKey)` — the only client-meaningful inputs. Idempotency mirrors `apply_wallet_transaction()`'s own exact pattern: look up by `idempotency_key` first, replay if found — not a weaker, reservation-specific scheme. Locks the user's `wallet_balances` row `FOR UPDATE`, computes `available = balance - reserved_balance`, rejects (`insufficient_available_balance`) if the requested amount exceeds it, otherwise inserts the reservation row and increments `reserved_balance` in the same transaction. Plain exceptions, not a composite return — unlike accept/consume below, nothing is materialized before a possible rejection here, so there's no atomicity hazard to guard against.

## Release

`release_reservation(reservationId)` — `ACTIVE → RELEASED`, decrements `reserved_balance` by the reservation's amount, **never touches `balance`**. This is the one place a naive implementation could accidentally mint value (`balance += amount` would be wrong the instant `balance` already means total owned balance, not "spendable"); release only ever undoes the *hold*, never credits anything. Idempotent via status-guarded update: a second release call, or a release against an already-CONSUMED reservation, returns the current state (`already_released` / `already_consumed`) rather than double-restoring availability or erroring on a harmless retry.

## Consume

`consume_reservation(reservationId, walletTxnType, adminId, reason, idempotencyKey, destination?)` — converts the hold into a real debit, atomically, with the reserved-decrement and the debit happening in the *same* transaction on the *same* already-locked `wallet_balances` row, so there is no moment where the funds read as simultaneously available, reserved, and undebited. Concretely: `reserved_balance` is decremented by this reservation's own amount **first**, then `apply_wallet_transaction()` is called for the actual debit — by the time its own available check runs, this specific reservation's amount is no longer counted against it (correct: it's the exact amount about to become a real debit), while any *other* still-ACTIVE reservation on the same account remains fully protected. This is what makes the task's own §24 worked example hold, verified directly: consuming an 80 reservation and an unrelated 20 debit can both legitimately succeed from a 100 total, but an unrelated 30 debit cannot. Idempotent the same way release is (status-guarded); a retry against an already-CONSUMED reservation returns the *same* correlated `wallet_transaction`, never a second debit.

## Ledger relationship — deliberately not the same table

Reserve and release create **no** `wallet_transactions` row: a reservation never changes owned balance, so pretending it's a debit/credit would distort the ledger's own meaning purely to reuse a table. Consumption **does** change owned balance and goes through `apply_wallet_transaction()` — the existing canonical ledger primitive — producing a normal `wallet_transactions` row, durably correlated back via `wallet_reservations.consumed_transaction_id` (§44: "ACTIVE reservation X → consumed → debit transaction Y" is provable by a direct column read, not by grepping logs).

## Idempotency and lock ordering

Every mutation (`reserve_funds`/`release_reservation`/`consume_reservation`/the strengthened `apply_wallet_transaction`) is safe under retry — verified directly for reserve (duplicate key returns the same reservation, no double hold), release (second call is a no-op), and consume (second call returns the same debit, never a second one). Lock hierarchy, documented and verified deadlock-free: `reserve_funds` locks `wallet_balances` first (nothing else exists yet to lock — it's creating a brand-new row). `release_reservation`/`consume_reservation` lock the **existing reservation row first** (by its own primary key — cheap, unambiguous), then `wallet_balances` for that reservation's owner. No function ever needs both "some *other* reservation's row" and `wallet_balances` in a way that could conflict with this ordering, so two concurrent operations that share a resource always request it in the same relative order — proven directly by a real concurrent release-vs-consume race on one reservation (`tests/integration/wallet-reservations.test.ts`), not just reasoned about.

## Ordinary debits: one-line strengthening, not per-caller patching (§27)

`apply_wallet_transaction()`'s debit check changed from `new_balance < 0` to `new_balance < reserved_balance` — a strict superset of the old check (`reserved_balance` is always `0` until something actually reserves against an account, and *always* `0` forever for the house account, which nothing in this codebase ever reserves against), so this is byte-for-byte behaviorally identical to the pre-R8 check for every existing caller until a real `ACTIVE` reservation exists. The raised exception string stays the exact literal `insufficient_balance`, unchanged, since `lib/actions/entries.ts`/`wallet.ts`/`wallet-requests.ts` all match on that substring for their own copy — verified directly that every one of those callers' existing tests still passes unmodified. **No caller-type branching was added anywhere**: pool entry, the admin ad-hoc adjustment tool, and (were it ever used) `admin_adjustment_debit` all automatically respect available balance for free, with zero code changes to those call sites beyond two user-facing error strings updated for accuracy (see Admin mutation behavior below).

### The one deliberate, audited exception: `reverse_pool_settlement`

Settlement reversal claws back a payout that was credited in error — recovering money the user was never legitimately owed, not a competing new claim on funds they've chosen to set aside. Rather than silently carving this path out of the new invariant inside `apply_wallet_transaction()` itself (which the task's own §12 explicitly forbids — "do not hide it"), `reverse_pool_settlement()`'s own pre-existing dry-run pre-check (which already aborts the entire reversal to `REVERSAL_FAILED_MANUAL_REVIEW`, zero wallet writes, if any winner's balance can't absorb the clawback to zero) was extended to **also** check `balance - clawback >= reserved_balance` for every winner, failing the exact same safe way if not. This means `apply_wallet_transaction()`'s own check needed **zero** special cases for any transaction type — it is unconditionally "available-aware" for every `account_type = 'user'` debit — and the one place a legitimate conflict could arise is caught explicitly, by the caller that already had the right safety mechanism for exactly this shape of problem, verified directly with a real settled-pool-plus-active-reservation scenario (`tests/integration/wallet-reservations.test.ts`, "Reversal remains a deliberately trusted path" describe block) alongside a second test proving a non-conflicting reversal still succeeds byte-for-byte as before this milestone.

## Deposits

Unchanged: `apply_wallet_transaction()` credit path was never touched, and credits never interact with `reserved_balance` at all — a deposit increases `total` (and therefore `available`) without moving `reserved`, verified directly.

## Withdrawal request lifecycle — the gap R0.5/R8's own audit found, closed

Before this milestone: submitting a withdrawal request reserved nothing; the debit only happened at admin approval, checked against whatever balance happened to exist *then*. Now: `submitWalletRequestAction` reserves the full amount **before** inserting the `wallet_requests` row (§11's own worked example) — the request's own `id` is generated client-side-of-the-database so the row can carry a real `reservation_id` FK from the moment it's created, meaning a `wallet_requests` row is never recorded without its funds genuinely held. `approveWalletRequestAction` now **consumes** that exact reservation (via `consume_reservation`) rather than issuing a fresh, unrelated debit — there is no longer any "does the current balance still cover this" question to get wrong, because the funds were proven available and set aside at submission time. `rejectWalletRequestAction` **releases** the hold. Deposits are entirely unaffected by any of this — they only ever increase owned balance later, on approval, exactly as before.

**A real bug was caught and fixed during this milestone's own build**: the first implementation tried to correlate the reservation back to its not-yet-existing `wallet_requests` row via a real FK column on `wallet_reservations` itself (`wallet_request_id`), which cannot be satisfied — the reservation must exist *before* the request row that references it, so a reservation can never hold a valid FK to a request that doesn't exist yet at the moment it's inserted. Caught by live browser verification (submitting a real withdrawal through the actual UI, not just the SQL layer, failed with a generic error), root-caused via a direct Postgres foreign-key-violation reproduction, and fixed by removing the redundant reverse column entirely — the one-way correlation `wallet_requests.reservation_id` (child → reservation, populated only once both rows can coexist) is sufficient for every query this domain needs, in either direction. Re-verified end to end afterward: submit → reserve (Available/On-hold split renders correctly) → admin approve → consume (reservation `CONSUMED`, correlated `wallet_transactions` row, balance and `reserved_balance` both correct) — all through the real running application, not simulated.

## Fees / admin mutations

No dedicated "fee" debit path exists independent of `apply_wallet_transaction()` (house fees are credits to the house account, unaffected). The admin ad-hoc wallet-adjustment tool (`/admin/users`, `depositAction`/`withdrawAction`) automatically respects available balance now for free — verified directly (an ad-hoc debit that would dip into a user's own currently-held reservation is rejected; one that stays within available still succeeds identically to before). Its own error copy was updated from "would drive the balance below zero" to "would drive the *available* balance below zero," since the same `insufficient_balance` exception can now fire for either reason and the old wording was no longer accurate to what's actually being protected.

## Migration and existing data

Additive only (`supabase/migrations/20260101000155_wallet_reservations.sql`): `wallet_balances.reserved_balance` added `not null default 0`, `wallet_reservations` created fresh, `wallet_requests.reservation_id` added nullable. Proved directly against real local data, not assumed: every existing wallet balance is preserved byte-for-byte, and every one immediately reports `reserved = 0`, `available = total` (the pre-R8 balance) with zero reservation rows — confirmed against 853 real local user wallets before writing a single line of application code. No historical reservation was fabricated for any legacy transaction; reservations begin existing only from the moment this migration runs forward, exactly as the task requires.

## Reconciliation (§45)

`lib/wallet/reconciliation.ts`'s `checkWalletReservationConsistency()` (read-only, safe against any environment including production — `scripts/check-wallet-reservations.ts` exposes it as an operator command) checks: the materialized `reserved_balance` against the live sum of each user's `ACTIVE` reservation rows (the one thing that genuinely *isn't* schema-enforced — everything else below is defense in depth proving the constraints are doing their job); `reserved_balance` never exceeding `balance` or going negative; every reservation's amount positive; terminal timestamps matching their status; a `CONSUMED` reservation always carrying a real correlated transaction; no duplicate idempotency key. Not a dashboard — a deterministic, bounded, point-in-time integrity query.

## Security

| Concern | Enforcement |
|---|---|
| Reserve/release/consume | `reserve_funds`/`release_reservation`/`consume_reservation`, `service_role`-only execute grant — verified directly that no authenticated client can call any of the three |
| Reserve another user's funds | Impossible — the Server Action layer always passes the caller's own id (`requireUser()`-scoped for submission; `requireSuperAdmin()`-scoped for approval/rejection, which act on the request's own stored `user_id`, never a client-supplied one) |
| Read own reservations | RLS: own rows, or every row for a super_admin — same shape as `wallet_balances`' own two SELECT policies |
| Mutate `wallet_reservations` directly | No `authenticated` INSERT/UPDATE grant at all — verified directly, including that a direct client update attempting to force `CONSUMED` is rejected and the row is unchanged |
| Corrupt the reservation invariant via a trusted debit | `apply_wallet_transaction()`'s own strengthened check is unconditional for every `account_type='user'` debit; the one legitimate exception (`reverse_pool_settlement`) fails safe to manual review rather than silently violating it |

`wallet_reservations` was added to `table-privilege-hygiene.test.ts`; `reserve_funds`/`release_reservation`/`consume_reservation` were added to `rpc-privilege-boundary.test.ts`'s table-driven privilege regression.

## Hard-coding audit

### TRUE INVARIANTS
Reservation amount > 0; `ACTIVE` reduces availability; `RELEASE` never increases total owned balance; `CONSUME` debits exactly once; a terminal reservation can never return to `ACTIVE`; `RELEASED`/`CONSUMED` are mutually exclusive; total can never fall below active reserved amount (schema-enforced, `wallet_balances_reserved_not_exceeding_balance`); normal spending can never consume reserved funds; reservation owner and amount are immutable after creation (no `authenticated` write path exists at all); `wallet_balances.balance`'s own meaning (total owned) is unchanged.

### CONFIGURABLE PRODUCT POLICY
None introduced — R8 deliberately added no new product-policy knob (§56: accounting invariants are not mutable policy, and no genuinely new product decision like a reservation expiry existed to make configurable yet).

### CONFIGURABLE OPERATIONAL POLICY
None introduced for the same reason.

### FINANCIAL STATE
Reservation amount, status, purpose, timestamps, idempotency key, correlated transaction id; `wallet_balances.balance`/`reserved_balance`.

### EXTERNAL/PROVIDER STATE
None — this domain has no provider dependency.

## Future R9 integration boundary

R8 deliberately exposes only the generic primitive: `reserveFunds`/`releaseReservation`/`consumeReservation`/`getWalletBalanceSummary` in `lib/wallet/reservations.ts`, and the `wallet_reservation_purpose` enum with exactly one value (`withdrawal_request` — **not** a speculative `CALL_BS_MONEY` or similar, per the task's own explicit instruction not to hard-code an R9 concept here). A future R9 Monetary Challenge/Position adds its own new `wallet_reservation_purpose` enum value via its own additive migration (mirroring exactly how R6 added `notifications.post_id` and R7 added `notifications.challenge_id` rather than speculatively pre-building either) and calls the same three primitives this milestone already proved correct — no schema or function change to this layer should be required for that integration to exist.

## Explicitly not built in R8

No monetary Challenge, Position, payout, or P2P settlement of any kind. `challenges` (R7) was not modified — Call BS remains entirely free, and nothing in R8 references it. No new `platform_settings` toggle. No partial reservation/release/consume. No reservation-expiry scheduling (nothing in this milestone's actual shipped product surface demonstrated a need for one — a withdrawal-request reservation ends only via explicit admin approval or rejection, never a timeout).
