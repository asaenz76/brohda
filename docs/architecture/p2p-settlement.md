# P2P Settlement (Milestone R10)

## Goal and boundary

R10 takes a COMMITTED Monetary Position (R9) whose exact Market has reached
an authoritative final result and settles the economic agreement exactly
once: reservations resolve, the loser's stake is debited, the winner is
credited, Brohda's configurable P2P fee applies if one is set, a durable
settlement record is created, and the Position becomes terminal.
Settlement resolves the Position, not the social objects — Game, Post,
Market, Pick, Comment, and free Challenge are never mutated to make
settlement happen.

## Repository truth this design depends on

- **Market/Prediction grading is genuinely one-shot and immutable.**
  `lib/predictions/grading.ts`'s `runGradingJob()` only ever transitions a
  Prediction `PENDING -> GRADED`, exactly once, deriving the result from
  `computeSportsMarketOutcome()` (`lib/predictions/sports-resolution.ts`)
  against the Market's exact linked Game/fixture. No regrading or fixture-
  correction workflow exists anywhere in this codebase outside the
  separate legacy pools product — confirmed by direct search. This is the
  single guarantee R10's own settlement transaction relies on: once both
  of a Position's underlying Predictions are GRADED, their `result` can
  never silently change later.
- **No existing fee mechanism applies to P2P.** `pools.house_fee_bps` is a
  per-pool column belonging entirely to the separate legacy
  `pools`/`entries`/`settlements` betting-pool product — reusing it here
  would misrepresent provenance. There is no platform-wide fee anywhere
  else. This is why the fee decision below was made explicitly rather than
  assumed.
- **`close_own_account()` already refuses to close any account with a
  nonzero `wallet_balances.balance`.** Since `reserved_balance <= balance`
  is a schema-enforced invariant (R8), any account with an ACTIVE
  reservation of *any* purpose — including a still-COMMITTED Position's
  reservation — necessarily has `balance > 0`, so it already cannot be
  closed today. No new code was needed for this milestone's own "can a
  user with a pending financial obligation close their account?" question
  (§64) — the answer was already "no," for free.

## The P2P fee: an explicit product decision, not a guess

The product owner decided directly, in this session, that **Brohda takes
no P2P fee today**, but the configurable infrastructure for one must exist
so it can be turned on later without a schema change. This produced
`platform_settings.p2p_fee_bps` (basis points, 0-10000, default 0) —
fully wired through real settlement math, never a dead column. Reusing
the pool product's own fee column, or inventing a percentage without this
explicit decision, would both have violated the task's own instruction
not to guess at monetization.

