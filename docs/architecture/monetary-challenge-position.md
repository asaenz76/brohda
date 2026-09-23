# Monetary Challenge + Position (Milestone R9)

## Goal and boundary

R9 introduces the economic *agreement* layer on top of Picks (R5), free
Challenges (R7), and wallet reservations (R8): a monetary **proposal**
(negotiation/offer, direct P2P only) that, once accepted, produces a
committed **Position** (a durable bilateral economic contract). R9 stops
the instant both sides are economically committed. It does **not** own
payout, fee, or settlement — that is R10's responsibility. No escrow
account, no fee at acceptance, no payout calculation, and no
settlement/"you won" notification exist anywhere in this milestone.

## Proposal vs. Position: two separate tables, not one overloaded row

`monetary_proposals` is the negotiation/offer object — mutable status,
terminal timestamps, and (once accepted) a `position_id` pointer forward.
`monetary_positions` is the committed contract an acceptance produces —
fully immutable, no status column, no lifecycle beyond existing. A
Proposal's own row is retained after acceptance as the historical record of
the negotiation; the Position is the separate, durable economic fact. This
mirrors the task's own explicitly preferred model and avoids conflating
"here is an offer" with "here is a commitment" in one row shape.

## Free Challenge stays completely unpolluted by money

No stake/amount/currency/reservation/payout/fee column was ever added to
`challenges` (R7). A monetary proposal may optionally reference a free
Challenge it escalates (`monetary_proposals.source_challenge_id`, nullable,
real FK, no cascade), but the reverse never happens — `challenges` carries
no knowledge that money exists. Free Call BS remains a fully independent,
always-available mechanic; money is an optional escalation path layered on
top, never a replacement.

## Direct vs. escalated proposals

Both entry points share one RPC, `propose_money()`:

- **Direct**: `source_challenge_id` is `null`. The only precondition is two
  opposing, ungraded Picks on the same Market, before the effective
  cutoff.
- **Escalated**: `source_challenge_id` names an existing free Challenge.
  It must exist, be `ACCEPTED`, belong to the same Market, and name the
  *same two participants and the same two Picks* as this proposal —
  checked as **unordered sets** (`(A=x AND B=y) OR (A=y AND B=x)`), since
  either original party may be the one who escalates, not only the
  original challenger.

## Stake, currency, and equal-stake model

Integer cents only (`bigint`, `stake > 0`), never floating point. Equal-
stake model only — both sides risk the identical amount; no odds, no
spread, no asymmetric exposure. No invented min/max stake limits: per the
task's own Option B, only `amount > 0` and available-balance sufficiency
are enforced. This is a genuinely deferred product decision, not a
guessed number — documented here as an open gap, not silently resolved.

## Proposer funding: atomic reserve + create

The proposer must have the full stake available **before** the proposal
exists. `propose_money()` calls `reserve_funds()` (R8, `purpose =
'monetary_position'`, the one new reservation-purpose value this milestone
adds) as a nested call inside the same transaction as the `INSERT` into
`monetary_proposals` — if the reservation fails (`insufficient_available_
balance`), nothing is ever created. If the subsequent insert fails (the
`monetary_proposals_one_pending_pair` unique-index race), the
just-created reservation is explicitly released before re-raising —
`duplicate_pending_proposal` never leaves an orphaned hold behind.

## Recipient funding: never required up front, never auto-accepts

The recipient does not need any funds to *receive* a proposal — discovery
and creation are entirely wallet-balance-agnostic on that side. The
recipient may fund their wallet at any point while a proposal is PENDING;
`propose_money()`/the UI never re-checks or reacts to a wallet-balance
change on its own. Acceptance is the **only** thing that moves a proposal
forward — funding alone can never flip PENDING to ACCEPTED. Verified
directly: `tests/integration/monetary-challenge-position.test.ts`'s own
"funding the recipient's wallet never auto-accepts a pending proposal"
test deposits into the recipient's wallet mid-PENDING and asserts the
proposal is still PENDING with `positionId: null` afterward.

