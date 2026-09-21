# Execution Operational Safety — Milestone 5.5

**Status**: Implements `docs/PRODUCT_TRANSFORMATION_ROADMAP.md`'s intermediate engineering milestone between Milestone 5 (Simulated Execution) and Milestone 6 (Real Order Execution) — **Execution Controls, Reconciliation & Operational Safety**. This milestone builds provider-neutral operational infrastructure (kill switches, rollout cohorts, execution limits, provider health/circuit breaking, durable audit events, correlation IDs, a failure taxonomy, and a reconciliation framework) around Brohda's **existing simulated-execution flow** — it does not authorize or implement real-money execution, signing, custody, wallets, Session Keys, Builder credentials, provider order mutation, or real financial exposure. **Milestone 6 remains blocked** by the unresolved founder/counsel/provider decisions documented in `docs/architecture/milestone-6-readiness.md`.

> If you are reading this to decide whether Brohda may place a real order: **no.** Nothing in this milestone changes that answer. This milestone exists so that whenever Milestone 6 is eventually authorized, it plugs a real provider adapter into a safety framework that already exists and has already been tested — not so that Milestone 6 can start sooner.

---

## 1. Milestone scope

**In scope**: kill switches (§3), rollout/cohort controls (§4), a provider-neutral eligibility framework (§5), execution limits (§6), provider health and circuit breaking (§7-8), durable audit events (§9), correlation IDs (§10), a failure taxonomy (§11), a reconciliation framework exercised against simulated provider state (§12-13), incident-control primitives (§14), a protected admin operational surface (§15-16), structured observability (§17), a deterministic simulation test harness (§18), and reduced brittleness in the existing live-provider test dependency (§19).

**Explicitly out of scope** (§20 has the full negative checklist): wallet creation/funding/withdrawal, Session Key creation/storage, private-key storage/signing, Builder credentials, authenticated order placement/cancellation, any real provider mutation, real financial exposure, real Positions/Fills/Trades, custody, KYC/sanctions vendor integration, legal geofencing conclusions, and production execution enablement. No `placeRealOrder()` function, hidden or otherwise, exists anywhere in this codebase.

