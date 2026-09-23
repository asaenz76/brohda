# Free Call BS Challenges (Milestone R7)

**Status**: Implements `docs/BROHDA_2_0_MILESTONE_MAP.md` Milestone R7 in full. Records CURRENT STATE only. See `docs/architecture/pick-editing-and-locking.md` (R5) for the Pick layer this domain locks into, `docs/architecture/post-conversation.md` (R6) for the "Talk shit" layer this domain stays independent of, and `docs/architecture/community-distribution.md` (R4) for the distribution layer this domain never references.

## What this is

Call BS is Brohda's free, P2P, non-monetary disagreement mechanic — the third step of "Pick a side / Talk shit / Call BS / Put your money where your mouth is." A Challenge is one user directly challenging another user's *already-existing, opposing* Pick on the same Market. There is no stake, no wallet requirement, no payout, no financial field anywhere in this domain — `challenges` has no `stake_amount`/`currency`/`odds`/`payout`/`fee`/`reserved_balance` column, deliberately, even though R9 will eventually need a monetary Challenge concept.

## Canonical Challenge semantics

A Challenge references two existing Picks (`predictions` rows), never creates or alters either one. It is direct: exactly one challenger, one recipient — never an open lobby, never multi-recipient acceptance. It is not a Comment, a Market, a Pick, or a Monetary Position.

## Identity and ownership

`challenges.market_id` is a plain, deliberate soft reference — the same durability reasoning as `predictions.market_id` (`docs/architecture/prediction-layer.md` §4): a Challenge is permanent head-to-head history and must survive independently of `markets`' own lifecycle. `challenger_prediction_id`/`recipient_prediction_id` **are** real, non-cascading FKs to `predictions.id` — mirroring `prediction_revisions.prediction_id`'s own precedent, since `predictions` rows are themselves never deleted by any code path, so a real FK here gives genuine integrity at no durability cost. `challenger_user_id`/`recipient_user_id` are real FKs to `user_profiles`, `on delete cascade`, matching `predictions.user_id`'s own convention.

## The recipient's Pick id is the only client input