**Fee basis**: a percentage of the *losing* stake (equivalently, since R9
is equal-stake-only, the winner's own gross profit). **Rounding**: floor
via integer division — `floor(stake * fee_bps / 10000)` — the exact same
convention `pools.house_fee_bps` already uses. **Range**: 0-10000 basis
points, matching `pools.house_fee_bps`'s own established constraint shape.

### Fee snapshot: an immutable term of the contract (§62)

A P2P fee is an economic term, and economic terms must be fixed no later
than commitment — otherwise a later admin fee-rate change could silently
alter an already-committed Position's payout. `monetary_positions.fee_bps`
is captured exactly once, inside `accept_monetary_proposal()` itself
(redefined in this milestone's own migration, unchanged in every other
respect from R9's version), reading `platform_settings.p2p_fee_bps` at
that exact moment. `settle_monetary_position()` always reads this
per-Position snapshot, **never** the live platform column. Verified
directly: `tests/integration/p2p-settlement.test.ts`'s "a later platform
fee-rate change never alters an already-committed Position's snapshot"
test commits a Position at 250 bps, then changes the platform rate to
9999 bps, and confirms the Position's own stored `fee_bps` is still 250.

## Two new wallet_transaction_type values, one reused

`p2p_position_win` (credit) and `p2p_position_loss` (debit) are new —
reusing `pool_payout_credit`/`pool_refund_credit` would misrepresent
provenance (a P2P win is not a pool payout). The **house** side
deliberately reuses the existing, already-generic `house_fee_credit`
value: its own label (`lib/wallet/transaction-copy.ts`: "Platform fee
collected") and its only consumer (`lib/reports/fetch.ts`'s
`getHouseRevenue()`, which sums purely by type+amount with no assumption
that `pool_id` is set) are both already pool-agnostic. Reusing it here
unifies platform-wide fee reporting instead of fragmenting it across a
redundant third value.

## Settlement is a first-class, separate object

`monetary_position_settlements` — not an extension of `monetary_positions`
itself beyond the minimal `settlement_status`/`settled_at`/`settlement_id`
fields R10 adds there. One row per Position, ever (`position_id` is
`UNIQUE`), fully immutable (no `UPDATE` grant exists anywhere — nothing in
this codebase ever mutates a settlement row after creation). It stores
everything §19 asks to be reconstructable: the exact Market result and
both Predictions' own results used (a permanent snapshot — §20), winner/
loser identity (`null` for VOID), stake, the fee actually applied, both
participants' reservation outcomes, and real FKs to every wallet
transaction it produced. `proposer_user_id`/`recipient_user_id` are
copied from the Position onto every settlement row (including VOID, where
`winner_user_id`/`loser_user_id` are both `null`) specifically so RLS can
check participancy uniformly without a cross-table join.

`monetary_positions` itself gains only `settlement_status`
(`COMMITTED -> SETTLED | VOIDED`), `settled_at`, and `settlement_id` — no
dispute/arbitration/pending-review vocabulary, matching the same
"add the column when the milestone that needs it arrives" discipline
already applied at every prior milestone boundary in this codebase.

## Winner/loser derivation: reading Market truth, not reimplementing it

`settle_monetary_position()` never recomputes a sports score. It locks
both of the Position's underlying `predictions` rows (deterministic
ascending-id order, reused verbatim from R7/R9) and requires both to be
`lifecycle_state = 'GRADED'` before doing anything else — otherwise it
returns `not_eligible`, a pure no-op, safe to retry once the Market
actually grades. Once both are graded, their own already-computed
`result` (`CORRECT`/`INCORRECT`/`VOID`) — produced by the *one* place a
sports result is ever computed (`computeSportsMarketOutcome`) — is read
directly:

- both `VOID` → the settlement is VOID (a cancelled Game, or an exact
  push on a SPREAD/TOTAL line — R1's own template rules, never
  reimplemented here).
- proposer `CORRECT` + recipient `INCORRECT` → `PROPOSER_WINS`.
- recipient `CORRECT` + proposer `INCORRECT` → `RECIPIENT_WINS`.
- any other combination is structurally unreachable under this
  codebase's own grading invariants (two opposing selections against one
  deterministic Market outcome cannot produce anything else) — fails
  closed to `invariant_violation` rather than guessing, leaving the
  Position completely untouched for manual review.

This is reading the Market's own authoritative result via the one path
that already computed it — not "settling from Prediction result alone" as
a substitute financial authority, since there is no other authority to
substitute for; it simply avoids a second, independently-reimplemented
scoring pass living in SQL.

## The atomic settlement transaction

`settle_monetary_position(p_position_id)` returns a `(position, settlement,
outcome)` composite — the same reasoning R5/R7/R9 already established for
any RPC with a "materialize a state change, then possibly report a non-
success outcome" hazard. Outcomes: `settled_win`, `settled_void`,
`already_settled` (idempotent retry — returns the existing settlement,
re-derives nothing), `not_eligible` (Market not yet graded — Position
untouched), `invariant_violation` (a detected financial-state anomaly —
Position untouched, surfaces via reconciliation instead).

Steps: lock the Position; if already terminal, return its existing
settlement immediately (retry-safe); lock both Picks and check both
GRADED; derive the outcome from their own `result`; lock both
`wallet_reservations` rows (deterministic ascending-id order) and verify
each is exactly what the Position claims — correct owner, correct amount,
still `ACTIVE` — never mutating anything if this fails (§38: a corrupt
financial state is surfaced, never silently "fixed" by releasing funds
anyway).

**VOID**: release both reservations via R8's own `release_reservation()`
(unmodified), transfer nothing, charge no fee, insert the settlement row,
mark the Position `VOIDED`.

