# Pick Editing + Locking (Milestone R5)

**Status**: Implements `docs/BROHDA_2_0_MILESTONE_MAP.md` Milestone R5 in full. Records CURRENT STATE only. See `docs/architecture/game-market-foundation.md` (R1) for the Game/Market layer this domain answers, and `docs/architecture/post-foundation.md`/`community-distribution.md` for the unaffected social layers above it.

## Terminology

The canonical Brohda 2.0 product term is **Pick**. The database/domain implementation remains `predictions`/`Prediction` — no destructive rename was performed (per this milestone's own instruction to avoid migration churn with no functional benefit). This document uses "Pick" and "Prediction" interchangeably.

## What changed

Before R5: a Prediction was write-once — created, then permanently immutable, with no update path anywhere in the codebase (verified, matching R0.5's own finding). After R5: a Pick can be freely changed (YES ↔ NO) until a configurable cutoff before the Game's kickoff, at which point it permanently locks. The final selection at lock time — and only that selection — is the record grading acts on.

## Canonical identity

`predictions.(user_id, market_id)` is now a real, unique database constraint (`predictions_one_per_user_market`) — R0.5's own finding that this was previously enforced only at the application level is now closed. Pick remains strictly Market-scoped: never attached to Post, never to Community. A user sees the exact same Pick regardless of which Community or personalized-feed context led them to the Post — Post/Community context never duplicates or forks Pick identity (verified directly: R4's own distribution/personalization layer never references `predictions` at all).

## Mutation architecture: `set_pick`

A single atomic, concurrency-safe SQL function (`set_pick`, `supabase/migrations/20260101000152_pick_editing_and_locking.sql`) is now the *only* way any Pick is created or changed — `lib/predictions/repository.ts`'s pre-R5 `createPrediction` (a plain idempotent insert with no editing, no locking) was removed as dead code once `lib/actions/predictions.ts` switched over; it had zero remaining callers and would have thrown an unhandled conflict against the new uniqueness constraint if ever called twice for the same user+Market.

`set_pick` is an RPC, not a plain table write, for one reason: it needs `SELECT ... FOR UPDATE` row-locking plus an *authoritative, in-transaction* re-read of the Game's live kickoff/status — the same class of guarantee `apply_wallet_transaction`/`create_pool_entry` already rely on this exact primitive for. A multi-round-trip JS implementation cannot give the same race-safety guarantee against a cutoff boundary or a future concurrent Challenge-acceptance operation.

**Return contract**: `set_pick` returns `(prediction, outcome)`, never raises an exception for an ordinary business-rule rejection. This was a deliberate fix during development — see the migration's own comment: a Postgres function call is one atomic statement, so raising an exception *after* materializing a lock would roll the lock back too, silently defeating the whole point of materializing it. Verified directly with SQL-level testing before this design was finalized. `outcome` is one of `created | updated | unchanged | replayed | rejected_cutoff | rejected_game_closed | rejected_locked`.

**One coherent operation** (§25): the caller never decides create vs. edit — `lib/actions/predictions.ts`'s `submitPredictionAction` is the same Server Action whether this is a user's first Pick or their tenth change.

## Revision history

`prediction_revisions` (append-only, enforced by the existing generic `forbid_audit_log_mutation()` trigger already proven on `audit_logs`/`wallet_transactions`) captures only genuine selection *changes* — never the initial creation (already fully captured by `predictions.created_at` + the row itself) and never a same-selection idempotent retry (verified: retrying the same selection produces zero revision rows). Each row: the previous selection and its own probability, the new selection and its own probability, and when it happened.

## Probability snapshot semantics (§9)

The rule: **the final selection's own probability at the moment it became final** is what counts — never the original selection's context, and never re-derived from whatever the Market's price happens to be later. Concretely: `lib/actions/predictions.ts` re-reads the Market's current price on *every* call (create or edit) before invoking `set_pick`, so a YES→NO change captures NO's own fresh probability at that instant, not YES's stale one. Verified directly: a later, unrelated Market price update never rewrites an already-stored Pick's snapshot.

## Cutoff policy

`platform_settings.pick_lock_minutes_before_kickoff` (default 10 — the product's "T-10" rule), read live inside `set_pick` on every call, computed against the Market's Game's own canonical `fixtures.scheduled_start_utc` — never from Post publication time, Market creation/ingestion time, or `markets.closes_at` (a structurally different, pre-existing, currently-inert-for-real-markets concept — see below). A pure TypeScript helper (`lib/predictions/lock.ts`) exposes the same formula for future presentation use (e.g. a countdown), but it is display-support only; the SQL function is the sole authority.

### Why this is a *new*, separate column from `prediction_cutoff_minutes_before_close`

The existing `prediction_cutoff_minutes_before_close` (migration 20260101000142) is anchored to `markets.closes_at` — a Market-level, provider-set field. Verified: every R2-ingested sports Market has `closes_at = null` (set explicitly in `lib/prediction-markets/ingestion/nfl.ts`), so that existing policy is currently inert for real sports Markets. Reusing it for R5 would have silently conflated two structurally different cutoffs (Market-closesAt-anchored vs. Game-kickoff-anchored). Both columns remain, each governing its own concept; `prediction_allow_repeat` (the old "may a user submit more than once" toggle) is no longer consulted by any code path — its old meaning is fully superseded by Pick editing, and a genuine second row is now structurally impossible regardless of its value. The column itself was left in place (removing configuration is out of this milestone's scope).

## Lock architecture

- **Effective lock**: always computable live (`now() >= kickoff - lockMinutes`, or Game status left `NOT_STARTED`) — a Pick can be effectively locked before any column says so.
- **Materialized lock**: `predictions.locked_at`/`lock_reason`, set lazily on first touch past the effective cutoff — by an edit attempt (`set_pick` itself) or by the grading job (which must correctly finalize a Pick that was never touched between cutoff and kickoff — verified directly).
- **Reasons**: `CUTOFF` (the only reason any current code path sets) and `CHALLENGE_ACCEPTED` (reserved vocabulary for R7's Free Call BS Challenge acceptance — valid at the schema/CHECK-constraint level, unreachable from any implemented code path; no Challenge table, acceptance logic, or UI exists). Both were included in the same CHECK constraint because R7's need is not speculative — it's the exact, already-named future primitive this milestone's own task described, and adding it now avoids a needless future migration to widen an enum.
- **One-way**: no code path ever nulls `locked_at` back out. A later Game reschedule (postponement) does not reopen an already-locked Pick — verified directly.

## Game lifecycle and eligibility

`set_pick` requires the Game to be exactly `internal_status = 'NOT_STARTED'` for both creation and continued editing — every other status (`LIVE`, `COMPLETED`, `POSTPONED`, `SUSPENDED`, `ABANDONED`, `CANCELLED`, `AWARDED`, `UNKNOWN`) rejects. This is a deliberately conservative, fail-safe choice, not a fully-resolved product policy — see Open Decisions.

**Kickoff movement**:
- *Before any lock*, a later kickoff extends eligibility using the new schedule (verified) — the cutoff is never cached, only ever computed live.
- *Before any lock*, an earlier kickoff can move the cutoff into the past; the very next `set_pick` call fails safe and materializes the lock (verified).
- *After permanent lock*, no reschedule reopens the Pick (verified) — this is the specific invariant R7's Challenge-lock integration will also depend on.

## Market movement independence

A line move (R2's own deactivate-old/insert-new behavior) creates a structurally distinct Market — an existing Pick never migrates to it (verified: the original Pick keeps its original `market_id` and `market_question_snapshot` untouched). `set_pick` itself does not check `markets.status` at all — only the Game's kickoff/status. In the real application flow, this is not a gap: `lib/predictions/policy.ts`'s existing, unchanged `checkMarketEligibility` already rejects an `INACTIVE`-status Market (via `deriveConsumerStatus` returning `null` for it) as `MARKET_INACTIVE` *before* `set_pick` is ever called. So end to end, an inactive historical Market's Pick is not editable through the app today — §19's own open question ("can a user still change YES/NO on an inactive historical Market before T-10?") is answered by this existing, unchanged layer, not silently decided inside R5's own new code.

## Grading interaction

Grading (`lib/predictions/grading.ts`, unchanged pure logic) always operates on the single current `predictions` row — there is structurally only ever one row per user+Market to grade, so "the final selection is the only thing graded" is true by construction, not by any special-casing. Revision rows are never read by grading. Once graded (`lifecycle_state = 'GRADED'`), `set_pick` rejects any further edit (`rejected_locked`) regardless of lock state — verified directly, including the case where a Pick was *never* explicitly locked before the Game completed (grading correctly finalizes it).

## Existing Pick migration (§45)

The migration adding `predictions_one_per_user_market` was verified safe against actual data before being written: the local database held 28 pre-R5 rows with zero `(user_id, market_id)` duplicates, so the constraint was added directly with no backfill or dedup step required. No historical row's semantics were rewritten — every pre-existing row's `selected_outcome`/snapshots/`result`/`graded_at` are untouched; `locked_at`/`lock_reason` simply start `null` for every pre-existing row (exactly matching "not yet materialized," the same lazy-materialization semantics every row — old or new — already uses) and will correctly materialize to locked on the very next touch (an edit attempt or a grading pass), per the same logic verified above for "grading auto-finalizes a Pick that was never explicitly locked." No row needed to be inferred into a permanently-locked or permanently-open bucket at migration time — the lazy model makes that inference automatic and always correct, never guessed.

## UI

`PredictionActions` (extended, not replaced) now serves both "make your first Pick" and "change your Pick": the YES/NO buttons remain interactive after a successful submission (previously replaced by static confirmation text) until the Pick locks, at which point the component switches to a plain "Picks are locked for this game" message. `YourPredictionCard` (unchanged component, narrower usage) is now shown only for a locked-or-graded Pick — its `ResultLine` gained one new case ("Picks are locked for this game. Waiting for result.") to distinguish a locked-but-ungraded Pick from the pre-R5-only "still pending, still editable" state it used to also cover (that state is now handled by the editable component instead). `MarketPredictionCard` — the shared component both `/markets/[id]` and `/post/[id]` already reused from R3 — decides which to render based on `lockedAt`/`lifecycleState`, so both surfaces behave identically with zero duplicated logic. No live countdown UI was added (explicitly optional per this milestone's own text); the reusable calculation (`lib/predictions/lock.ts`) is available for one later without any domain-layer change.

## Security

| Concern | Enforcement |
|---|---|
| Create/edit own Pick | `set_pick`, `service_role`-only execute grant; called via `lib/actions/predictions.ts`'s `requireUser()`-scoped Server Action |
| Edit another user's Pick | Impossible — the Server Action always passes the caller's own id; `predictions` RLS additionally blocks any direct client read/write outside `select own` |
| Forge `locked_at`/`lock_reason`/`result`/`graded_at` | No `authenticated` write grant on `predictions` at all — unchanged, still fully proven |
| Unlock a Pick | No code path exists anywhere that nulls `locked_at` |
| Rewrite/delete revision history | `prediction_revisions` has no `authenticated` write grant, and `service_role` itself is blocked from UPDATE/DELETE by the reused `forbid_audit_log_mutation()` trigger |
| Call `set_pick` directly | Revoked from `public`/`anon`/`authenticated`; granted to `service_role` only |

`predictions`/`prediction_revisions` were both added to `table-privilege-hygiene.test.ts`.

## Configuration ownership

| Concern | Owner | Classification |
|---|---|---|
| One current Pick per user/Market; lock is one-way; graded Pick is immutable; Pick never migrates Market; user can edit only their own Pick | Schema (constraints/triggers) + RLS/grants | TRUE INVARIANT |
| Pick cutoff minutes before kickoff | `platform_settings.pick_lock_minutes_before_kickoff` | CONFIGURABLE PRODUCT POLICY |
| Game-status eligibility (`NOT_STARTED` only) | Hard-coded in `set_pick` | Deliberately conservative fail-safe default — see Open Decisions, not asserted as final product policy |
| Selection, lock timestamp/reason, result, probability snapshot | Row state | USER/OBJECT STATE |
| Canonical kickoff, Game status | `fixtures` (provider-derived) | PROVIDER-DERIVED VALUE |

## Open decisions (genuinely unresolved, not invented)

1. **Postponed-but-rescheduled-future Games**: whether a `POSTPONED` fixture with a confirmed future `scheduled_start_utc` should allow continued Pick editing (using the new schedule) rather than blocking outright the moment status leaves `NOT_STARTED`. R5 chose the conservative "NOT_STARTED only" rule as a safe default per §20's own "fail safe" instruction — this never allows something it shouldn't, but may be more restrictive than a founder ultimately wants. No fixture-rescheduling workflow currently exists in this codebase to observe real behavior from, so this was not silently decided either way.
2. **SUSPENDED/ABANDONED/AWARDED grading policy** — carried over unresolved from R1, untouched by R5.
3. **Live countdown UI** — intentionally not built (optional per this milestone); the calculation is ready whenever a future milestone wants it.