`call_bs(challengerUserId, recipientPredictionId)` — the server derives everything else. The challenger's own Pick is looked up by `(user_id = caller, market_id = recipient's market_id)`, never accepted as a client-supplied id, so a client structurally cannot submit someone else's Pick as "their own." `challengerUserId` itself is always the authenticated caller's own id (`requireUser()`), never client-choosable.

## Opposing-Pick requirement, resolved from canonical selections

Both Picks must already exist before a Challenge can be created — Call BS never creates or edits a Pick. Opposition is checked against `predictions.selected_outcome` directly (`YES`/`NO`), never inferred from display text, Comment content, or AI parsing of anything. A Comment's text is never treated as evidence of a Pick.

## Pick selection snapshots

`challenger_selection_snapshot`/`recipient_selection_snapshot` capture each side's `selected_outcome` at the exact moment the Challenge was created, immutably. Since a Pick is mutable pre-lock (R5), these snapshots are the only reliable record of what was actually being disagreed about when the Challenge was sent — `accept_call_bs()` revalidates the *current* Pick state against these snapshots before ever locking anything (see Acceptance below).

## Lifecycle

`status` ∈ `PENDING | ACCEPTED | DECLINED | EXPIRED | RESOLVED`, orthogonal to `result` ∈ `CHALLENGER_WON | RECIPIENT_WON | VOID` (only set once `status = 'RESOLVED'`). Two independent columns rather than one overloaded enum — `RESOLVED` covers both a real winner and a VOID outcome, since VOID is a sub-case of "resolved," not a separate top-level lifecycle stage. Illegal transitions (`DECLINED → ACCEPTED`, `RESOLVED → PENDING`, etc.) are structurally impossible: no `authenticated` write grant exists on `challenges` at all, and every transition-performing function (`call_bs`/`accept_call_bs`/`decline_call_bs`/the resolution job's own guarded update) checks the current status before acting.

Cancellation (a challenger withdrawing their own PENDING Challenge) was considered and **deliberately not implemented** — not locked product policy, and the task's own text explicitly allows omitting it and reporting the decision when it would add lifecycle complexity without a demonstrated need. A challenger can only wait for accept/decline/expiry.

## Cutoff: the same policy as Pick locking, not a second one

Deliberately **no separate Challenge-cutoff column**. Both `call_bs()` and `accept_call_bs()` read `platform_settings.pick_lock_minutes_before_kickoff` directly and compute the effective cutoff against the Game's own `fixtures.scheduled_start_utc` — the identical read `set_pick()` itself uses. This is "the smallest coherent architecture" the task asked for, and it *structurally* guarantees the task's own stated invariant ("a Challenge cannot remain accept-able after ordinary Pick mutability has closed") rather than relying on two configurable values happening to agree — they cannot drift apart because they are the same value.

## Expiration

No cron exists or is required. A PENDING Challenge past the effective cutoff is lazily materialized to `EXPIRED` the moment someone actually attempts to accept it (`accept_call_bs`'s own live re-check) — the exact same lazy-materialization philosophy `set_pick()` already established for Pick locking. `EXPIRED` also covers the *other* way a pending Challenge stops being actionable: a Pick edit since creation that no longer matches the Challenge's own selection snapshots (see Acceptance below) — both cases mean "this Challenge can no longer be acted on," and neither needed its own separate status.

## The acceptance transaction

`accept_call_bs(challengeId, recipientUserId)` — a single atomic operation, returning `(challenge, outcome)` rather than raising exceptions for ordinary business outcomes (mirroring `set_pick()`'s own pattern exactly, for the identical reason: this function *does* have a "materialize a state change, then report a non-success outcome" path — transitioning to `EXPIRED` — and a plain exception there would roll that materialization back, the exact bug R5's own migration comment documents catching by direct SQL testing).

Order of operations inside one transaction:
1. Lock the Challenge row (`FOR UPDATE`); verify caller is the recipient (real exception, `not_recipient` — this is a security violation, not a business outcome); verify still `PENDING`.
2. Re-read the canonical Game live; compute the effective cutoff (§ above). Past cutoff → materialize `EXPIRED`, return `rejected_cutoff`.
3. Lock both Pick rows in **deterministic ascending-`predictions.id` order**, regardless of which one is "challenger" vs. "recipient" for this call (see Concurrency below).
4. Re-check: either Pick already `CUTOFF`-locked (a race — see Concurrency) → `EXPIRED`, `rejected_cutoff`. Either Pick's current `selected_outcome` no longer matches its own stored snapshot, or either is `GRADED` → `EXPIRED`, `rejected_invalidated`.
5. Lock both Picks: `locked_at = now(), lock_reason = 'CHALLENGE_ACCEPTED'` — but **only where `locked_at is null`**, never overwriting an existing compatible lock (see Multiplicity).
6. Transition the Challenge to `ACCEPTED`.

## Deterministic Pick-lock ordering

Two Pick rows are always locked in ascending `predictions.id` order, never in "challenger first" / "recipient first" order depending on caller perspective. This is what makes two concurrent `accept_call_bs` calls that happen to share one Pick (see Multiplicity) provably deadlock-free: any two transactions that need the same two rows will always request them in the same relative order.

## Concurrency behavior (races this design is proven safe against)

- **Acceptance vs. a concurrent Pick edit**: `accept_call_bs` holds `FOR UPDATE` on both Pick rows for the rest of its transaction. A concurrent `set_pick()` call on the same row blocks until that transaction commits, then correctly observes the now-locked row and returns `rejected_locked` — ordinary Postgres row-lock semantics, no extra code needed, reusing exactly the seam R5's own migration comment says it left for this.
- **Acceptance vs. cutoff**: the live cutoff check happens twice — once before acquiring the Pick locks (cheap short-circuit), once implicitly enforced by the fact that a genuinely-CUTOFF-locked Pick (set by a `set_pick` call that won the race) is explicitly checked for and rejected *after* the Pick locks are acquired, closing the window between the first check and lock acquisition.
- **Acceptance vs. a Pick edit that happened before acceptance was even attempted**: caught by the selection-snapshot revalidation (step 4 above), verified directly (`tests/integration/call-bs-challenges.test.ts`, "Pending behavior" / "Acceptance").

Verified directly by integration test for every one of these paths — not asserted from code reading alone.

## Pick multiplicity

"Same immutable Pick may participate in multiple accepted free Challenges" is explicitly supported, not merely permitted by omission: the acceptance transaction's lock-only-if-null update (step 5 above) means a Pick already `CHALLENGE_ACCEPTED`-locked from one earlier-accepted Challenge is left completely untouched (`locked_at` never overwritten) when a *second*, independent Challenge against that same Pick is later accepted. Verified directly (André picks Giants; Carlos and David both pick Rams; André↔Carlos accepted; André↔David subsequently accepted; André's Pick's `locked_at` is provably unchanged from the first acceptance; still exactly one `predictions` row for André).

**Duplicate/reverse-duplicate prevention** (a *different* concern from multiplicity — the same *pair* challenging each other twice at once, not two *different* pairs) is enforced structurally: a partial unique index on `(least(challenger_prediction_id, recipient_prediction_id), greatest(...))` where `status = 'PENDING'` blocks André→Carlos and a simultaneous Carlos→André, in either direction, while never blocking a *fresh* Challenge between the same two once a prior one between them reached a terminal state (`DECLINED`/`EXPIRED`/`RESOLVED`).

## Resolution: consumes grading truth, never produces it

"Market resolves → Picks grade → accepted Challenges resolve." `lib/challenges/resolution.ts`'s `decideChallengeResolution` is a pure function reading two already-`GRADED` `predictions` rows — it never grades anything itself, never writes to `predictions`. Both Picks must independently reach `lifecycleState = 'GRADED'` (via the existing, unchanged Pick-grading job) before a Challenge can resolve; if only one has graded so far, resolution leaves it `ACCEPTED` and tries again next run. `resolveAcceptedChallenges()` (`scripts/resolve-challenges.ts`, manual/developer invocation only — same as `scripts/grade-predictions.ts`, no cron, by the same "no scheduler is required for correctness" reasoning) is idempotent by construction: guarded by `.eq("status", "ACCEPTED")` in its own update, so a concurrent/repeated run resolves nothing twice and fires no duplicate notification.

Since both Picks are graded from the *same* Market's one deterministic outcome and their selections are structurally opposing, exactly one is `CORRECT` and the other `INCORRECT` whenever neither is `VOID` — the winner derives from that alone. A defensive fallback (treated as `VOID`) exists for the structurally-unreachable case where that invariant is somehow violated; it never fabricates a winner from an inconsistent pair.

## VOID

If either Pick grades `VOID` (the Market never reached a trustworthy result), the Challenge resolves to `result = 'VOID'` — no winner, and nothing to refund, since R7 has no money at all. Both participants receive a void-specific notification with no winner/loser language.

## Notifications

Four events, all in `lib/notifications/challenges.ts` (plain TS-constructed copy, deliberately not a `platform_settings`-driven template system like predictions' own — the task's "don't hard-code mutable wording into SQL/domain logic" is already satisfied by plain TypeScript string construction, and a second config-driven copy system wasn't justified for this milestone): **received** (recipient, on creation), **accepted**/**declined** (challenger, on the recipient's response), **resolved** (both participants, win/loss/void-specific copy). The recipient is always derived from the Challenge's own stored `challenger_user_id`/`recipient_user_id` — never accepted from a client. Resolution notifications fire exactly once per newly-resolved Challenge, riding on the same idempotency guard the resolution job itself already has (verified directly: running resolution twice never duplicates the notification).

## Rate limiting

Reuses the existing generic `check_and_increment_rate_limit` primitive, namespaced `call_bs:${userId}` — no second mechanism. Protects Challenge **creation** only (accept/decline are inherently self-limiting: a user can only act on a Challenge that already exists and is already addressed to them). Window/cap are configurable (`platform_settings.call_bs_rate_limit_*`), read live.

## Security

| Concern | Enforcement |
|---|---|
| Create own Challenge | `call_bs`, `service_role`-only execute grant; caller identity always `requireUser()`-derived |
| Accept/decline addressed-to-self only | `accept_call_bs`/`decline_call_bs` both raise `not_recipient` (a real exception) for any other caller — verified directly, including the challenger attempting to accept/decline their own outgoing Challenge |
| Alter participants/Pick refs/selection snapshots | No `authenticated` UPDATE grant on `challenges` at all — verified directly |
| Force a winner or lifecycle state | Same — only the three RPCs and the resolution job's own guarded service-role update can ever write this table |
| Read another user's non-public Challenge | RLS: participants always read their own (any status); any authenticated user may additionally read a `RESOLVED` Challenge (the public factual head-to-head record, §38/§48) — verified directly that an outsider cannot read a `PENDING` one |
| Call `call_bs`/`accept_call_bs`/`decline_call_bs` directly | Revoked from `public`/`anon`/`authenticated`; `service_role` only — verified directly for all three |
| Forge a notification recipient | Always re-derived from the Challenge's own stored ids |

`challenges` was added to `tests/integration/table-privilege-hygiene.test.ts`'s `REPRESENTATIVE_TABLES`.

## Independence from Community distribution and Comments

`challenges` has no `community_id` and no `post_id` column — verified directly by inspecting the live row's own columns, not just the TypeScript type. Nothing in `lib/challenges/` reads or writes `post_communities`, `communities`, or `post_comments`. A Comment's text is never treated as evidence of an opposing Pick (§44) — the only path into a Challenge is a real, canonical `predictions` row.

## Discovery UI (the smallest necessary participant surface)

`predictions` RLS remains own-row-only (unchanged from R5) — this milestone does not loosen it. `lib/challenges/discovery.ts`'s `getMarketParticipants()` runs on the service role (like R6's `getPostConversation`) and returns *only* `{userId, displayName, username, avatarUrl, predictionId, selectedOutcome, canCallBs}` for every participant on a Market — never probability snapshots, lock state, wallet info, email, or any other private field. `canCallBs` is computed server-side (opposing selection, neither Pick graded, before cutoff, Call BS enabled, no existing PENDING/ACCEPTED pair already linking the two). Mounted inside the existing, shared `MarketPredictionCard` component, so it appears identically on both `/markets/[id]` and `/post/[id]` with zero duplicated wiring, and only once the viewer has made their own Pick (Call BS structurally requires the challenger to already have one).

## Future monetary escalation boundary

R7 deliberately exposes nothing beyond a clean, stable `challenges.id` for a future R9 Monetary Challenge/Position to reference. No stake, currency, odds, payout, fee, or reserved-balance field exists anywhere in this schema — adding money later is additive, not a rework of anything built here.

## Configuration ownership

| Concern | Owner | Classification |
|---|---|---|
| One challenger, one recipient; challenger ≠ recipient; both Picks same Market; selections oppose; only the recipient accepts/declines; acceptance locks both Picks atomically; winner derives from Pick grading; VOID has no winner; structural terms immutable | Schema (constraints/RLS/grants) + the three RPCs | TRUE INVARIANT |
| Call BS feature enablement | `platform_settings.call_bs_enabled` (default `false`, matching `post_publication_enabled`/`community_distribution_enabled`/`market_ingestion_enabled`'s own off-by-default convention for a new mechanic) | CONFIGURABLE PRODUCT POLICY |
| Challenge cutoff | `platform_settings.pick_lock_minutes_before_kickoff` — the *same* column R5 already owns, deliberately not a second one (§ above) | CONFIGURABLE PRODUCT POLICY (shared with R5) |
| Creation rate limit | `platform_settings.call_bs_rate_limit_*`, read live | CONFIGURABLE OPERATIONAL POLICY |
| Challenge status/result, timestamps | Row state | USER/OBJECT STATE |
| Pick grading result | `predictions` (R1/R5, unchanged) | UPSTREAM DOMAIN STATE |

## Open decisions carried forward, untouched

R5's two open decisions (postponed-but-rescheduled Pick eligibility; `SUSPENDED`/`ABANDONED`/`AWARDED` grading policy) remain exactly as R5 left them. R7 uses the same conservative existing Pick-eligibility semantics wherever it touches Game/kickoff state, and never resolves either question on R5's behalf. An accepted Challenge remains accepted through any later Game-status change; it resolves only once canonical grading actually produces a result for both sides.

## Deliberately not built

Challenger cancellation of a PENDING Challenge (see Lifecycle above). A dedicated Challenge dashboard/notifications-list page (the query capabilities — `listIncomingPendingChallenges`, `listOutgoingPendingChallenges`, `listActiveChallenges`, `listResolvedChallenges`, `getChallengeRecordForUser` — all exist in `lib/challenges/repository.ts` and are fully tested; the Post/Market-context surface plus notifications were judged sufficient for this milestone, per the task's own "Post context and/or profile context may be sufficient" allowance). A profile-page "Call BS record" UI section (the underlying factual win/loss/void query exists and is tested; rendering it on the profile page was not built in this pass). No reputation scoring, XP, badges, or streak bonuses of any kind — R11's own concern.