**WIN**: release the *winner's own* reservation (§27 — their stake was
never at risk; a release restores availability without ever being treated
as new value) via `release_reservation()`; consume the *loser's*
reservation via R8's own `consume_reservation()` (unmodified except for
the two new enum type values) which atomically converts the hold into a
real, ledger-correlated debit; compute `fee_amount =
floor(stake * position.fee_bps / 10000)` from the Position's own
immutable snapshot; credit the winner `stake - fee_amount` via
`apply_wallet_transaction()` (unmodified) *only if* that amount is
positive (§14 — never fabricate a zero-amount transaction); credit the
house the fee *only if* it's positive; insert the settlement row; mark
the Position `SETTLED`.

### Combined lock hierarchy — explicit, and proven deadlock-free

**Position row → both Pick rows (ascending `predictions.id`) → both
`wallet_reservations` rows (ascending id) → whichever `wallet_balances`
rows `release_reservation()`/`consume_reservation()`/
`apply_wallet_transaction()` themselves lock internally.**

No function anywhere in this codebase ever locks two arbitrary
`wallet_reservations` rows together except this one, and R9's own
`idx_monetary_positions_proposer_reservation`/`..._recipient_reservation`
unique indexes guarantee no other Position ever shares either reservation
this function locks — so this ordering cannot deadlock against another
Position's own settlement, against R9's own `accept_monetary_proposal`/
`decline`/`withdraw` (Pick-lock ordering only, or a single reservation
lock, never two together), or against R8's own reserve/release/consume
(a single reservation, then a wallet balance, never two reservations at
once). Verified directly: `tests/integration/p2p-settlement.test.ts`'s
concurrency tests (duplicate-settlement retry on the same Position;
settlement while the loser has spent every other available cent;
multiple independent Positions on the same Pick) all resolve to exactly
one coherent outcome with correct final balances, no deadlocks observed.

## Idempotency

Every nested wallet-affecting call uses a deterministic idempotency key
derived from the Position id (`p2p_settlement:{positionId}[:loser-consume
| :winner-credit | :house-fee]`) — a retried settlement attempt after a
crash can never double-consume, double-credit, or double-charge, and the
top-level function's own `already_settled` short-circuit means a fully
successful prior run is never re-executed at all. Because the whole
function is one Postgres transaction, a crash mid-execution rolls back
everything atomically — there is no partially-committed state to reconcile
against; the only retry case that ever reaches already-committed state is
a genuinely completed prior run.

## Eligibility, and every no-op path

Settlement is a safe no-op — never a guess — whenever: the Market hasn't
graded yet (`not_eligible`); the Game is postponed (fixture never reaches
`COMPLETED`, so grading itself never runs, so this is the same
`not_eligible` path — no special-casing needed); only one of the two
Picks has graded so far (also `not_eligible`); or the Position is already
terminal (`already_settled`). A cancelled Game or an exact push both
resolve through the *ordinary* VOID path above, with zero P2P-specific
sports logic — `computeSportsMarketOutcome`'s own existing rules already
produce `VOID` for both cases, and grading already propagates that to
both Predictions uniformly.

## Corrections and reversal: explicitly deferred, not engineered around

No fixture-correction or Prediction-regrading workflow exists in this
codebase today (confirmed by direct search), so the hazard §21/§73 warns
about — a settlement built on a result that later silently changes — is
not currently reachable. If a future milestone adds regrading, it will
need its own explicit interaction with already-settled Positions;
inventing that interaction now, against a workflow that doesn't exist,
would be exactly the kind of premature engineering this codebase's own
conventions avoid. Likewise, no automatic post-settlement reversal
mechanism was built — R8's own pool-settlement reversal was audited for
*pattern* only, never reused as P2P reversal, per the task's own explicit
instruction; a P2P reversal workflow (unwinding a winner's already-spent
credit, in particular) is a separate, high-risk piece of design this
milestone does not need to launch without.

## Feature gate: never traps existing funds