## Pending proposals never lock a Pick

Unlike acceptance (below), a merely-PENDING proposal does not touch
`predictions.locked_at`/`lock_reason` at all. Both sides may still freely
edit their Pick while a proposal is outstanding. If either Pick's
selection changes, or either Pick gets graded, before acceptance, the
proposal is rejected at acceptance time as `rejected_invalidated` (see
below) rather than being pre-emptively invalidated at edit time — the
edit itself is never blocked or specially handled.

## Lifecycle

`PENDING -> ACCEPTED | DECLINED | EXPIRED | WITHDRAWN`. All four terminal
states are final; none is ever revisited.

- **Accept** (`accept_monetary_proposal()`, recipient only): the core
  atomic transaction, below.
- **Decline** (`decline_monetary_proposal()`, recipient only): plain
  PENDING -> DECLINED, releasing the proposer's reservation via a nested
  `release_reservation()` call in the same transaction.
- **Withdraw** (`withdraw_monetary_proposal()`, proposer only): plain
  PENDING -> WITHDRAWN, same release mechanism. Implemented directly
  (not deferred, unlike R7's own free-Challenge-cancellation deferral) —
  R7's deferral was specifically justified by "no money at stake"; here
  real funds sit reserved for as long as the proposal is outstanding, so
  that justification does not carry over, and the task's own recommended
  default is to implement it now.
- **Expire**: not a standalone RPC or cron job. `accept_monetary_
  proposal()` itself transitions a proposal straight to EXPIRED (and
  releases the reservation) the moment an accept attempt discovers the
  cutoff has passed, the Market/fixture is gone, a concurrent CUTOFF lock
  landed first, or either Pick's selection/lifecycle state no longer
  matches the proposal's own snapshot. There is deliberately no separate
  background sweep — a PENDING proposal nobody ever tries to accept simply
  stays PENDING (with its reservation still ACTIVE) until someone does,
  exactly mirroring how R7 never invented an expiry sweep for Challenges
  either.

## The acceptance transaction (§31) — the core of R9

`accept_monetary_proposal(p_proposal_id, p_recipient_user_id)` returns a
`(proposal, position, outcome)` composite — the same reasoning as R5's
`set_pick()` and R7's `accept_call_bs()`: this function has "materialize a
state change (expire + release), then possibly report a non-success
outcome" paths, and a plain exception on those paths would roll the
materialization back. Outcomes: `accepted`, `not_pending`,
`rejected_cutoff`, `rejected_invalidated`, `proposer_reservation_invalid`,
`insufficient_recipient_balance`.

Steps, in order:

1. Lock the proposal row (`FOR UPDATE`) and verify it is still PENDING and
   addressed to this recipient.
2. Re-check `monetary_p2p_enabled` — acceptance itself creates a new
   economic commitment, so the feature gate covers it too, not only
   creation (a deliberate widening beyond R7's own narrower
   `call_bs_enabled`, which never gated `accept_call_bs()`).
3. Re-derive the Market/fixture and the effective cutoff (the same
   Pick-lock policy R5 already owns, reused rather than a new hard-coded
   value); a vanished Market or a passed cutoff EXPIRE-and-release rather
   than raising.
4. Lock both Pick rows in deterministic ascending-`predictions.id` order
   — R7's own `accept_call_bs()` ordering, reused verbatim.
5. Re-check for a concurrent CUTOFF lock that landed between step 3's
   check and step 4's lock acquisition (identical race-safety reasoning
   to `accept_call_bs()`).
6. Re-validate current Pick state against the proposal's own immutable
   snapshots — a Pick edit or grading since proposal creation
   invalidates the specific disagreement this proposal named
   (`rejected_invalidated`).
