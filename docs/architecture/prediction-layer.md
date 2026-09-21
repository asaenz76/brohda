# Prediction Layer — Milestone 3

**Status**: Implements `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` Milestone 3 — Brohda Prediction Layer, and only that milestone.

> A Brohda Prediction is a permanent social/history/reputation record of what a user believed at a specific moment. It is not an Order, Trade, Position, wallet transaction, or financial exposure.

> Milestone 3 introduces no real-money execution capability. Milestone 4 remains the hard gate for custody, signing, legal/compliance, fee, geofencing, account-model, and execution decisions.

## 1. Scope

A user can open an eligible market (Milestone 2's discovery surface) and make a FREE/practice YES or NO Prediction against Brohda's own normalized market state. That Prediction is recorded permanently, independent of financial execution — there is none. It can later be graded once the market authoritatively resolves, contributing to two new, minimal, factual reputation counters. No `Order`, `Trade`, `Position`, wallet, signing, custody, or money-movement concept is introduced anywhere in this milestone — see §2.

## 2. Prediction vs Market vs future Position

```
Market (Milestone 1)         — what a provider currently says about a question.
Prediction (this milestone)  — what a Brohda user believed about that question, at one moment, permanently.
Position (future, M7)        — a financial exposure held through a provider. Does not exist yet.
```

A `Market` row can be re-synced, re-categorized, or (in principle) archived without touching a single `Prediction` row — proven by `tests/integration/predictions.test.ts`'s snapshot-survival tests, which mutate a `Market` after a `Prediction` exists against it and assert the `Prediction`'s own fields never move. A `Position` cannot yet exist to be confused with a `Prediction` at all — there is no code path in this codebase that creates one. This is the strongest form of the separation roadmap §3 requires: it isn't merely documented, it's currently *impossible* to conflate because one side of the conflation doesn't exist.

## 3. Prediction schema

`public.predictions` (migration `20260101000141`):

| Column | Purpose | Immutable? |
|---|---|---|
| `id` | Brohda Prediction id | — |
| `user_id` | owner (FK, `on delete cascade`, matching this codebase's `team_follows` precedent for user-owned rows) | yes |
| `market_id` | soft reference to `markets.id` — see §4 | yes |
| `selected_outcome` | `'YES' \| 'NO'` | yes |
| `yes_probability_snapshot`, `no_probability_snapshot` | 0-1, independently captured | yes |
| `market_question_snapshot` | the question text at prediction time | yes |
| `market_close_at_snapshot` | the market's close time as observed at prediction time | yes |
| `market_status_snapshot` | Brohda's own `ACTIVE\|CLOSED\|RESOLVED` consumer status at prediction time — never a raw provider status | yes |
| `lifecycle_state` | `'PENDING' \| 'GRADED'` | grading-only |
| `result` | `'CORRECT' \| 'INCORRECT' \| 'VOID'`, null until graded | grading-only, one-way |
| `resolved_outcome_snapshot` | the market's resolved outcome *as observed at grading time* | grading-only, one-way |
| `graded_at` | — | grading-only |
| `idempotency_key` | technical duplicate-submission protection, not policy — see §12 | yes |
| `created_at`, `updated_at` | — | `created_at` immutable |

No `order_id`, `trade_id`, `position_id`, `wallet_id`, `settlement_token`, provider token id, or financial amount field exists anywhere on this table.

## 4. Durable Market identity preservation

**Decision**: `market_id` is a plain `uuid`, deliberately **not a foreign key** — the same preservation pattern this codebase already established for `audit_logs`/`wallet_transactions` (plain uuid references to business entities, so permanent history survives the referenced row's own lifecycle; the roadmap's own §3 names this exact precedent). Milestone 1's `markets` rows are never deleted (`upsertMarket` only ever inserts-or-updates), so in the codebase's *current* form `market_id` is in practice a reliable, always-resolvable lookup key. The point of the soft reference is not "we expect this to break today" — it's that a bare FK would make Prediction history only as durable as (a) that row continuing to exist, (b) a future schema change never adding an `on delete`, and (c) a future provider-migration decision never restructuring `markets`. None of that should ever be able to invalidate a permanent belief record, so history does not depend on it.

The real source of historical truth is the `*_snapshot` columns (§3): `market_question_snapshot`, `market_close_at_snapshot`, `market_status_snapshot`, and both probability snapshots. A Prediction remains fully meaningful for history/grading display even if the referenced `markets` row is later archived, restructured, given a new category mapping, or (in a future milestone) deleted outright. `market_id` itself is kept for one purpose only: a live convenience lookup ("what does this market look like *today*", used by the market-detail page and the grading job) — never relied on as the sole source of what the Prediction *was*.

**What was deliberately not stored**: raw provider identifiers (`provider`, `providerMarketId`), category tags, or the full market description. Provider identity must stay invisible in consumer UX (roadmap STEP 26) and has no bearing on grading (which reads the *current* market via `market_id`, never a stored provider id). Categories are a browse/filter concern, not a history-display or grading concern — omitting them keeps the snapshot to exactly what roadmap §3 asks for ("the identity and *relevant* snapshot"), not a maximal copy of provider metadata (explicitly prohibited by this task's own instructions).

## 5. User/outcome relationship

One `Prediction` row names exactly one user and one selected outcome (`YES` or `NO`) — a closed, two-outcome set, a true domain invariant (`predictions_selected_outcome_check`). Multi-outcome markets are out of scope; nothing in this codebase (Milestone 1's normalized `NormalizedMarketPrice` is already YES/NO-shaped) currently represents anything else.

## 6. Lifecycle

```
PENDING  --[grading job, market authoritatively RESOLVED]-->  GRADED (result: CORRECT | INCORRECT)
PENDING  --[grading job, market ARCHIVED without ever resolving]-->  GRADED (result: VOID)
PENDING  --[market still ACTIVE/CLOSED/INACTIVE]-->  PENDING (no transition)
```

Lifecycle state (`PENDING`/`GRADED`), the user's `selected_outcome`, and the market's eventual `resolved_outcome_snapshot` are three distinct fields, never conflated — `predictions_result_requires_graded` and `predictions_correctness_matches_outcome` (migration `20260101000141`) enforce this at the database level: a `PENDING` row can never carry a result, and a `GRADED` row always carries exactly one. `result` (correctness) is a *fourth*, separately-stored fact — the comparison of the other two, computed once and never re-derived on read (see §13).

A Prediction can, and normally does, exist for a long time before its Market resolves — this is the ordinary case, not an edge case.

## 7. Grading architecture

```
Provider resolution
  -> normalized Market resolution   (lib/prediction-markets/providers/polymarket/normalize.ts — mapResolvedOutcome)
  -> Prediction grading              (lib/predictions/grading.ts — decideGrading / runGradingJob)
```

`lib/predictions/grading.ts` never interprets a raw provider field — it only ever reads `MarketRecord.status`/`resolvedOutcome` (Milestone 1's own normalized shape), which only `lib/prediction-markets/providers/polymarket/normalize.ts` is responsible for deriving. This keeps the "provider resolution → raw user Prediction directly" path this task explicitly forbids structurally impossible, not merely undocumented: `lib/predictions/` never imports from `lib/prediction-markets/providers/`.

**Decision rule** (`decideGrading`, unit-tested exhaustively in `tests/unit/predictions/grading.test.ts`):
- Market not found (a data anomaly, not expected in normal operation since `markets` rows are never deleted): left `PENDING`.
- Market `ACTIVE`/`CLOSED`-without-resolution: left `PENDING` — never fabricated.
- Market `RESOLVED` (Milestone 2's own `deriveConsumerStatus`, requiring a genuinely non-null `resolvedOutcome`): graded `CORRECT`/`INCORRECT` by direct comparison to `selected_outcome`.
- Market `ARCHIVED` without ever having resolved (Milestone 1's most terminal status — "read-only, no updates" per the provider's own docs): graded `VOID`. This is the one case treated as *permanently* undecidable rather than left `PENDING` forever — a Prediction whose market can structurally never resolve should not hang in limbo indefinitely. A merely `INACTIVE` market (not terminal — could still become `ACTIVE` again) is never `VOID`ed prematurely.

**The grading job** (`runGradingJob`, invoked by `pnpm grade-predictions`, `scripts/grade-predictions.ts`) is a bounded batch over `PENDING` rows (oldest first, capped at 200 per run), idempotent by construction:
1. `listPendingPredictions()` only ever reads `PENDING` rows.
2. `markPredictionGraded()`'s own `UPDATE` is itself filtered to `.eq("lifecycle_state", "PENDING")` — a concurrent or repeated run over the same row is a safe no-op (the update affects zero rows) rather than a second write.
3. The streak update (§9) and the graded-notification (§10) are only ever invoked from within the same pass that successfully flips a row from `PENDING` to `GRADED` — a re-run that finds zero eligible rows the second time triggers neither again.

No production scheduler is wired to this job — it is a manual/developer invocation only, matching Milestone 1's `pnpm ingest-prediction-markets` precedent exactly. A future milestone may point a cron-compatible route at the same `runGradingJob` function; that decision belongs there, not here.

## 8. Resolution source — Milestone 1 extension

Milestone 1 explicitly left `resolved_outcome` always `null` (`docs/architecture/prediction-market-provider.md` §15) — no confirmed, reliable resolution field had been researched. Grading needs one, so this milestone researched and extended it minimally, per this task's own instruction to verify official documentation and live behavior rather than guess:

- **Official docs** (`docs.polymarket.com/concepts/resolution`): "winning tokens become redeemable for $1.00 each."
- **Live verification** (`gamma-api.polymarket.com`, 2026-09-16, real recently-closed markets): a genuinely resolved market's `outcomePrices` settle to exactly `1` for the winning outcome and exactly `0` for the losing one (e.g. `["1","0"]`).
- **A real discrepancy found and deliberately not trusted**: some very old (2020-era) closed markets return `["0","0"]` — likely pre-CLOB/AMM-era rows whose prices were never backfilled after resolution. These are left unresolved by design rather than guessed at.

**Extension**: `lib/prediction-markets/providers/polymarket/normalize.ts`'s new `mapResolvedOutcome` derives `"YES"`/`"NO"`/`null` from the already-independently-read `price.yes`/`price.no` pair (never deriving one side from the other — both were already read independently by the pre-existing `mapPrices`; this only recognizes when that pair happens to form a clean, terminal settle) when `status === "CLOSED"`. `umaResolutionStatus`/`resolvedBy` remain raw, provider-specific, diagnostic-only pass-through — their exact value vocabulary is not officially documented, so they are never used to *derive* a result, only kept for inspection. Unit-tested in `tests/unit/prediction-markets/polymarket-normalize.test.ts` (clean YES, clean NO, non-closed market, legacy-shaped `["0","0"]`, and `ARCHIVED` markets all covered).

## 9. Reputation/streak hooks

New columns on `user_profiles` (migration `20260101000142`): `prediction_correct_count`, `prediction_incorrect_count`, `prediction_current_streak`, `prediction_best_streak`.

**Deliberately separate from the pre-existing `correct_predictions_count`/`current_streak`/`best_streak` columns** (`20260101000018_leaderboard.sql`), which the *legacy pool-entry settlement path* already owns exclusively. Writing Milestone 3 grading results into those same counters would silently blend two domains' outcomes into one number — this task's own instructions are explicit that the two must never cross-write. Same shape (plain integer counters, updated by the relevant grading path), new columns — the roadmap's "adapted, not rebuilt" language is honored at the level of *pattern*, not by literally sharing live state between two different products' outcomes.

**Final standing-rule remediation, Finding 2 (post-completion re-review)**: only `prediction_correct_count`/`prediction_incorrect_count` are actually written to or read by any Milestone 3 code. `prediction_current_streak`/`prediction_best_streak` were originally also maintained by the grading job, but on re-review a "streak" is not a factual aggregate the way a correct/incorrect count is — it embeds real, undecided product policy (does `INCORRECT` reset it? does `VOID` preserve it? is the sequence ordered by when a Prediction was *made* or by the order the grading job happened to *process* it, which can differ? do repeated Predictions on one market, when `prediction_allow_repeat` is on, count separately?). None of that is genuinely inherent to the domain — it is exactly the founder-owned reputation design question `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` Milestone 8 reserves for itself. **Deferred to Milestone 8** (`lib/predictions/streak.ts`'s own comment carries the full reasoning): no current Milestone 3 consumer feature genuinely *needed* a streak number — the "X in a row" line in `market-predictions-tab.tsx` was removed, since it existed only because the original Milestone 3 task listed a basic streak as something the milestone *may* expose, not something it *must*.

Per the roadmap's own locked "additive migration before destructive migration, always" principle, the two now-unused columns are **not dropped** (migration `20260101000145` only updates their schema-level `comment` to record the deferral) — they remain at their default of `0`, reserved for Milestone 8 to adopt with a real, founder-reviewed streak definition, or to formally retire.

Only basic, factual counters are active: no difficulty adjustment, no weighting, no leaderboard-inclusion logic, no "Brohda Score," and now no streak either. The roadmap explicitly reserves the actual reputation algorithm for Milestone 8, with founder review — nothing here invents one. `VOID`-graded predictions never touch the active counters (there is no correct/incorrect fact to record). Spend or volume has no influence anywhere in this milestone — there is no financial volume to influence it with.

**Known limitation**: `recordGradedPredictionResult` (`lib/predictions/streak.ts`) does a read-then-write, not a single atomic update — acceptable because `runGradingJob` processes predictions sequentially within one process and no production scheduler exists yet to run two grading passes concurrently. A future milestone adding concurrent/scheduled grading should revisit this with an atomic increment.

## 10. Notifications

One event identity: `prediction_graded` (`lib/notifications/predictions.ts`), with copy that differs by result (correct/incorrect/void). Deliberately **no** "Prediction accepted" notification — the create action already returns a synchronous on-screen confirmation ("You predicted YES at 31%"), and a redundant notification for something the user is already looking at would be exactly the spam this codebase's own notification precedent avoids.

**Final notification-policy remediation (superseding an earlier, incorrect classification)**: an initial standing-rule pass classified "whether this notification fires at all" and "whether VOID notifies" as true invariants, reasoning that no other notification type in this codebase is configurable either. On further review that reasoning does not hold — **existing precedent is not proof of invariance**, and whether/which grading results notify a user is ordinary, genuinely mutable product policy (a founder could reasonably want to mute VOID notifications, or disable grading notifications entirely during a migration, without a deploy). This is now configured, not hard-coded:

| Column (`platform_settings`, migration `20260101000146`) | Default | Governs |
|---|---|---|
| `prediction_notifications_enabled` | `true` | master on/off switch for `prediction_graded` |
| `prediction_notify_on_correct` | `true` | whether a `CORRECT` grading result notifies |
| `prediction_notify_on_incorrect` | `true` | whether an `INCORRECT` grading result notifies |
| `prediction_notify_on_void` | `true` | whether a `VOID` grading result notifies |

Defaults reproduce the prior hard-coded behavior exactly — this remediation changes *where* the decision lives, not its current effective value (Step 5's own requirement).

**Architecture**: `lib/predictions/policy.ts`'s `getPredictionNotificationPolicy()` reads the four columns and fails **closed** on any read/shape problem — returning `null` rather than throwing, deliberately the opposite of §11's `getPredictionPolicy()`, which fails open: that governs ordinary product eligibility (an unreadable row should not block every prediction), while this governs an optional, best-effort side effect (an unreadable row should never justify sending something it cannot verify was actually requested). `shouldNotifyForResult(result, policy)` is the pure decision (`null` policy, or a `PredictionResult` this function does not explicitly recognize, both deny — no `default: true` fallthrough). `lib/notifications/predictions.ts`'s `maybeCreatePredictionGradedNotification` is the real entry point grading calls: it consults policy, and only inserts the notification when policy says yes — `createPredictionGradedNotification` (the plain insert) is now an internal implementation detail, not called directly by grading.

**Grading/notification separation (true invariant, unchanged)**: `lib/predictions/grading.ts`'s `runGradingJob` always persists the graded `result` (`markPredictionGraded`) and updates the factual correct/incorrect aggregates (`resultRecorder`) *before* it ever reaches the notification step. `maybeCreatePredictionGradedNotification` never throws — a policy-read failure is swallowed inside `getPredictionNotificationPolicy` (returns `null`, treated as deny), and a notification-insert failure is caught and logged (`console.error`) by `maybeCreatePredictionGradedNotification` itself. Notification policy cannot re-grade, cannot revert an already-persisted result, and cannot fail the grading run for any other still-pending Prediction in the same batch.

**Duplicate protection (true invariant, unchanged)**: still by construction, not a flag — the notification step is only ever reached once per row, on the same pass that flips `PENDING` to `GRADED` (§7). A row that's already `GRADED` is never re-visited, so it can never notify twice, regardless of how many times `runGradingJob` is re-run.

**No retroactive notifications on policy change (deliberate, tested)**: if notifications are disabled while a Prediction is graded, then later re-enabled, that already-graded Prediction is **not** retroactively notified — the notification step only ever runs at the moment of the `PENDING → GRADED` transition, which happens exactly once per row. Re-running the grading job after a policy change never re-examines already-`GRADED` rows, so there is no replay path. This is the expected Milestone 3 behavior named in this remediation's own instructions, verified in `tests/integration/predictions.test.ts`.

**Copy (final copy-configuration remediation — superseding the immediately prior classification)**: title/body wording for all three results is now configurable, correcting this document's own previous judgment that it was "a one-time copywriting decision, not a value that changes through normal product operation." On reflection that judgment was wrong for the same reason the enablement/trigger booleans' prior "true invariant" classification was wrong: a founder could reasonably want to reword a notification (tone, clarity, a copy test) without a deploy, and nothing about wording is architecturally fixed the way, say, the event identity `prediction_graded` is.

| Column (`platform_settings`, migration `20260101000147`) | Default |
|---|---|
| `prediction_notify_title_correct` / `prediction_notify_body_correct` | `You were right` / `Your prediction on "{{question}}" was correct.` |
| `prediction_notify_title_incorrect` / `prediction_notify_body_incorrect` | `Result is in` / `Your prediction on "{{question}}" was incorrect.` |
| `prediction_notify_title_void` / `prediction_notify_body_void` | `No result this time` / `"{{question}}" didn't reach a final result, so this prediction won't count.` |

`{{question}}` is a plain literal placeholder — `lib/notifications/predictions.ts`'s `renderNotificationCopy` substitutes it via `String.prototype.replaceAll`, never `eval` or a template-expression engine, so a stored value can only ever contain text, not logic (not a CMS, per this task's own explicit constraint).

**Fail-safe design deliberately differs from the enablement policy's fail-closed strategy**: `getPredictionNotificationCopyPolicy()` (`lib/predictions/policy.ts`) returns `null` on a missing row, a read error, or ANY of the six values being a non-string/empty (one bad entry invalidates the whole row, the same discipline `parseCapabilityPolicy` applies) — but `renderNotificationCopy` treats `null` as "use `DEFAULT_NOTIFICATION_COPY`" (the same strings as the table above), not "send nothing." Whether to notify at all is still governed entirely by §10's enablement policy; copy failure only ever affects *wording*, and falling back to known-good built-in text is safer than silently withholding a notification a user is otherwise owed — the roadmap's own "silence is never acceptable where trust is at stake" applies here too. Grading itself is unaffected either way, verified directly in `tests/integration/predictions.test.ts`.

**Operator path**: extends the same `pnpm set-prediction-policy` script (`--title-correct`, `--body-correct`, `--title-incorrect`, `--body-incorrect`, `--title-void`, `--body-void`) rather than a new script or an admin UI — consistent with every other Milestone 3 policy knob.

**Security**: `platform_settings` already has RLS/grants established (`20260101000050`: public read, `service_role`-only write) — these four new columns inherit that posture automatically, same as every prior `platform_settings` extension in this codebase. No new table, no new RLS policy, no new `SECURITY DEFINER` function. Operator path: `pnpm set-prediction-policy --notifications-enabled=... --notify-on-correct=... --notify-on-incorrect=... --notify-on-void=...`, extending the same script (and the same reasoning for staying a script rather than an admin-UI form) already established for the five eligibility knobs.

## 11. Prediction eligibility policy — configuration, not hard-coding

Five genuinely mutable knobs, added to the existing `platform_settings` singleton (migration `20260101000142`, reusing Milestone 2's own established pattern for `discovery_fresh_within_minutes` rather than inventing a new framework):

| Column | Default | Governs |
|---|---|---|
| `prediction_allow_repeat` | `false` | may a user submit more than one Prediction on the same market? |
| `prediction_cutoff_minutes_before_close` | `0` | minutes before close at which new Predictions stop |
| `prediction_allow_stale_price` | `true` | may a STALE-priced market be predicted on? |
| `prediction_allow_unavailable_price` | `false` | may a market with no usable price be predicted on? |
| `prediction_allow_closed_market` | `false` | may a CLOSED-but-unresolved market be predicted on? |

All five are read by, and only by, `lib/predictions/policy.ts`'s pure `checkMarketEligibility` — proven genuinely configurable end-to-end, not just in principle, by `tests/integration/predictions.test.ts`'s "changing platform_settings alone changes eligibility, with no code change" test.

**What is a true invariant instead**: a `RESOLVED` market is *never* predictable, regardless of any policy value — predicting on an already-known outcome is not a prediction at all, so this is not exposed as a configuration knob (`checkMarketEligibility` checks it before consulting policy at all).

**Changed via** `pnpm set-prediction-policy` (`scripts/set-prediction-policy.ts`) — a script, not a new admin-UI form. This codebase's existing settings page (`app/(admin)/admin/settings/page.tsx`) is a hand-built form per toggle; adding five new fields there is UI surface this narrow a milestone does not yet need. A future milestone may promote these to that page if they turn out to need frequent operator attention — noted as a deliberate, reversible scope decision, not an oversight.

**Knobs deliberately NOT built**: a per-user daily/rate limit, edit/cancel as a separate mutation, and "uncategorized markets ineligible." None of these have a consuming code path in this milestone — adding a configuration column nothing reads would be dead configuration (the same "configuration theater" anti-pattern Milestone 2's own hard-coding audit already named and rejected for over-specified validation bounds). See §12 for how repeat-submission naturally substitutes for "edit."

## 12. Repeat-prediction policy, immutability, and why there's no separate "edit"

`prediction_allow_repeat` governs whether `lib/actions/predictions.ts`'s `submitPredictionAction` allows a second submission on the same market. This is checked in **application code**, reading live policy on every call — deliberately **not** a database unique constraint. A hard `unique (user_id, market_id)` constraint would make the "one prediction per market" rule a schema fact instead of a policy fact, and changing it later would require a migration — exactly what this task's instructions explicitly forbid ("do not allow tests or database constraints to accidentally turn a mutable policy into architecture").

When repeat is allowed, a new submission is **never treated as editing the prior row** — it creates a new, separate, fully immutable `Prediction`. There is no "edit prediction" or "cancel prediction" mutation anywhere in this codebase: the *only* mutation `predictions` ever receives from application code is `createPrediction` (insert-only) and the grading job's one-way `markPredictionGraded`. This is a deliberate, append-only design, chosen specifically because it satisfies this task's own instruction ("if policy permits a changed prediction, consider append-only/versioned records... document the approach") without needing a separate edit concept at all: a user's most recent Prediction on a market (`getLatestUserPredictionForMarket`) is simply "their current belief," while every prior one remains, untouched, in history.

**Immutability enforcement**: no `UPDATE` RLS policy exists for `authenticated` on `predictions` at all (migration `20260101000141`) — proven directly in `tests/integration/predictions.test.ts` ("no authenticated client — not even the owner — can UPDATE a Prediction directly"). Only the service-role grading job may ever transition a row, and only along the one-way `PENDING → GRADED` path.

## 13. Correction/reversal limitation — stated, not engineered around

Grading never re-visits an already-`GRADED` row (§7). If a market's resolved outcome were ever to change after a Prediction was already graded (e.g. a hypothetical provider correction re-ingested), Brohda's own Prediction record does **not** automatically update. This is a deliberate, documented limitation, not an oversight: it preserves the "do not mutate past history" principle at the cost of not handling that rare case, which would require an explicit administrative re-grading capability this milestone does not build (Step 24 explicitly prefers diagnostics over mutation). A future milestone may add one if this proves to matter in practice.

## 14. FREE/practice semantics

A Prediction "records belief... has no financial stake... creates no order... creates no Position... creates no wallet transaction... creates no payout... creates no monetary settlement" — verified structurally, not just by convention: `lib/predictions/`, `lib/actions/predictions.ts`, and every UI component under `components/predictions/` contain zero references to any wallet, payment, or settlement module, and the `predictions` table has no amount/currency column of any kind (§3). This is the roadmap's own Milestone 3 FREE-mode decision (§5 there), finalized here as intended: no amount input exists anywhere in the submission UI; consumer copy says "Make your prediction" and "You predicted YES at 31%," never Buy/Sell/Trade/Order/Contract/Shares/Position/Wallet/Stake/Bet slip (roadmap STEP 26; enforced in `tests/e2e/predictions-flow.spec.ts` by asserting none of those terms appear anywhere on the page, before or after submission).

## 15. History and visibility

Self-history only in this milestone (`app/(app)/profile/market-predictions-tab.tsx`, wired as a **new**, distinctly-labeled "Market Predictions" tab — deliberately separate from the pre-existing "Predictions" tab, which already refers to legacy pool entries; conflating the two labels/components would violate this task's own "keep domain boundaries explicit" instruction). RLS permits only `user_id = auth.uid()` reads (§16). **Public prediction history — visiting another user's Market Predictions — is explicitly deferred**, per this task's own §15 escape hatch ("if only self-history is implemented initially, document that public history is deferred"). No public-visibility config flag was added for this either, for the same "no dead configuration" reasoning as §11: there is no code path today that would read it. A future milestone can add both the flag and the viewing surface together, informed by real usage of self-history first.

Market detail (`app/(app)/markets/[id]/page.tsx`) shows the user's own existing Prediction when one exists ("Your prediction: YES" / "You predicted at 31%") instead of the submission actions — clearly distinct from the page's own already-rendered *current* YES/NO percentages just above it, so prediction-time and current probability are never visually conflated (roadmap STEP 17).

## 16. Security / RLS

`predictions` (migration `20260101000141`): RLS enabled, one `select`-only policy (`user_id = auth.uid()`) granted to `authenticated`. **No `insert`/`update`/`delete` policy exists for `authenticated` at all** — matching this codebase's own established convention (`team_follows`, `entries`): RLS restricts reads, and every write goes through a Server Action's service-role client, authorized by `requireUser()` in the action itself. `grant select, insert, update, delete` to `service_role` only.

Who can do what:
- **Create**: any authenticated user, for themselves only (`requireUser()` supplies `user_id`; nothing client-supplied can set it to another user).
- **Read own**: any authenticated user, via RLS.
- **Read others'**: nobody, in this milestone (§15).
- **Grade**: only the grading job (service-role, invoked manually — §7).
- **Admin inspect**: gated by `requirePredictionDiagnosticsViewer()` (`lib/predictions/authorization.ts`) — a named capability boundary resolving against **configured** policy (`capability_policies`, migrations `20260101000143`/`144`), whose seeded value is super-admin-only. Read-only diagnostic page (`app/(admin)/admin/predictions/page.tsx`) — no edit/delete UI exists there or anywhere. **Final standing-rule remediation, Finding 1**: this page originally gated itself with `requireSuperAdmin()` directly, which is exactly the mistake Milestone 2's own final remediation (migration `20260101000140`) already fixed once for discovery taxonomy — "that an authorized check exists" is the true invariant; "which role satisfies it" is mutable policy that must not require a source change to alter. Fixed the same way, reusing the same mechanism: a new capability key `view_prediction_diagnostics` (closed set, may stay in code per that migration's own reasoning — `lib/auth/capability-policy.ts`'s `APP_CAPABILITIES`), changed via `pnpm set-capability-policy --capability view_prediction_diagnostics --roles ...`, no second authorization framework introduced. Nothing in the admin page contains the allowed-role list — verified structurally in `tests/integration/predictions.test.ts`.

**No new `SECURITY DEFINER` function was introduced.** Given this codebase's documented history of two prior EXECUTE-grant-drift incidents, every Milestone 3 write (`createPrediction`, `markPredictionGraded`, `recordGradedPredictionResult`, the notification helper) is a plain service-role table operation, not an RPC — consistent with Milestone 1/2's own established preference. `tests/integration/table-privilege-hygiene.test.ts`'s `REPRESENTATIVE_TABLES` now includes `predictions`, confirming `anon`/`authenticated` hold none of TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on it, matching every other table in this codebase.

## 17. Provider isolation

`lib/predictions/` never imports from `lib/prediction-markets/providers/` — every market read goes through Milestone 1's own repository (`getMarketById`) or Milestone 2's discovery layer, never a raw Polymarket response. The one place Polymarket-specific reasoning genuinely lives is `mapResolvedOutcome` itself (§8), which is *inside* the adapter boundary (`lib/prediction-markets/providers/polymarket/normalize.ts`) — exactly where Milestone 1's own architecture already requires provider-specific interpretation to live, not a new leak.

## 18. Mutation safety

`submitPredictionAction` (`lib/actions/predictions.ts`): authenticated (`requireUser()`, first line) → zod-validated (`submitPredictionSchema`) → market/eligibility/policy-checked → idempotency-key-protected create → `revalidatePath`. Idempotency mirrors the codebase's proven `create_pool_entry` pattern (client-generated key, pre-check, insert, race-safe fallback on the unique-constraint violation) without needing a `SECURITY DEFINER` function — unlike wallet debit + entry creation, no other table needs to change atomically alongside `predictions`, so a plain service-role insert is sufficient (§16). A double-click or network retry with the same key returns the original row, never a duplicate (`tests/integration/predictions.test.ts`).

**Known, accepted race window**: the "already predicted" (repeat-policy) check is a plain select-then-insert, not protected by a database constraint (§12 explains why a constraint would be the wrong tool). Two truly concurrent submissions from the same user on the same market, with repeat disabled, could in rare cases both succeed. This is a minor policy-enforcement edge case, not a correctness or financial-integrity issue (there is no money involved), and is judged not to warrant a heavier mechanism that would re-introduce the exact "policy fossilized as architecture" problem §12 avoids.

## 19. Hard-coding audit

| Item | Classification | Where it lives | Why (for remediated/reviewed items) |
|---|---|---|---|
| `predictions_selected_outcome_check` (YES/NO, exactly two outcomes) | True invariant | migration `20260101000141` | — |
| Prediction/Position structural separation | True invariant (architectural) | no `Position`/`Order`/`Trade` table exists anywhere | — |
| A `RESOLVED` market is never predictable | True invariant | `lib/predictions/policy.ts`'s `checkMarketEligibility`, checked before policy | — |
| `market_id` is a soft reference, not a FK | True invariant (architectural preservation decision) | migration `20260101000141`, §4 | — |
| Lifecycle states (`PENDING`/`GRADED`) and their one-way transition | True invariant | migration check constraints + `lib/predictions/grading.ts` | — |
| Grading reads only normalized Market data, never raw provider fields | True invariant (provider boundary) | `lib/predictions/grading.ts`'s own imports | — |
| Repeat-prediction allowed? | Configurable product policy | `platform_settings.prediction_allow_repeat` | — |
| Prediction cutoff | Configurable operational policy | `platform_settings.prediction_cutoff_minutes_before_close` | — |
| Stale/unavailable-price eligibility | Configurable operational policy | `platform_settings.prediction_allow_{stale,unavailable}_price` | — |
| Closed-market eligibility | Configurable product policy | `platform_settings.prediction_allow_closed_market` | — |
| Confirmation/action copy ("Make your prediction", "You predicted YES at 31%") | Reviewed, judged not to need a CMS layer | `components/predictions/*`, matching Milestone 2's own "small fixed set of strings" judgment | — |
| Ineligibility copy | Consolidated, not duplicated | `lib/predictions/copy.ts`, shared by the action and the detail page's pre-submission display | — |
| `mapResolvedOutcome`'s 1/0 clean-settle rule | Provider-specific implementation detail | isolated inside `lib/prediction-markets/providers/polymarket/normalize.ts` | — |
| Correct/incorrect counts | True invariant to *have* them at all (roadmap-mandated minimum hook, straightforward factual aggregates) | `user_profiles.prediction_{correct,incorrect}_count`, migration `20260101000142` | — |
| **Prediction diagnostics authorization** (which role may view `app/(admin)/admin/predictions/page.tsx`) | Configurable authorization policy — **remediated** | `capability_policies` (migrations `20260101000143`/`144`), read by `lib/auth/capabilities.ts`, asked for by `requirePredictionDiagnosticsViewer()` | See §16/Finding 1: previously `requireSuperAdmin()` directly; fixed the same way Milestone 2's own final remediation fixed the identical mistake for discovery taxonomy. |
| **Streak semantics** (`current_streak`/`best_streak` — what increments/resets/preserves them) | Was silently-decided product policy hard-coded as behavior — **remediated by deferral, not configuration** | N/A — removed from all Milestone 3 application code; `user_profiles.prediction_{current,best}_streak` remain in schema (migration `20260101000142`), commented as reserved (migration `20260101000145`) | See §9/Finding 2: the definition itself (not just its values) was undecided product policy reserved for roadmap Milestone 8's founder-reviewed reputation algorithm — not something a five-knob config table can safely encode without inventing the algorithm by accident. |
| **Notification enablement** (whether `prediction_graded` fires at all) | Configurable operational policy — **remediated a second time** | `platform_settings.prediction_notifications_enabled`, migration `20260101000146` | **Correction**: an earlier pass classified this as a true invariant on the reasoning "no other notification type in this codebase is configurable either" — existing precedent is not proof of invariance, and this task's own instructions named that exact reasoning as insufficient. A founder could reasonably want to silence grading notifications (e.g. during a migration) without a deploy. Fixed the same way every other Milestone 3 policy knob was: `platform_settings`, `pnpm set-prediction-policy`. |
| **Per-result notification triggers** (`CORRECT`/`INCORRECT`/`VOID`) | Configurable product policy — **remediated a second time** | `platform_settings.prediction_notify_on_{correct,incorrect,void}`, migration `20260101000146` | Same correction as above, applied per result. Defaults preserve the prior hard-coded behavior (all three notify) exactly — only *where* the decision lives changed. |
| Notification-policy fail mode (missing/malformed policy, DB read error) | True invariant (deliberately fail-**closed**, opposite of eligibility policy's fail-open) | `lib/predictions/policy.ts`'s `getPredictionNotificationPolicy`/`shouldNotifyForResult` | An optional, best-effort side effect must never be sent on unverifiable policy — see §10. Grading's own success is unaffected either way (a separate, also-true invariant). |
| **Notification title/body wording** (correct/incorrect/void) | Configurable product policy — **remediated a third time** | `platform_settings.prediction_notify_{title,body}_{correct,incorrect,void}`, migration `20260101000147` | **Correction**: an earlier pass classified this as presentation code / a one-time copywriting decision — the same "existing precedent isn't proof of invariance" mistake as the enablement/trigger booleans, this time applied to wording instead of booleans. A founder could reasonably want to reword these without a deploy. Fixed the same way: `platform_settings`, `pnpm set-prediction-policy`. Fails safe to built-in default wording (not "don't send") on a missing/malformed value — see §10. |
| `{{question}}` placeholder substitution mechanism | True invariant (architectural) — a plain literal string replace, never an expression language | `lib/notifications/predictions.ts`'s `renderNotificationCopy` | The *mechanism* (how substitution happens) is fixed code, exactly like the discovery category-matching algorithm's own precedent; only the *template text* using that mechanism is configurable. Storing executable expressions instead of plain text was explicitly out of scope for this remediation (no CMS). |

**Deliberately NOT configured** (would be dead configuration — no consuming code path exists): per-user daily/rate limits, a separate edit/cancel policy, uncategorized-market eligibility, public-history visibility, per-notification-type enablement. See §11/§15/§10 for the reasoning behind each.

**Founder/admin changes requiring a deployment after this milestone**: none of the five eligibility knobs, the correct/incorrect counters' *existence*, whether/which results notify, the notification wording, or who may view Prediction diagnostics. The true architectural items in the table above (the outcome enum, the lifecycle states, the soft-reference decision, the provider boundary, the capability-key/role-vocabulary closed sets, the `{{question}}` substitution mechanism) all genuinely require a code change by their nature — none of them is mutable policy left embedded by omission. Streak *semantics* are the one item this remediation found and removed rather than configured — see the row above.

## 20. Known limitations

- The read-then-write result-count update (§9) is not atomic — safe only because grading runs sequentially, single-process, unscheduled.
- Streak/reputation display was removed from the profile history tab as part of the final standing-rule remediation (§9, Finding 2) — a future Milestone 8 task will need to design and re-introduce it deliberately, with a founder-reviewed definition, rather than resuming the deferred columns as-is.
- Grading never handles a provider resolution reversal after a Prediction is already `GRADED` (§13) — deliberate, not silently unhandled.
- A rare concurrent-submission race can bypass the repeat-prediction policy (§18) — accepted, not engineered around, for the reasons given there.
- No retroactive-notification capability exists (§10) — if an operator disables notifications, grading continues to correctly persist results and aggregates for the predictions graded during that window, but nobody is ever notified for them, even after re-enabling. This is the deliberate, documented Milestone 3 behavior this remediation's own instructions named as the default expectation, not an oversight.
- `mapResolvedOutcome` (§8) depends on Polymarket's `outcomePrices` settling cleanly to exactly 1/0; some very old (pre-2021-era) markets in real Polymarket data do not show this pattern and will never be graded by this mechanism — left honestly unresolved rather than guessed at.
- As with Milestone 1/2, this development environment's browser-preview tooling is anchored to an unrelated project directory — functional verification relied on the full automated suite (`tests/unit/predictions/*`, `tests/integration/predictions.test.ts`, `tests/e2e/predictions-flow.spec.ts`), not a manual browser session.
- `next dev`'s own module-compilation contention under many parallel Playwright workers produced transient, non-deterministic `ECONNRESET`/`MODULE_UNPARSABLE` server-log noise during this milestone's E2E runs (also observed in Milestone 2's own verification) — never a real test failure on repeat runs; not present in a production build.

## 21. Explicit Milestone 4 boundary

Nothing in this milestone creates, references, or assumes an `Order`, a `Trade`, a `Position`, a wallet, a signing key, a custody model, a builder fee, or any authenticated Polymarket functionality. The custody/signing/compliance/geofencing/account-model decisions remain entirely unresolved, exactly as `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` Milestone 4 — the Execution Architecture hard gate — requires. This milestone's `Prediction` domain and its reputation hooks are designed to mature independently of that gate, per the roadmap's own dependency graph (§8 there: Milestone 3 can proceed and even feed Milestone 8's reputation-algorithm research before Milestone 4 is ever exited).