`settle_monetary_position()` never checks `monetary_p2p_enabled` at all —
by design, not by oversight. Disabling the flag blocks *new* proposals and
*new* acceptances (both gated inside `propose_money()`/
`accept_monetary_proposal()`), but an already-committed Position must
still be settleable regardless, or a kill switch would strand real funds
in limbo. Verified directly: `tests/integration/p2p-settlement.test.ts`'s
"settlement of an already-committed Position still works while
monetary_p2p_enabled is false" test disables the flag after commitment and
confirms settlement still succeeds.

## The settlement runner

`scripts/settle-monetary-positions.ts` mirrors `scripts/grade-
predictions.ts`'s own explicit precedent exactly: a manual/developer
entrypoint, deliberately **not** wired to any scheduler ("a future
milestone MAY choose to point a cron-compatible route at the same
function... that decision belongs to that milestone's own implementation
spec, not this one" — grading's own words, reused verbatim in this
script's header). It discovers a bounded batch of COMMITTED Positions
whose both Picks are already GRADED (`listSettlementEligiblePositionIds`
— read-only, never itself decides an outcome), settles each
independently, and fires the correct notification only after that specific
call's own commit succeeds. One Position's failure or `invariant_violation`
never aborts the batch or corrupts any other Position (§69) — each
`settleMonetaryPosition()` call is its own atomic transaction. Uses the
same `assertProductionWriteConfirmed` guard every other write-capable
script in this codebase already uses, since — unlike grading — this
script moves real wallet balances.

## Notifications

`lib/notifications/monetary-settlements.ts` — the *only* place in this
codebase that ever says "you won"/"you lost" about real money. Fired only
by the runner script, only after `settleMonetaryPosition()` has already
committed successfully (never speculatively, never before). A WIN
settlement notifies the winner and the loser separately (each their own
truthful half of the outcome); a VOID settlement notifies both
participants that their hold was released. R9's own proposal-lifecycle
notifications (`lib/notifications/monetary-proposals.ts`) deliberately
never say this — R9 never knew a result.

## UI: extending the existing row, not a new surface

Per the task's own "minimal UI, no broad finance dashboard" guidance,
settlement result is shown by extending `MonetaryProposalAction.tsx`'s
existing state machine with three new terminal states (`settled_win`/
`settled_loss`/`settled_void`), rendered in the *same* opposing-
participant row `components/predictions/MarketParticipants.tsx` already
draws — no new page, no second participant list. `MarketParticipants.tsx`
resolves every ACCEPTED proposal's Position (and, once terminal, its
settlement) via two batched queries covering every participant row at
once, not one query per row. Win/loss colors use this codebase's own
dedicated wallet-ledger-direction tokens, `text-credit`/`text-debit`
(`app/globals.css`) — deliberately *not* the legacy pools product's own
`pool-win`/`pool-loss` tokens (kept separate on purpose, per that file's
own comment), and *not* an invented `text-success`, since this palette
explicitly removed its old success-green token and never replaced it.
The existing Available/On-hold wallet display (R8) already reflects
settlement correctly with zero new code, since `reserved_balance` is
purpose-agnostic.

## Reconciliation (§39)