7. Re-verify the proposer's reservation is still exactly ACTIVE, the
   correct owner, and the correct amount. **Never recreated if missing or
   wrong** — that would hide accounting corruption; instead this returns
   `proposer_reservation_invalid` without mutating the proposal at all,
   leaving the anomaly for reconciliation/support to investigate.
8. Lock the recipient's `wallet_balances` row and verify `balance -
   reserved_balance >= stake`; report `insufficient_recipient_balance`
   otherwise.
9. Reserve the recipient's stake via a nested `reserve_funds()` call
   (`purpose = 'monetary_position'`) — its own internal row lock is a
   harmless re-acquisition of a lock this transaction already holds, so
   nothing can change between step 8's check and this reservation.
10. Lock both Picks with `lock_reason = 'MONETARY_POSITION_ACCEPTED'`,
    **only where `locked_at IS NULL`** — an already-locked Pick (from an
    earlier `CHALLENGE_ACCEPTED` or a different Position) keeps its
    original reason and timestamp untouched.
11. Insert the `monetary_positions` row.
12. Update the proposal to ACCEPTED with `position_id` set.
13. Return `(proposal, position, 'accepted')`.

## Combined lock hierarchy — explicit, and proven deadlock-free

**proposal row -> both Pick rows (ascending `predictions.id`) -> proposer's
`wallet_reservations` row (by its own PK) -> recipient's `wallet_balances`
row (via the nested `reserve_funds()` call's own lock).**

No function anywhere in this codebase ever needs the reverse of any pair
in this chain:

- Pick editing (`set_pick`) takes only a single Pick-row lock.
- Free Challenge acceptance (`accept_call_bs`) uses the same Pick
  ordering and never touches a wallet row.
- R8's own `reserve_funds`/`release_reservation`/`consume_reservation`
  lock a reservation row then a `wallet_balances` row, never a Pick row
  at all, and never the reverse of that pair.

This was not just reasoned about — it was empirically exercised via four
concurrency scenarios before any permanent test existed (now captured as
permanent `tests/integration/monetary-challenge-position.test.ts` cases):
accept-vs-duplicate-accept-retry (exactly one Position, verified via
`Promise.allSettled` on the same proposal), accept-vs-second-incoming-
proposal (an underfunded recipient can win at most one of two concurrent
proposals), accept-vs-decline (resolves to exactly one coherent final
state), and the acceptance-vs-Pick-edit/cutoff races already covered
inside the transaction itself (steps 5–6 above).

## Multiplicity: preserved for money exactly as R7 established it for free Challenges

A single Pick carries exactly one `lock_reason`/`locked_at` — whichever
cause happened first (`CUTOFF`, `CHALLENGE_ACCEPTED`, or now
`MONETARY_POSITION_ACCEPTED`) — and it is never overwritten by a later
cause. Subsequent accepted free Challenges **or** monetary Positions
against the *same* already-locked Pick are still fully supported: each
gets its own Challenge/Proposal/Position row, and each Position gets its
own distinct pair of reservations. Verified directly:
`tests/integration/monetary-challenge-position.test.ts`'s "preserves an
existing CHALLENGE_ACCEPTED lock rather than overwriting it" test accepts
a free Challenge first, then accepts an unrelated monetary proposal
against the same already-locked Pick, and asserts the Pick's
`lock_reason`/`locked_at` are byte-for-byte unchanged afterward.

## Why a new lock reason, not reuse of `CHALLENGE_ACCEPTED`

A *direct* monetary proposal (no underlying free Challenge) that locked a
Pick and reported `CHALLENGE_ACCEPTED` would itself create false
historical semantics — claiming a free Call BS caused a lock that money
actually caused. `MONETARY_POSITION_ACCEPTED` is a new, distinct,
auditable provenance value added to `predictions_lock_reason_check`
specifically so a Pick's lock history stays accurate regardless of which
mechanic (free or paid) actually caused it.

## Position: minimal, immutable, no invented lifecycle

`monetary_positions` carries: `proposal_id`, `market_id` (soft reference,
matching `predictions.market_id`/`challenges.market_id`), both
participant/Pick/selection-snapshot pairs, `stake`, both reservation ids
(each with its own unique index, so a reservation can never be shared
across two Positions), and `committed_at`. No `status` column, no
`settled_at`, nothing lifecycle-shaped. A Position's mere existence in the
table means COMMITTED — R10 will add whatever settlement vocabulary it
needs via its own additive migration when it arrives. This deliberately
mirrors the established "don't pre-guess the next milestone's exact
vocabulary" convention: R5's `CHALLENGE_ACCEPTED` pre-add was justified
*only* because R7's task named that exact upcoming value by name; R9 has
no equivalent instruction from R10, so nothing is pre-added here.

Grants on `monetary_positions` are `select, insert` only — no `update` —
because no code path anywhere ever updates a Position row after creation.

## Position independence: line movement, odds, and reschedule

A Position's stored snapshots (`proposer_selection_snapshot`,
`recipient_selection_snapshot`, `stake`) never change after creation,
regardless of what happens to the Market's live price or the underlying
Game's schedule afterward. Verified directly: `tests/integration/
monetary-challenge-position.test.ts`'s "is unaffected by Market line
movement" and "is unaffected by a Game reschedule" tests mutate
`markets.yes_price`/`no_price` and `fixtures.scheduled_start_utc` after a
Position is committed, then re-fetch the Position and assert every stored
field is unchanged.

## Reservations after commitment: both remain ACTIVE, forever, in R9

Once a Position is committed, **both** the proposer's and the recipient's
reservations stay `ACTIVE`. R9 never calls `consume_reservation()` or
`release_reservation()` against either one — only a future R10 settlement
step may do that. This is the exact R9/R10 boundary the task calls out
explicitly, and it is the one invariant every other design decision in
this milestone had to respect: nothing here computes a winner, nothing
here moves money out of a reservation, nothing here decides a payout.

### Audit: can R8's own generic `release_reservation()` be misused against a committed Position?

Checked directly. `release_reservation()` is a generic primitive that
transitions any `ACTIVE` reservation it's given straight to `RELEASED`
with no awareness of *why* that reservation exists — it has no knowledge
of `monetary_positions` at all. Nothing in R9's own code path ever calls
it against a Position's reservation (only against a still-PENDING
proposal's proposer reservation, on decline/withdraw/expire). The
function itself remains `service_role`-only (R8's own grant, unchanged),
so no client-side call path exists either. The residual risk is a future
*server-side* caller mistakenly passing a Position's reservation id to
`release_reservation()` directly instead of going through a not-yet-built
R10 settlement primitive — `checkMonetaryConsistency()`'s own
`position_reservation_not_active` check (below) exists specifically to
catch that class of mistake after the fact, since the database schema
itself cannot forbid it structurally without R8's reservation primitive
becoming aware of every future consumer, which would be exactly the kind
of premature coupling this codebase's own conventions avoid.

## Privacy: more conservative than R7's free Challenge, deliberately

Free, RESOLVED Challenges are readable by any authenticated user as a
public social record (R7's own explicit "keep BS talk visible" design).
Money does not get that exception. RLS on both `monetary_proposals` and
`monetary_positions` is participants + admin only, in every status,
forever — there is no public-record carve-out for an ACCEPTED proposal or
a committed Position, matching the task's own explicit instruction that
money needs stricter privacy than free social banter. Verified directly:
`tests/integration/monetary-challenge-position.test.ts`'s security suite
confirms an outsider cannot read a proposal or Position even after
acceptance, and `anon` cannot read either table at all.

## Grants and mutation surface

Both tables: `revoke all ... from public, anon, authenticated`, `grant
select/insert ... to service_role` (no `update` grant on either table —
`monetary_proposals`' own status transitions all go through its four RPCs,
which run as `security definer`, not through a raw client-side `UPDATE`).
The four RPCs (`propose_money`, `accept_monetary_proposal`,
`decline_monetary_proposal`, `withdraw_monetary_proposal`) are each
`revoke all ... grant execute ... to service_role` only — no authenticated
client can call any of them directly, exactly like every other privileged
RPC in this codebase (see `tests/integration/rpc-privilege-boundary.test.ts`,
which now includes all four).

## FK conservatism (§76): financial history over cascade convenience

`monetary_proposals`/`monetary_positions`'s user references are real FKs
to `user_profiles` **without** `on delete cascade` — a deliberate
divergence from `challenges.challenger_user_id on delete cascade`.
Verified directly by reading `close_own_account()`'s live definition: it
never hard-deletes a `user_profiles` row, only soft-scrubs
(`is_active = false` plus nulled PII) forever. The cascade-vs-restrict
choice therefore costs nothing in current practice, but a plain
(restrict-by-default) FK is the conservative choice for financial history,
exactly matching the task's own explicit R9-specific instruction. Prediction/
reservation/Challenge references are ordinary real FKs — none of those rows
are ever deleted by any code path. `market_id` stays a soft reference (no
FK) throughout, matching `predictions.market_id`/`challenges.market_id`.

## Idempotency and crash safety

`propose_money()` takes a client-generated `p_idempotency_key`; a retry
with the same key returns the existing row rather than creating a second
proposal or a second reservation (checked first, before any other work).
The nested `reserve_funds()` call for the proposer's own stake uses a
derived key (`{idempotency_key}:proposer-reserve`) so a crash between the
reservation and the `INSERT` cannot silently double-reserve on retry. The
recipient's own reservation during acceptance is similarly keyed off the
proposal's own idempotency key
(`{proposal.idempotency_key}:recipient-reserve`) — a retried
`accept_monetary_proposal()` call after a crash can never create a second
recipient reservation for the same acceptance. `decline_monetary_proposal`/
`withdraw_monetary_proposal` are naturally idempotent by construction: both
raise `not_pending` on a second call rather than double-releasing anything.

## Feature gate

`platform_settings.monetary_p2p_enabled` (boolean, default `false`) — a
genuine kill switch, off until explicitly turned on, mirroring
`call_bs_enabled`'s own convention. Checked live inside **both**
`propose_money()` and `accept_monetary_proposal()` (a deliberate widening
beyond R7's own narrower gate, since acceptance itself creates a new
economic commitment). Disabling the flag only blocks *new* proposals and
*new* acceptances — it never touches an already-committed Position or an
already-PENDING proposal's reservation; those remain exactly as they were
until acted on by whichever RPC is actually invoked next (which will
itself reject with `monetary_p2p_disabled` for creation/acceptance, but a
still-PENDING proposal can still be declined or withdrawn while the
feature is off, since those two RPCs never check the flag — they only ever
*release* a hold, never create a new commitment).

## Rate limiting

`checkMonetaryProposalRateLimit()` (`lib/rate-limit/monetary-proposals.ts`)
reuses the same generic `checkRateLimit` primitive R6/R7 already
established, namespaced `monetary_proposal:${userId}`, window/cap read
live from `platform_settings.monetary_proposal_rate_limit_*` (new columns,
default 60s / 10 attempts). Protects proposal **creation** only — accept/
decline/withdraw are inherently self-limiting, since a user can only act
on a proposal that already exists and is already addressed to (or owned
by) them, mirroring R7's own reasoning for `call_bs`.

## Reconciliation (§72)

`lib/monetary/reconciliation.ts`'s `checkMonetaryConsistency()` — read-
only, no auto-repair, mirroring `lib/wallet/reconciliation.ts`'s own
shape exactly. Checks: a PENDING proposal without a matching ACTIVE
proposer reservation; a proposer reservation with the wrong owner or
amount; a terminal (declined/expired/withdrawn) proposal whose reservation
is still ACTIVE; an ACCEPTED proposal with no matching Position; a
Position whose proposer or recipient reservation doesn't exist, isn't
ACTIVE, has the wrong owner, or has the wrong amount; a reservation shared
across more than one Position; a Position with an identical
proposer/recipient identity or Pick; and a Position/proposal Market
mismatch. `pnpm check-monetary-consistency` runs it from the CLI, mirroring
`pnpm check-wallet-reservations`.

## Migration

`supabase/migrations/20260101000156_monetary_challenge_position.sql`:
adds `wallet_reservation_purpose` enum value `'monetary_position'`; widens
`predictions_lock_reason_check` to include `'MONETARY_POSITION_ACCEPTED'`;
creates `monetary_proposals` and `monetary_positions` (the latter's
`position_id` FK on the former is added via a separate `ALTER TABLE` after
`monetary_positions` exists, since an inline FK cannot reference a table
that doesn't exist yet regardless of `DEFERRABLE` — that clause was
considered and dropped once it became clear ordinary immediate checking
is correct here, since `accept_monetary_proposal()` always creates the
Position row before setting `position_id` on the already-existing
proposal); adds the three new `platform_settings` columns; adds
`notifications.monetary_proposal_id`; then the four RPCs.

## Hard-coding audit

### TRUE INVARIANTS
- Equal-stake model (no odds/spread) — a structural design choice, not a
  configurable value.
- Integer-cents currency representation.
- The Proposal/Position separation itself.
- Both reservations must remain ACTIVE after commitment (this is the
  R9/R10 boundary itself, not a policy).

### CONFIGURABLE PRODUCT POLICY
- `monetary_p2p_enabled` (platform_settings).
- `monetary_proposal_rate_limit_window_seconds` /
  `monetary_proposal_rate_limit_max_attempts` (platform_settings).
- Whether a proposer may withdraw a PENDING proposal (implemented as
  always-allowed here, per the task's own recommended default — not
  hard-coded against ever changing, just not made configurable yet since
  nothing asked for a toggle).

### CONFIGURABLE OPERATIONAL POLICY
- The monetary cutoff reuses `platform_settings.pick_lock_minutes_before_
  kickoff` — the existing Pick-lock policy, not a new hard-coded value.

### FINANCIAL STATE
- `stake`, both reservation ids, `committed_at` — all real financial
  facts, not configuration.

### SPORTS/PROVIDER STATE
- Fixture `scheduled_start_utc`/`internal_status` (read, never written,
  by both `propose_money()` and `accept_monetary_proposal()`).

### GENUINELY DEFERRED (not guessed)
- Minimum/maximum stake limits: no config exists; only `amount > 0` and
  available-balance sufficiency are enforced (Option B, per the task's
  own explicit offer). This is an intentional product gap, not an
  oversight.

## Future R10 integration boundary

R10 owns: result-based settlement, fee calculation, payout, a Position's
eventual `consume_reservation()`/`release_reservation()` calls (the first
time either reservation is ever touched after commitment), and any
"you won"/"you lost" notification. R10 will very likely need its own
additive migration to `monetary_positions` (a settlement status, a
settled-at timestamp, a winner/void outcome) — none of that vocabulary is
pre-guessed here, mirroring the same discipline this codebase has applied
at every prior milestone boundary.

## Explicitly not built in R9

No settlement, no fee, no payout, no winner determination, no escrow
account, no result-based notification, no min/max stake configuration, no
odds/spread/asymmetric-stake support, no cron-based proposal expiry sweep
(expiry only ever happens synchronously, at accept-attempt time), and no
UI redesign beyond what's needed to prove the flow (a stake composer,
pending/committed states, and a fund-your-wallet prompt, merged into the
existing `MarketParticipants` row rather than a second participant list —
see that component's own comment for why a separate `MonetaryParticipants`
component was tried first and reverted after it duplicated each
participant's identity text on the page).