**Baseline this milestone started from**: branch `brohda/prediction-network-m0-m2`, HEAD `92e99fb78fdd8eb95d89447c41ecd9df09eee994` (unchanged throughout), local migration head `20260101000159` (Milestone 5's rate-limit remediation plus the Milestone 6 readiness/decision-gate documentation task, which added no code). See the completion report for full workspace-integrity detail.

---

## 2. Safety-control architecture — the control plane

**Entry point**: `lib/execution/control-plane.ts`'s `checkExecutionControlPlane(input, policy)`. Both `requestQuote` and `confirmSimulatedExecution` (`lib/execution/quote-service.ts`) call it as their very first substantive check — before fetching a provider snapshot, before computing a quote, before persisting anything. A future real-execution flow calls the exact same function, with the exact same signature, before any provider mutation; nothing about this function is simulation-specific.

**Decision model**: given `{userId, provider, marketId, jurisdiction}`, the control plane (1) resolves the user's current cohort memberships (`lib/execution/cohorts.ts`'s `getUserCohortKeys`), (2) fetches every currently-enabled kill switch (`lib/execution/kill-switches.ts`'s `listActiveKillSwitches`), (3) filters to the ones that are genuinely applicable and unexpired for this specific request (`switchIsApplicable`), (4) picks the highest-precedence applicable switch if any (§3), and if none blocks, (5) checks the rollout-mode gate (§4). It returns either `{allowed: true, cohortKeys}` or `{allowed: false, reason: "EXECUTION_DISABLED" | "ROLLOUT_BLOCKED", blockedBySwitch?}`.

**Why fetch-all-then-filter-in-memory, not a targeted query**: an earlier version of this module built a hand-crafted PostgREST OR-filter query to fetch only switches whose target matched the request. During this milestone's own E2E verification, that query silently matched nothing (a real bug this milestone caught in itself, not shipped). Kill switches are expected to be a small, purely operational table — fetching every enabled row and filtering with plain, obviously-correct TypeScript is simpler and safer than a clever query, and is fast enough at this data volume. This is documented here specifically so nobody "optimizes" it back into a fragile filter string later without re-deriving why it was avoided.

**Fail-safe behavior**: if resolving cohort memberships or listing active switches throws (a database error), the control plane returns `{allowed: false, reason: "EXECUTION_DISABLED"}` — **fail closed**. This is a deliberate divergence from `getExecutionPolicy()`'s own fail-open convention (which guards generic product configuration, where a transient read failure is a platform-wide incident bigger than one feature). The control plane guards an operator's explicit "stop this" signal; failing open here would silently defeat the purpose of having a kill switch at all.

---

## 3. Kill-switch model

**Storage**: `execution_kill_switches` (migration `20260101000153`). One row per switch instance; rows are never hard-deleted — disabling a switch sets `enabled = false, disabled_at, disabled_by` (soft-disable), preserving full history in the row itself. A database check constraint (`execution_kill_switches_disabled_consistency`) enforces that a disabled row always carries a `disabled_at` timestamp.

**Scopes** (a closed, hard-coded vocabulary — a true invariant; adding a scope is a genuine application change): `GLOBAL`, `PROVIDER`, `JURISDICTION`, `MARKET`, `USER`, `COHORT`. `target` is a soft-referenced free-text column whose meaning depends on scope (null only for `GLOBAL`); a check constraint enforces the null/non-null pairing.

**Fields**: `scope`, `target`, `enabled`, `reason` (required, non-empty), `note` (optional), `created_by`, `created_at`, `expires_at` (optional), `disabled_by`/`disabled_at` (populated on disable).

**Precedence** (`lib/execution/kill-switches.ts`'s `pickHighestPrecedenceSwitch`, and `SCOPE_PRECEDENCE`): **`GLOBAL` > `PROVIDER` > `JURISDICTION` > `USER` > `MARKET` > `COHORT`**. This is *derived*, not the task's own example order copied blindly: `GLOBAL` is definitionally the broadest; the remaining order reflects "how much of the platform this affects" (a `PROVIDER` outage affects every user of that provider; a `JURISDICTION` block affects every user there; a single `USER` block is narrower than either; a `MARKET` block affects every user of one market, narrower still since markets have less blast radius than a whole user; `COHORT` is the narrowest and most experimental in nature). This ordering only determines which single reason is surfaced when multiple switches happen to match the same request — it never affects the allow/deny outcome itself, since **any** applicable enabled switch blocks the request regardless of precedence.

**Expiration**: `expires_at`, optional. `switchIsApplicable` in `control-plane.ts` treats an expired switch as inapplicable — it is not deleted or auto-disabled, it simply stops blocking, and its row remains as history.

**Audit**: every create/disable action writes an `execution_audit_events` row (`KILL_SWITCH_ACTIVATED`/`KILL_SWITCH_DEACTIVATED`) via `lib/actions/execution-operations.ts`'s Server Actions.

**Configurable without deployment**: yes — every field is data, created/disabled through the admin surface (§15) or directly via `capability`-gated Server Actions; no scope/target/reason value is hard-coded anywhere in application code.

---

## 4. Rollout/cohort model

**Storage**: `execution_cohorts` + `execution_cohort_members` (migration `20260101000153`).

**Modes**: `ALLOWLIST` (explicit `execution_cohort_members` rows) and `PERCENTAGE` (deterministic hash-based assignment). STEP 8's own instruction against overbuilding experimentation infrastructure is respected — there is no traffic-splitting beyond a single deterministic percentage per cohort, no multivariate testing, no cohort hierarchy.

**Determinism (STEP 9)**: `lib/execution/cohorts.ts`'s `hashToPercentageBucket(seed, userId)` computes `SHA-256(seed:userId)`, takes the first 4 bytes as an unsigned integer, reduces mod 100. The same `(seed, userId)` pair **always** produces the same bucket — never `Math.random()`, never re-evaluated per request. Raising a cohort's configured `percentage` (without changing its `rolloutSeed`) only ever **adds** users to the cohort; it never removes a user who was already included, since a user's bucket number never changes — proven in `tests/unit/execution/cohort-determinism.test.ts`.

**Rollout-mode gate**: `platform_settings.execution_rollout_mode` (`'OPEN'` default, or `'COHORT_RESTRICTED'`). When `OPEN` (Milestone 5's existing behavior, unchanged), every otherwise-eligible user may proceed regardless of cohort membership — cohorts exist but are not yet gating anything. When `COHORT_RESTRICTED`, a user must be a member of at least one currently-enabled, currently-in-window cohort or the control plane denies with `ROLLOUT_BLOCKED`. This is the "cohort policy" step in the control-plane's own precedence description (§2) — an **allowlist** gate, the opposite polarity from kill switches' **blocklist** semantics.

**Configuration**: `execution_rollout_mode` lives in `platform_settings` (a genuinely global, singleton value); cohort definitions and membership live in their own dedicated tables (§21's data-shape reasoning).

---

## 5. Execution eligibility framework

**Module**: `lib/execution/eligibility.ts`. Makes **no legal conclusions** — it composes whatever compliance state is already known into one decision, and defines the one rule that must never move: `evaluateComplianceState(state, toleratesUnknown)` — `NOT_REQUIRED`/`APPROVED` always pass, `BLOCKED`/`PENDING` always fail (a `PENDING` review is not yet a "yes"), and `UNKNOWN` fails **unless** the caller explicitly opts in to tolerating it.

**Compliance states** (`ComplianceState`, `lib/execution/types.ts`): `UNKNOWN`, `NOT_REQUIRED`, `PENDING`, `APPROVED`, `BLOCKED` — applied uniformly to jurisdiction, KYC, AML, sanctions, and age signals, none of which this milestone resolves (they remain `docs/legal/milestone-6-counsel-brief.md`'s open questions).

**Composition** (`evaluateExecutionEligibility`): takes every named signal (`authenticated`, `simulationEnabled`, `killSwitchAllowed`, `rolloutAllowed`, the five compliance states, `providerAccount`, `marketEligible`, `withinLimits`) plus a caller-supplied `toleratesUnknownCompliance` flag, and returns `{eligible, signals, failedSignal}` — `signals` always reflects every input regardless of which one failed first, so a caller (or an admin diagnostic) can see the complete picture, not just the first denial.

**Simulation vs. real execution (the one invariant this framework exists to protect)**: `platform_settings.execution_simulation_tolerate_unknown_compliance` (default `true`) is a genuinely configurable value **for simulation only** — simulation has no real financial exposure, so tolerating an unresolved compliance dimension is a reasonable default. **A hypothetical real-execution caller must pass `toleratesUnknownCompliance: false` as a hard-coded literal, never read from this configuration column.** This is the one deliberate exception to the standing "don't hard-code" rule: the fail-closed-on-`UNKNOWN` behavior for real money is a true safety invariant, not a value that could reasonably change without changing the architecture. No `"REAL"` execution mode branch exists in this codebase — the invariant is enforced by *never building the caller that would need to violate it*, not by a runtime flag that could be flipped.

**Today's actual wiring**: Milestone 5's own `checkExecutionEligibility` (`lib/execution/policy.ts`, market/amount/freshness checks) and the new control-plane/limits checks (§2/§6) are wired directly into `quote-service.ts`. `evaluateExecutionEligibility` is the general-purpose, fully-unit-tested (`tests/unit/execution/eligibility.test.ts`) composition function Milestone 6 is expected to call directly once real compliance signals exist — it was deliberately **not** force-retrofitted into the existing, already-well-tested Milestone 5 flow, to avoid a risky rewrite of proven code for a framework whose real inputs don't exist yet.

---

## 6. Execution limits

**Storage**: `execution_limits` (migration `20260101000153`). Scopes: `GLOBAL`, `USER`, `COHORT`, `JURISDICTION`, `PROVIDER`. Types: `PER_ORDER_AMOUNT_CENTS`, `DAILY_AMOUNT_CENTS`, `ROLLING_AMOUNT_CENTS` (requires `window_seconds`), `DAILY_ORDER_COUNT` — the smallest set that supports Milestone 6 without forcing a redesign (STEP 12's own instruction against implementing every conceivable limit type).

**Evaluator**: `lib/execution/limits.ts`'s `evaluateExecutionLimits({userId, cohortKeys, provider, jurisdiction, requestedAmountCents, now})`. Fetches every enabled limit whose scope/target applies (`GLOBAL` always; `USER`/`PROVIDER`/`JURISDICTION`/`COHORT` when their target matches), computes the observed value for each (the request amount itself for `PER_ORDER`; a live query against `order_intents` for the daily/rolling types), and returns `{allowed, violations}` where each violation names its `limitId`, `scope`, `limitType`, `thresholdValue`, and `observedValue` — never leaking internal financial/security detail beyond what the operator who configured the limit already knows.

**Usage source — a true invariant, not a configurable choice**: usage is counted only from `order_intents` rows in the `SIMULATED_FILLED` lifecycle state (`confirmed_at` scoped to the relevant window). A rejected or still-pending attempt never represents real exposure — this is a domain fact about what "usage" means, mirrored directly from a future real-execution equivalent that would count real Fills the same way, not an operator knob.

**Atomic enforcement**: each limit type's observed-value query reads current state at evaluation time and is re-evaluated on every request (both quote-request and confirmation time in `quote-service.ts`) — there is no separate reservation/lock step in Milestone 5.5, matching the "smallest architecture" instruction; a genuinely concurrent double-submission race is bounded by the same idempotency-key mechanism Milestone 5 already proved for `order_intents`, not a new locking primitive this milestone introduces.

**Configuration**: every numeric threshold and window lives in `execution_limits` rows, created via the admin surface (§15) — no limit type or value is a source-code constant.

---

## 7. Provider health

**Storage**: `execution_provider_health` (migration `20260101000154`) — one row per provider, combining circuit-breaker persisted state and a manual override into a single operational concept (avoiding a config-junk-drawer split across two tables for what is really one question: "is this provider safe to call right now").

**States** (`ProviderHealthStatus`, derived, never stored directly): `HEALTHY`, `DEGRADED`, `UNAVAILABLE`, `MANUALLY_DISABLED`. `deriveProviderHealthStatus` (`lib/execution/provider-health.ts`) computes it from the row: `manuallyDisabled` always wins (→ `MANUALLY_DISABLED`); else `circuitState === 'OPEN'` → `UNAVAILABLE`; `'HALF_OPEN'` → `DEGRADED`; `'CLOSED'` → `HEALTHY`.

**Health inputs**: consecutive read failures within a configurable observation window (§8); a manual operator override (§15/§16), independent of the automatic circuit-breaker state. Latency-based degradation and reconciliation-failure-driven degradation are **not** implemented in Milestone 5.5 — noted as a known limitation (§22 of the completion report), not silently pretended to exist.

**Manual override**: `manuallyDisabled`, `manualReason`, `manualSetBy`, `manualSetAt` — a database check constraint enforces all four travel together (a disabled row always has a reason and an actor; an enabled row has none).

---

## 8. Circuit breaker

**States**: `CLOSED`, `OPEN`, `HALF_OPEN` — the standard vocabulary, kept rather than renamed, since it already correctly names the concept and this codebase has no better existing convention for it.

**Pure decision logic** (`lib/execution/provider-health.ts`, fully unit-tested with no I/O): `decideCallAllowed(record, now)` — `CLOSED`/`HALF_OPEN` always allow; `OPEN` allows only once the cooldown (`halfOpenProbeAt`) has elapsed, transitioning to `HALF_OPEN` for exactly that one probe; `manuallyDisabled` denies unconditionally, checked first.

**Threshold / window / cooldown / probes**: `platform_settings.execution_circuit_breaker_failure_threshold` (default 5), `execution_circuit_breaker_observation_window_seconds` (default 60), `execution_circuit_breaker_cooldown_seconds` (default 30), `execution_circuit_breaker_half_open_max_probes` (default 1) — migration `20260101000156`. All four are genuinely mutable operational policy; none is a source-code constant.

**Failure/success recording**: `recordProviderFailure(provider, policy, now)` increments `consecutiveFailures` (reset if the previous failure fell outside the observation window), opens the breaker once the threshold is reached, and — a HALF_OPEN-specific rule — a failed probe re-opens immediately without needing the full threshold again (a single bad probe is sufficient evidence the provider is still unhealthy). `recordProviderSuccess` closes the breaker and resets the failure count.

**Exercised against**: read-only Polymarket order-book requests (`lib/execution/providers/polymarket/adapter.ts`'s `getExecutableSnapshot`, wrapped around exactly the network I/O boundary — `fetchOrderBook` — never the "no CLOB token id recorded for this market" branch, which is a data-availability fact, not a provider-health signal) and simulated reconciliation operations (§12, exercised via the fixture provider-state source, never a real network call). It does **not** wrap any real provider mutation, because none exists.

---

## 9. Provider outage behavior

When the breaker is `OPEN` (or the provider is manually disabled), `isProviderCallAllowed` returns `false` **before** the network call is attempted, and `getExecutableSnapshot` returns `null` immediately — the exact same "no snapshot" signal Milestone 5's own `checkExecutionEligibility` already treats as `PROVIDER_UNAVAILABLE`. Discovery and Prediction are structurally unaffected — neither imports anything from `lib/execution/`, so a Polymarket outage that trips the execution circuit breaker has zero effect on Discovery's own cached-data continuation policy or Prediction's own independent submission flow. Consumer copy never exposes the breaker's existence, its state name, or any CLOB-specific error — `lib/execution/copy.ts` maps every reason to the same plain, pre-existing "we can't reach live pricing" message regardless of whether the underlying cause was a one-off network failure or a tripped breaker.

---

## 10. Audit-event model

**Storage**: `execution_audit_events` (migration `20260101000154`) — a dedicated table, not an overload of the existing generic `audit_logs` table (`lib/audit/log.ts`), because that table is shaped for admin before/after mutation diffs, not a correlation-threaded business-event stream a future incident investigation needs to query by correlation ID, market, quote, or order intent.

**Vocabulary** (`ExecutionAuditEventType`, `lib/execution/types.ts`) — reviewed down from the task's own example list to events this codebase actually emits: `QUOTE_REQUESTED`, `QUOTE_CREATED`, `QUOTE_REJECTED`, `ORDER_INTENT_CONFIRMED`, `SIMULATION_FILLED`, `SIMULATION_REJECTED`, `EXECUTION_ELIGIBILITY_DENIED`, `LIMIT_DENIED`, `KILL_SWITCH_ACTIVATED`, `KILL_SWITCH_DEACTIVATED`, `PROVIDER_HEALTH_CHANGED`, `CIRCUIT_BREAKER_OPENED`, `CIRCUIT_BREAKER_CLOSED`, `RECONCILIATION_STARTED`, `RECONCILIATION_COMPLETED`, `RECONCILIATION_MISMATCH`, `POLICY_CHANGED`.

**Fields**: `id`, `event_type`, `occurred_at`, `correlation_id` (nullable — not every event belongs to one user journey), `actor_user_id`, `market_id`, `quote_id`, `order_intent_id`, `provider`, `severity` (`INFO`/`WARN`/`ERROR`/`CRITICAL`), `metadata` (jsonb).

**Secret redaction**: `lib/execution/audit.ts`'s `recordAuditEvent` recursively strips any metadata key matching `/key|secret|credential|signature|token|password|private/i` before insert, regardless of caller intent — defense in depth, since no legitimate execution event should ever need to log a private key, Session Key, raw credential, or signature (none of which exist in this milestone at all). Proven in `tests/unit/execution/audit-redaction.test.ts`, including nested objects and arrays.

**Append-only**: enforced at the **database grant level**, not merely by convention — `service_role` is granted `select, insert` only on `execution_audit_events`, never `update` or `delete`. Nothing in this codebase, including server code, can rewrite a past event. Verified in `tests/integration/execution-operations.test.ts`.

**Failure isolation**: an audit-write failure (e.g. the table is briefly unreachable) is logged to stderr and swallowed — it must never block the execution flow it is observing, matching this codebase's own established tolerance for logging-adjacent failures elsewhere.

---

## 11. Correlation IDs

**Ownership**: generated once, by `lib/execution/correlation.ts`'s `generateCorrelationId()` (`crypto.randomUUID()`), at the very start of `requestQuote` — before the market is even fetched, so even a denied quote request is traceable. Stored on `execution_quotes.correlation_id` (migration `20260101000159`), inherited (never regenerated) onto the confirming `order_intents.correlation_id`, and threaded through every `execution_audit_events` row for that journey.

**Survives retries**: a duplicate confirmation attempt (same idempotency key) resolves to the same already-created `OrderIntent` row, which was created with the same Quote's correlation ID — a retry never mints a new one.

**Traceability proven**: `tests/integration/execution-operations.test.ts`'s "threads a correlation id across the events for one journey" test, and a dedicated test confirming a real `requestQuote()` denial (`QUOTE_REQUESTED` + `EXECUTION_ELIGIBILITY_DENIED`) shares exactly one correlation ID.

---

## 12. Failure taxonomy

**Module**: `lib/execution/failure-taxonomy.ts`'s `FAILURE_CLASSIFICATION` — a `Record` mapping every reason code `quote-service.ts` can return (both `ExecutionIneligibleReason` and `OrderIntentRejectionReason`, plus the two confirmation-only early-return reasons) to one of four classes:

- **`CONSUMER_CORRECTABLE`**: `AMOUNT_OUT_OF_RANGE`, `QUOTE_EXPIRED`, `QUOTE_NOT_FOUND`, `SLIPPAGE_TOO_HIGH`, `INSUFFICIENT_LIQUIDITY` — the user can plausibly fix this by changing input or retrying shortly.
- **`POLICY_DENIAL`**: `SIMULATION_DISABLED`, `MARKET_CLOSED`, `MARKET_INACTIVE`, `NOT_ELIGIBLE`, `EXECUTION_DISABLED`, `ROLLOUT_BLOCKED`, `LIMIT_EXCEEDED` — an operator/product decision, never implying a bug.
- **`PROVIDER_TEMPORARY`**: `STALE_DATA`, `PROVIDER_UNAVAILABLE` — expected to resolve on its own; alert-worthy only if sustained.
- **`SECURITY_DENIAL`**: `MARKET_NOT_FOUND` — usually a stale or tampered client reference (the threat model's own market-ID-substitution class), not something a retry with the same input fixes.

**Milestone 5.5's own new reason codes** (`EXECUTION_DISABLED`, `ROLLOUT_BLOCKED`, `LIMIT_EXCEEDED`) are only ever returned as an in-memory, pre-persistence denial — exactly like `NOT_ELIGIBLE`/`QUOTE_EXPIRED` already were — never written to `order_intents.result_reason`'s database-constrained column, so no migration to that check constraint was needed.

**Consumer copy stays separate**: `lib/execution/copy.ts`'s `copyForIneligible`/`copyForRejection` map each reason to plain, non-jargon text — reviewed and configured independently of this internal classification, per the standing rule's own instruction that consumer copy and internal failure identity must be separable.

---

## 13. Reconciliation

**Principle** (restated from `docs/architecture/execution-architecture-gate.md` §18, now actually exercised): Brohda is **never** assumed authoritative. A reconciliation compares **Brohda's expected `OrderIntent` state** against **a simulated, authoritative provider-state source** — real in the sense that the algorithm and its data model are the ones Milestone 6 will reuse, simulated in the sense that no real provider is ever called.

**Authoritative source** (`lib/execution/reconciliation/simulated-provider-adapter.ts`): `createFixtureProviderStateSource(fixtures)` — a deterministic, explicitly-keyed test double used to exercise every scenario on demand (never randomized); `defaultSimulatedProviderStateSource` — mirrors an `OrderIntent`'s own already-recorded terminal state 1:1, used for any real (simulated) order intent with no fixture registered, which should always reconcile as `IN_SYNC` (itself a correctness property this milestone's tests prove — the algorithm never invents a mismatch against unchanged data).

**Outcome vocabulary** (`SimulatedProviderOutcome`, `lib/execution/reconciliation/types.ts`, reviewed down to exactly what STEP 22 asks for): `ACCEPTED`, `REJECTED`, `MISSING`, `PARTIAL`, `CANCELLED`, `DUPLICATE`, `UNAVAILABLE`, `DELAYED`, `INCONSISTENT`.

**Decision table** (`lib/execution/reconciliation/engine.ts`'s `compareExpectedToAuthoritative` — pure, fully unit-tested):

| Authoritative outcome | Expected `CONFIRMED` (still pending) | Expected `SIMULATED_FILLED` | Expected `SIMULATED_REJECTED` |
|---|---|---|---|
| `UNAVAILABLE` / `DELAYED` | `PENDING` | `PENDING` | `PENDING` |
| `MISSING` | `PENDING` | `MISMATCH` | `MISMATCH` |
| `ACCEPTED` (matching amount) | `UPDATED` | `IN_SYNC` | `MISMATCH` |
| `ACCEPTED` (differing amount) | `UPDATED` | `MISMATCH` | `MISMATCH` |
| `REJECTED` | `UPDATED` | `MISMATCH` | `IN_SYNC` |
| `PARTIAL` (matching amount) | `UPDATED` | `IN_SYNC` | `MISMATCH` |
| `PARTIAL` (differing amount) | `UPDATED` | `MISMATCH` | `MISMATCH` |
| `CANCELLED` | `UPDATED` | `MISMATCH` | `IN_SYNC` |
| `DUPLICATE` | `MANUAL_REVIEW_REQUIRED` (always, regardless of expected state) | | |
| `INCONSISTENT` | `MISMATCH` (always) | | |

No ambiguous state is auto-"fixed" silently — a `DUPLICATE` report always escalates to a human, and any combination not explicitly recognized as safe falls to `MISMATCH`, never a guess.

---

## 14. Reconciliation policy, idempotency, and escalation

**Storage**: `execution_reconciliation_records` (migration `20260101000155`). Rows are **never overwritten**: a repeated reconciliation that finds the identical authoritative state and result as the latest existing record for that order intent writes nothing new (true idempotency — proven in `tests/integration/execution-operations.test.ts`); a genuinely changed comparison inserts a **new** row referencing the prior one via `previous_record_id`, preserving every previous mismatch as durable evidence rather than overwriting it.

**Manual-review escalation**: `platform_settings.execution_reconciliation_manual_review_after_mismatches` (default 2, migration `20260101000156`) — after this many **consecutive** `MISMATCH` results for the same order intent, the next mismatch escalates to `MANUAL_REVIEW_REQUIRED` instead of remaining a plain `MISMATCH`. A `MANUAL_REVIEW_REQUIRED` or unresolved `MISMATCH` row can later be resolved by an operator (`resolved_at`/`resolved_by`/`resolution_note`), the only fields ever updated on an existing row.

**No scheduler**: reconciliation is triggered manually (via the reconciliation engine's own function call, exercisable from a script or a future admin action) — STEP 25's own "no scheduler is required unless justified" instruction is respected; **no production scheduling is enabled**.

**What's configurable, what's invariant**: the manual-review threshold, and (if added later) any retry interval/count, are configurable operational policy. The decision table itself (§13), the "never auto-fix ambiguous state" rule, and "Brohda is never authoritative" are true invariants.

---

## 15. Incident controls and admin operations

**Incident controls** (STEP 28/29): global/provider/market/user disable all reuse the kill-switch framework (§3) directly — there is no separate "incident" table or mutation path, since a kill switch already **is** the audited, scoped, reversible primitive an incident response needs. Every kill-switch mutation (create or disable) already records actor, scope, target, reason, timestamp, and — for disable — the previous state (the row itself, since it's soft-disabled rather than deleted) via an `execution_audit_events` entry. No incident-control code mutates funds, because nothing in this milestone can.

**Admin route**: `/admin/execution-operations` (`app/(admin)/admin/execution-operations/page.tsx`). Shows: global execution/simulation/rollout-mode status, active kill switches (+ create/disable forms), rollout cohorts (+ create/enable-disable/membership forms), provider health (+ manual override form), execution limits (+ create/enable-disable forms), open reconciliation mismatches, and the 50 most recent execution audit events. **Kept operational, not a trading terminal**: no real-order controls, no wallet controls, no credential display, because none exist to control.

---

## 16. Authorization

**Capabilities** (three, matching STEP 31's "do not create more than necessary"): `view_execution_operations` (read the dashboard), `manage_execution_controls` (kill switches, limits, provider-health overrides), `manage_execution_rollout` (cohorts and membership). Added via migrations `20260101000157`/`20260101000158`, exactly mirroring `view_simulated_execution_diagnostics`'s own precedent — an enum value added in one migration (Postgres forbids using a new enum value in the same transaction that adds it), the default policy (`super_admin` for all three) seeded in the next.

**No direct role coupling**: `lib/execution/authorization.ts`'s `requireExecutionOperationsViewer`/`requireExecutionControlsManager`/`requireExecutionRolloutManager` each call `requireCapability(...)` — never `requireSuperAdmin()`. Verified structurally by `tests/integration/execution-operations.test.ts`'s "no direct role coupling" test (greps the page source for a literal role name or a direct auth-helper call).

**Policy mutation discipline** (STEP 32): every mutation in `lib/actions/execution-operations.ts` (1) requires the relevant capability, (2) validates input server-side via Zod (`lib/validations/execution-operations.ts`), (3) writes through the service-role repository layer only — the underlying tables have **no** `authenticated`/`anon` grant at all, so client-direct mutation is structurally impossible, not merely discouraged — and (4) records an audit event capturing the relevant previous/new state in safe metadata.

---

## 17. Observability

Every execution-domain code path that denies, blocks, or changes state emits a structured `execution_audit_events` row (§10) carrying `correlationId`, `severity`, `eventType`, `actorUserId` where applicable, `marketId`, `provider`, and safe metadata — this **is** Milestone 5.5's structured operational log, deliberately not layered on top of generic `console.log` calls that "cannot reliably answer operational questions later" (STEP 17's own phrase).

**Alert-worthy conditions** (documented, not wired to an external alerting vendor — none is already available/trivial in this codebase, so none was added, per STEP 38's own instruction): repeated `RECONCILIATION_MISMATCH`/`MANUAL_REVIEW_REQUIRED` for the same order intent; a `CIRCUIT_BREAKER` open transition; any `KILL_SWITCH_ACTIVATED` event (especially `GLOBAL`/`PROVIDER` scope); a sustained run of `EXECUTION_ELIGIBILITY_DENIED` events (may indicate a misconfigured switch or cohort rather than genuine policy); an unexpected `PROVIDER_HEALTH_CHANGED` to `MANUALLY_DISABLED` outside a known maintenance window.

---

## 18. Deterministic simulator / test harness

`lib/execution/reconciliation/simulated-provider-adapter.ts`'s `createFixtureProviderStateSource` takes an explicit `Record<orderIntentId, SimulatedProviderState>` map — every scenario in the decision table (§13) is exercised by constructing the exact fixture state the test needs, with **zero randomness** anywhere in the reconciliation test surface (`tests/unit/execution/reconciliation-engine.test.ts`, `tests/integration/execution-operations.test.ts`'s reconciliation describe block). Provider-health/circuit-breaker tests use the same discipline — `decideCallAllowed`/`recordProviderFailure`/`recordProviderSuccess` are exercised with explicit, controlled policy objects and timestamps, never real timers or real network calls.

---

## 19. Live read-only provider contract testing (STEP 27)

Milestone 5's own integration suite has one small, already-explicitly-labeled describe block (`tests/integration/execution.test.ts`'s "quote-service — live Polymarket read-only data (accepted external dependency)") that depends on a specific real, currently-active Polymarket market. Milestone 5.5 does **not** eliminate this — a genuine live-provider contract check remains available and necessary (no fixture can prove Polymarket's own API still behaves as documented).

**What Milestone 5.5 does instead of expanding that dependency**: every new kill-switch/cohort/limit/provider-health/reconciliation test (`tests/integration/execution-operations.test.ts`, 43 tests) is written against the control-plane, limits evaluator, provider-health functions, and reconciliation engine **directly** — none of them calls `requestQuote`/`confirmSimulatedExecution` against the real Polymarket adapter, because none of those layers needs a real provider at all (the control plane takes a plain provider-name string; limits read `order_intents` directly; provider health/circuit-breaking is exercised against its own persisted state; reconciliation is exercised against the fixture state source). The one exception — a dedicated test proving `requestQuote()` itself returns `EXECUTION_DISABLED` when a kill switch is active — deliberately seeds a market with a **fake, non-Polymarket provider name**, since the control-plane check runs before any provider call is even attempted. The Milestone 5.5 E2E test (`tests/e2e/execution-operations-flow.spec.ts`) does the same. **Net effect**: this milestone added 43 new integration tests and 2 new E2E tests without adding a single new live-provider dependency, and the existing live-dependency surface is unchanged and stays exactly as isolated and labeled as Milestone 5 left it.

---

## 20. Configuration model

Deliberately **not** a single config junk drawer — the shape of each concept determines where its data lives, per STEP 33's own instruction:

| Concept | Storage | Why |
|---|---|---|
| Singleton global execution/simulation/rollout-mode/circuit-breaker/compliance-tolerance/reconciliation-threshold policy | `platform_settings` (migrations `20260101000149`, `20260101000156`) | One row, one value each — genuinely global, no scoping dimension |
| Kill switches | `execution_kill_switches` (dedicated table) | Scoped, multi-row, needs its own precedence/history semantics |
| Rollout cohorts + membership | `execution_cohorts` / `execution_cohort_members` (dedicated tables) | Two related but distinct entities (a cohort's definition vs. its allowlist membership) |
| Execution limits | `execution_limits` (dedicated table) | Scoped, multi-row, needs its own type/threshold/window shape |
| Provider health | `execution_provider_health` (dedicated table, one row per provider) | A live, frequently-mutated operational state machine — not a good fit for a slowly-changing settings singleton |
| Audit events | `execution_audit_events` (dedicated, append-only table) | A growing event log, structurally different from every configuration table above |
| Reconciliation history | `execution_reconciliation_records` (dedicated table) | A growing, chained history, not configuration at all |

---

## 21. Security / RLS

Every new table enables RLS. **None** grants `authenticated` or `anon` any privilege at all — these are purely operational/admin tables with no per-user "own row" concept, unlike `execution_quotes`/`order_intents` (which do have an authenticated own-row `select` policy). `service_role` is granted exactly the privileges each table's own write pattern needs: `select, insert, update` for kill switches/cohorts/limits/provider-health (mutable, but never client-direct); `select, insert` **only** for `execution_audit_events` (append-only, enforced at the grant level, not by convention); `select, insert, update` for `execution_reconciliation_records` (update reserved for filling in `resolved_at`/`resolved_by`/`resolution_note` on an existing row — the substantive fields are never updated once written); `select, insert, delete` (plus `update`, added in a follow-up grant-fix migration `20260101000160` once this milestone's own test verification caught the upsert needing it) for `execution_cohort_members`.

**No `SECURITY DEFINER` function was introduced.** All writes go through the existing service-role-client pattern this codebase already established for `execution_quotes`/`order_intents`/`capability_policies`.

**Gate 1A privilege hygiene**: all seven new tables were added to `tests/integration/table-privilege-hygiene.test.ts`'s `REPRESENTATIVE_TABLES` list and pass the same automated grant-drift check every other table in this codebase is held to.

---

## 22. Explicit Milestone 6 boundary

Nothing in this milestone creates, references, or assumes: a real provider `Order`/`Fill`/`Trade`/`Position`, a wallet, a Session Key, a Builder credential, a private key, a real signature, a KYC/sanctions vendor integration, or a legal geography approval. No mutation endpoint to any real provider is called or implemented — the read-only `ExecutionQuoteProvider` interface (Milestone 5) is unchanged, and the circuit breaker/provider-health framework wraps exactly that same read-only boundary, never a hypothetical write one. The `ComplianceState` enum and the eligibility framework's `jurisdiction`/`kyc`/`aml`/`sanctions`/`age` signals are structural scaffolding only — every value fed into them in this milestone's own tests is `NOT_REQUIRED`/`UNKNOWN`, never a real legal determination. See the completion report's "Milestone 6 boundary audit" for the full explicit proof, and `docs/architecture/milestone-6-readiness.md` for what remains blocked and why.

**Milestone 5.5 builds operational safety infrastructure only. It does not authorize or implement real-money execution, signing, custody, wallets, Session Keys, Builder credentials, provider order mutation, or real financial exposure.**