`lib/monetary/reconciliation.ts`'s `checkMonetaryConsistency()` (shared
with R9) gained the settlement-specific checks: a COMMITTED Position
whose both Picks are already graded but never settled (stuck — the runner
hasn't run, or a prior attempt reported `invariant_violation`); a
settlement row existing while the Position is still COMMITTED (should be
structurally impossible — both transition atomically); a terminal
Position with no settlement row; a settlement's stored fee not matching
`floor(stake * fee_bps / 10000)` for a WIN (and correctly always expecting
exactly `0` for VOID, regardless of whatever `fee_bps` happened to be
snapshotted — a real bug caught and fixed during this milestone's own
test-writing, see below); a winner-credit amount not matching
`stake - fee`; a missing ledger-transaction correlation on either side; a
reservation-outcome mismatch against what the settlement actually
recorded, cross-checked against the *live* `wallet_reservations` row
status too; a Market-id mismatch between a settlement and its Position;
and more than one settlement row per Position (structurally prevented by
a `UNIQUE` constraint, checked anyway for parity with this file's own
existing R9 checks). `pnpm check-monetary-consistency` runs it unchanged
from R9's own script.

### A real bug caught while writing this milestone's own tests

The first version of the fee-mismatch reconciliation check computed
`floor(stake * fee_bps / 10000)` unconditionally and compared it to the
settlement's stored `fee_amount` — but a VOID settlement's row *does*
preserve whatever `fee_bps` the Position had snapshotted (an accurate
historical record of what rate was in effect, purely for audit), while its
`fee_amount` is, correctly, always `0` (VOID transfers nothing). This
produced false anomalies against any VOID settlement created while a
nonzero platform fee was configured. Caught by the test suite itself
(`tests/integration/p2p-settlement.test.ts`'s own "Reconciliation" test),
root-caused, and fixed by special-casing VOID to always expect `0`.
Separately, that same debugging pass also caught a genuine test-file bug
of its own: the test file's `afterEach` deleted
`monetary_position_settlements` rows *before* the `monetary_positions`
rows whose `settlement_id` (a real FK) points at them, which silently
failed on the FK violation (the delete's own error was never checked) and
leaked settlement rows across tests — fixed by reordering the cleanup to
delete positions (or null their `settlement_id`) first.

## Security

`monetary_position_settlements` RLS mirrors R9's own conservative,
no-public-record-exception model exactly: participants (via
`proposer_user_id`/`recipient_user_id`, always populated even for VOID)
plus admin, forever — never the public-record exception R7 grants a
RESOLVED free Challenge. Grants: `select, insert` to `service_role` only
(no `update`, no `delete` — fully immutable once created), `select` to
`authenticated` (gated entirely by the RLS policy above). The RPC itself
is `service_role`-only, like every other privileged RPC in this codebase
— verified in `tests/integration/rpc-privilege-boundary.test.ts` and
`tests/integration/table-privilege-hygiene.test.ts`. Client input is
minimal by construction: `settle_monetary_position()` takes only a
`position_id` — winner, loser, Market result, fee, and payout are all
derived server-side; nothing resembling those is ever accepted as a
parameter.

## Hard-coding audit

### TRUE INVARIANTS
- Settlement always reads the exact Position's own Market/Pick snapshot,
  never a re-derived "current" Market.
- Winner/loser derivation is always server-side, from already-graded
  Prediction results — never a client claim.
- The winner's own stake is always released, never credited as new value.
- VOID always transfers nothing and charges no fee.
- Both reservations resolve exactly once per Position, ever.
- A feature-disabled `monetary_p2p_enabled` never blocks settlement of an
  already-committed Position.

### CONFIGURABLE PRODUCT POLICY
- `platform_settings.p2p_fee_bps` (0 today, by explicit product decision).
- Settlement notification copy (plain TypeScript strings, not hard-coded
  into SQL).

### CONFIGURABLE OPERATIONAL POLICY
- The settlement runner's own discovery batch size
  (`listSettlementEligiblePositionIds`'s `limit`, currently a plain
  function default — no product signal yet that this needs to be a
  platform_settings row, matching R9's own "don't invent a config knob
  nothing has asked for" discipline).

### FINANCIAL CONTRACT SNAPSHOT
- `monetary_positions.fee_bps` — the one term genuinely fixed at
  commitment, per §62.

### FINANCIAL STATE
- Every column on `monetary_position_settlements` — stake, fee amount,
  winner credit, reservation outcomes, transaction correlations.

### SPORTS/PROVIDER STATE
- Nothing new — settlement never reads fixture scores itself, only
  already-graded Prediction results.

### GENUINELY DEFERRED (documented, not guessed)
- No fixture-correction/regrading interaction, since no such workflow
  exists yet to interact with.
- No automatic P2P reversal.
- No min/max settlement batch size configuration.

## Explicitly not built in R10

No fixture-correction or Prediction-regrading interaction (none exists to
build against); no automatic P2P reversal; no dedicated admin settlement
dashboard (existing wallet Activity ledger, the reconciliation script, and
direct table access already provide the observability §57 asks for); no
cron wiring for either grading or settlement (mirrors grading's own
existing, deliberate precedent); no dispute/arbitration workflow; no
external USDT or other off-platform money movement of any kind —
settlement is purely an internal ledger operation, exactly like every
other financial primitive in this codebase.
