# Simulated Execution — Milestone 5

> **DEPRECATED (2026-09-21).** This document describes the abandoned Polymarket / real-money-execution product direction. It is historical only — see `docs/deprecated/polymarket-execution-direction-2026/README.md` and `docs/architecture/sports-prediction-network.md` for Brohda's current, sports-only direction. Nothing below reflects the active product.


**Status**: Implements `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` Milestone 5 — Simulated Execution, per the design already locked in `docs/architecture/execution-architecture-gate.md` (Milestone 4) and `docs/security/execution-threat-model.md`.

**Milestone 5 performs no real financial execution. Quote and OrderIntent records represent simulated execution only. No provider order, Fill, Position, wallet mutation, asset transfer, or financial exposure is created.**

**Milestone 6 remains blocked by the Execution Architecture Gate's unresolved founder/legal/compliance prerequisites.**

**Update**: Milestone 5.5 (`docs/architecture/execution-operational-safety.md`) has since built the provider-neutral operational safety layer (kill switches, rollout cohorts, execution limits, provider health/circuit breaking, durable audit events, correlation IDs, a failure taxonomy, and a reconciliation framework) around this milestone's own simulated-execution flow, wiring the control plane and limits directly into `requestQuote`/`confirmSimulatedExecution` below. Milestone 5.5 does not change anything documented in this file's own domain model — see that document for the full addition.

---

## 1. Scope

A user can, on an eligible market's detail page, choose YES or NO, enter a dollar amount, receive a server-computed Quote based on Polymarket's real read-only order book, review the estimated return/fees/slippage, and confirm — creating a permanent, structurally-marked-simulated `OrderIntent` record. No wallet is created or touched, no signature is produced, no provider mutation endpoint is called, and no money moves at any point. This validates the domain model, quote math, consumer UX, eligibility, idempotency, and failure handling Milestone 6 will need — without crossing into real execution.

## 2. Provider-neutral architecture

```
Brohda Market (Milestone 1)
   -> ExecutionQuoteProvider (lib/execution/types.ts)     read-only, no order placement/cancel method exists
   -> Polymarket execution adapter (lib/execution/providers/polymarket/)   isolates token ids, CLOB response shapes
   -> Polymarket CLOB read-only order-book endpoint
```

Deliberately a **separate** interface from Milestone 1's `PredictionMarketProvider` (`lib/prediction-markets/types.ts`) — that interface answers "what markets exist and what does Brohda currently believe about them" (a batch/ingestion concern); `ExecutionQuoteProvider` answers "what would executing right now look like" (a live, per-request concern with a completely different lifecycle and freshness requirement, per Milestone 4's own instruction to treat financial execution as higher-risk). Folding the two together would blur two different responsibilities and two different risk tiers into one interface. `lib/execution/provider-registry.ts` mirrors `lib/prediction-markets/provider-registry.ts`'s own routing discipline exactly — one provider registered today.

No CLOB token id, condition id, raw order-book JSON, signature type, or any other provider-specific concept crosses above `lib/execution/providers/polymarket/adapter.ts`. `ExecutableMarketSnapshot` (the adapter's return type) exposes only `currentPrice`, `askLevels` (already normalized to `{price, size}` and sorted ascending), `tickSize`, `minOrderSize`, and `snapshotAt`.

## 3. Quote domain

`lib/execution/types.ts`'s `ExecutionQuote`, persisted in `public.execution_quotes` (migration `20260101000148`). Fields: `id`, `userId`, `marketId` (soft reference, never a foreign key — same preservation pattern Milestone 3 established for Prediction→Market), `selectedSide`, `requestedAmountCents`, `currentPrice`, `effectivePrice`, `estimatedUnits`, `estimatedGrossReturnCents`, `providerFeeEstimateCents`, `brohdaFeeEstimateCents`, `totalFeeEstimateCents`, `estimatedSlippageBps`, `providerSnapshotAt`, `expiresAt`, `isSimulated` (always `true`, database-enforced via `check (is_simulated = true)`), `createdAt`. `estimatedUnits` (internal shares) is computed and stored but never rendered to the consumer — matching roadmap STEP 12's "hide unnecessary trading mechanics" instruction.

A Quote is **temporary and non-financial** by construction: it records an estimate, never a commitment, and creating one has no side effect beyond the row itself.

## 4. OrderIntent domain

`lib/execution/types.ts`'s `OrderIntent`, persisted in `public.order_intents` (same migration). This is **Brohda's own record that a user confirmed an intention to simulate execution** — explicitly not a provider `Order` (§20 below). Its economics (`quotedEffectivePrice`, `quotedEstimatedGrossReturnCents`, `quotedTotalFeeEstimateCents`, `quotedSlippageBps`, `quoteCreatedAt`, `quoteProviderSnapshotAt`) are a full **snapshot copied from the confirmed Quote at confirmation time** — `quoteId` itself is kept only for traceability/diagnostics, never as the row's source of truth, exactly mirroring how Prediction's `market_id` is a soft reference while the Prediction's own snapshot columns are authoritative. This means an `OrderIntent`'s history remains fully meaningful even if its originating `execution_quotes` row is later pruned (§7).

## 5. Prediction separation

Simulating execution **never reads or writes Prediction state**. `lib/execution/` has zero imports from `lib/predictions/`, and vice versa. A user may simulate execution on a market without ever having made a Prediction on it, and may make a Prediction without ever simulating execution — the two domains coexist on the same market-detail page in visually and structurally separate `Card`s (roadmap STEP 28), and the same separation carries through to history: Prediction history (`market-predictions-tab.tsx`), legacy pool history (`predictions-tab.tsx`), and simulated-execution history (`simulated-execution-tab.tsx`) are three distinct profile tabs, never merged.

## 6. Provider data source (read-only, live-verified)

Confirmed against official Polymarket documentation and a live call, both on 2026-09-16:

- `GET https://clob.polymarket.com/book?token_id=$TOKEN_ID` — unauthenticated, read-only (`docs.polymarket.com/market-data/prices-order-books`). Live response fields confirmed: `market`, `asset_id`, `timestamp`, `hash`, `bids`/`asks` (arrays of `{price, size}`; **asks are returned descending, best/lowest ask last** — `lib/execution/providers/polymarket/adapter.ts`'s `normalizeAskLevels` explicitly re-sorts ascending rather than assuming this), `min_order_size`, `tick_size`, `neg_risk`, `last_trade_price`.
- **A documented-vs-live discrepancy, noted rather than silently resolved**: the docs describe `tick_size`/`min_order_size` as decimal strings; a live response returned them as JSON numbers. The order-book client (`lib/execution/providers/polymarket/orderbook-client.ts`) accepts both defensively, the same discipline Milestone 1's own schema already applies to `liquidity`/`volume24hr`.
- The market's CLOB token id is not stored as its own column — it lives inside `markets.provider_metadata.clobTokenIds` (captured by Milestone 1's ingestion as part of the full raw Gamma object). `lib/prediction-markets/repository.ts`'s new `getMarketProviderMetadata()` is a second, equally narrow exception to "provider metadata is diagnostic-only" (the first being `categoryTags` in Milestone 2) — used exclusively by the execution adapter, never by any other caller.
- No mutation endpoint is called, referenced, or exists anywhere in this codebase for Polymarket execution.

## 7. Quote persistence decision

**Persisted temporarily**, not ephemeral/server-only and not permanent. Reasons: (a) idempotency — the confirmation flow needs a stable `quoteId` a client can reference and a server can re-validate against, which a purely in-memory or signed-token quote would make harder to audit; (b) auditability — a Quote row is what the admin diagnostics page and any future dispute investigation would need; (c) the confirmation flow explicitly re-fetches fresh provider data and compares it against the *stored* quote's economics (§14), which requires the original quote to still exist at read time. **Not retained forever** — no permanent-social-record status like Prediction. This milestone does not implement a cleanup/garbage-collection job for expired, never-confirmed quotes (a reasonable follow-up, not required for Milestone 5's own correctness, since RLS and the application-level expiry check make an old quote inert regardless of whether the row still physically exists) — documented as a known limitation (§25).

## 8. Amount semantics

The consumer enters a plain dollar **Amount** — never shares, contracts, or token quantity (roadmap STEP 8's own instruction, directly reusing the "no financial jargon" discipline already established for Prediction). Denomination: cents integers (`requested_amount_cents`), matching this codebase's existing `entry_fee_cents` convention — never a floating-point dollar value anywhere in the domain or database. Precision: whole cents; the UI accepts a decimal dollar input and rounds to the nearest cent before sending it to the server. Minimum/maximum are **configurable** (`platform_settings.execution_min_amount_cents`/`execution_max_amount_cents`, migration `20260101000149`) — never hard-coded dollar figures in code.

## 9. Fee model

Distinguished per Milestone 4's own architecture: **provider fee** (simulated assumption — Milestone 4's research confirmed only Polymarket's *builder-fee cap* (0–100bps taker / 0–50bps maker), not a live-readable exact provider fee for an arbitrary order, so this is explicitly a configured, labeled-simulated assumption, not authoritative provider data) and **Brohda fee** (entirely hypothetical, defaults to 0bps). Both are `platform_settings` basis-point columns (`execution_simulated_provider_fee_bps`/`execution_simulated_brohda_fee_bps`), applied to the requested amount in `lib/execution/quote-math.ts`'s `computeQuote`. **No numeric fee rate is hard-coded anywhere in application code.** Every fee shown to the consumer is labeled "simulated"/"estimated" in the UI copy (`components/execution/SimulateExecutionPanel.tsx`) — never presented as an authoritative or actually-charged amount.

## 10. Slippage model

**Not** `amount × current displayed probability` — `lib/execution/quote-math.ts`'s `computeQuote` walks the real ask-side depth levels (best price first) consuming size until the requested amount is filled, producing a genuine depth-weighted average execution price. Slippage (basis points) is the difference between that effective price and the snapshot's own best price. If the entire captured order book cannot fill the requested amount, `computeQuote` returns `{ ok: false, reason: "INSUFFICIENT_LIQUIDITY" }` rather than fabricating a fill beyond what the snapshot shows (roadmap STEP 10's explicit instruction) — surfaced to the consumer as a plain, honest "not enough simulated liquidity" message (`lib/execution/copy.ts`), never a silently-wrong number.

## 11. Quote expiry

Enforced server-side in `lib/execution/quote-service.ts`'s `confirmSimulatedExecution` (`now >= quote.expiresAt` → `QUOTE_EXPIRED`, no `OrderIntent` created). Duration is `platform_settings.execution_quote_expiry_seconds` (default 30) — **never a hard-coded `30` in a component or service**. The consumer UI shows the quote's own `expiresAt` and, on an expired-confirmation attempt, a clear "quote has expired — request a new one" message with a path back to the idle state (not a dead end).

## 12. Quote freshness — a distinct, stricter policy from discovery

Two independent concepts, deliberately not conflated: **Market/provider-data freshness** (`platform_settings.execution_data_freshness_max_seconds`, default 10 — how old the underlying order-book snapshot may be) and **Quote expiry** (`execution_quote_expiry_seconds`, default 30 — how long the *computed* Quote itself remains confirmable). A Quote can be well within its own expiry window while being computed from data that, by the time of confirmation, would already be stale under a *fresh* re-check — which is exactly why `confirmSimulatedExecution` re-fetches a **fresh** snapshot and re-checks *its* freshness independently at confirmation time (§14), rather than trusting the original quote's already-passed freshness check. This is deliberately **not** a reuse of Milestone 2's discovery freshness policy (`discovery_fresh_within_minutes`, measured in minutes) — execution's own policy is measured in **seconds**, a new, separately-configurable column set, matching Milestone 4's explicit instruction that financial execution demands a stricter standard than ordinary browsing.

## 13. Eligibility — separate from Prediction eligibility

`lib/execution/policy.ts`'s `checkExecutionEligibility` is a new, independent pure function — **not** a reuse of `lib/predictions/policy.ts`'s `checkMarketEligibility` (roadmap STEP 13's explicit instruction). Order of checks: simulation-enabled (policy) → market active (true invariant-adjacent: a market must be `ACTIVE` for simulated execution, stricter than Prediction's own allowance for `CLOSED` markets under configuration) → provider snapshot exists → provider-data freshness → amount in configured range. Liquidity sufficiency and slippage-tolerance are decided one layer up, in `lib/execution/quote-service.ts`, once an actual order-book walk (`computeQuote`) has run — they cannot be pure-function-checked without a snapshot in hand. No jurisdiction/geofencing check exists in Milestone 5 — Milestone 4's architecture gate document explicitly defers real geofencing to a later milestone, and this milestone does not fabricate a simulated one where none was requested, since doing so risks implying a legal-eligibility guarantee this milestone has no authority to make.

## 14. Confirmation — tamper resistance and recalculation policy

`lib/execution/quote-service.ts`'s `confirmSimulatedExecution` never trusts client-submitted economics — the client submits only a `quoteId` and an `idempotencyKey` (roadmap STEP 24). Every financially-relevant fact is re-derived server-side:
1. Load the Quote by id; if it doesn't exist **or belongs to a different user**, respond identically (`QUOTE_NOT_FOUND`) — never leaking whether the id was valid for someone else.
2. Reject if already past `expiresAt`.
3. Re-fetch the market and a **fresh** provider snapshot; reject on `MARKET_CLOSED`/`STALE_DATA`/`INSUFFICIENT_LIQUIDITY` exactly as a fresh quote request would.
4. Compare the fresh effective price against the *original* quote's stored effective price (`lib/execution/quote-math.ts`'s `priceMovementBps`). If the movement exceeds `platform_settings.execution_recalculation_tolerance_bps` (default 200 = 2%), the confirmation is rejected (`SLIPPAGE_TOO_HIGH`) — **the original quote's economics are never silently altered or re-priced** (roadmap STEP 25's explicit instruction); the user must request a new quote.
5. If within tolerance, the `OrderIntent` is created and immediately resolved `SIMULATED_FILLED`, snapshotting the **original** quote's numbers, never the fresh re-check's numbers.

## 15. Simulation lifecycle

`OrderIntent.lifecycleState`: `CONFIRMED` (transient — the moment a row is inserted, before its terminal outcome is decided) → `SIMULATED_FILLED` | `SIMULATED_REJECTED` (terminal). Milestone 5's own flow resolves this synchronously within the same request (no async provider round-trip exists yet), so every row a caller ever actually observes is already terminal — but `CONFIRMED` is a real, structurally-modeled state (not collapsed away) specifically so Milestone 6's eventual async real-provider round-trip can reuse this exact table/lifecycle shape without a redesign (this milestone's own "fundamental principle"). A database check constraint (`order_intents_result_requires_terminal_state`) enforces that a `CONFIRMED` row never carries a result, and a terminal row always does.

## 16. Failure-state vocabulary

Derived per `lib/execution/types.ts`'s `ExecutionIneligibleReason` (pre-quote failures) and `OrderIntentRejectionReason` (post-quote, at-confirmation failures): `SIMULATION_DISABLED`, `MARKET_NOT_FOUND`, `MARKET_CLOSED`, `MARKET_INACTIVE`, `STALE_DATA`, `PROVIDER_UNAVAILABLE`, `INSUFFICIENT_LIQUIDITY`, `AMOUNT_OUT_OF_RANGE`, `SLIPPAGE_TOO_HIGH`, `NOT_ELIGIBLE`. **Deliberately not randomly generated** — every failure a user can encounter is the deterministic output of a real policy/data check, never a manufactured demo failure rate (roadmap STEP 22's explicit instruction). Never a raw provider/internal message reaches the consumer — `lib/execution/copy.ts` centralizes every translation, mirroring `lib/predictions/copy.ts`'s own precedent.

## 17. Security / RLS

`execution_quotes`/`order_intents` (migration `20260101000148`): RLS enabled, one `select`-only policy (`user_id = auth.uid()`) granted to `authenticated` on each. **No `insert`/`update`/`delete` policy for `authenticated` at all** — the established convention (Prediction, capability policies): RLS restricts reads, a Server Action's service-role client authorizes writes, authorized by `requireUser()` in the action. Verified directly in `tests/integration/execution.test.ts`: an anon client can neither read nor write either table; an authenticated owner cannot `UPDATE` their own quote (immutable snapshot); cross-user reads return empty, not an error that would leak existence. **No new `SECURITY DEFINER` function** — every write is a plain service-role table operation (`createQuote`, `createOrderIntent`, `resolveOrderIntent`), consistent with this codebase's two-prior-incident-informed preference. `tests/integration/table-privilege-hygiene.test.ts`'s `REPRESENTATIVE_TABLES` now includes both new tables.

## 18. Rate limiting

A dedicated class (`lib/rate-limit/execution.ts`), **not** a reuse of Prediction's own rate limiter — deliberately different fail behavior: `checkExecutionQuoteRateLimit` stays **fail-open** (read-only, no persisted state, low risk, matching this codebase's existing default), while `checkExecutionConfirmationRateLimit` is **fail-closed** — an infrastructure failure blocks the confirmation rather than silently allowing it. This is a deliberate, explicitly-documented rehearsal of the fail-closed posture Milestone 4's architecture gate document already requires for real order submission (§24 there) — the split exists specifically so this milestone's own quote-request convenience is never mistaken for an accidental fail-open precedent being set for real money.

**Final remediation (post-launch):** the window length and max-attempt count for both classes were originally hard-coded constants in `lib/rate-limit/execution.ts`. Per the standing hard-coding rule, being centralized in one file is not the same as being architecturally invariant — an operator may legitimately need to loosen, tighten, or disable either class without a deploy — so these moved into `platform_settings` (migration `20260101000152`), read via `getExecutionRateLimitPolicy()`, and are edited with `pnpm set-execution-policy`. What stays code-level is the fail-open/fail-closed split itself, and the fact that a config-read failure resolves to the documented fallback values (`FALLBACK_EXECUTION_RATE_LIMIT_POLICY`) rather than to "no limit" — the confirmation class in particular can never become fail-open just because its configuration is missing or malformed.

## 19. Provider outage behavior

If the read-only order-book fetch fails (network error, non-200, malformed JSON) or the market has no recorded CLOB token id, `PolymarketOrderBookUnavailableError` is caught inside the adapter and `getExecutableSnapshot` returns `null` — never a thrown exception reaching the Server Action, never a fabricated snapshot. `checkExecutionEligibility` then denies with `PROVIDER_UNAVAILABLE`, a plain consumer-facing message (`lib/execution/copy.ts`). Discovery and Prediction remain completely unaffected by an execution-provider outage — they share no code path with `lib/execution/`.

## 20. Configuration (hard-coding audit)

| Item | Classification | Source |
|---|---|---|
| Quote/OrderIntent schema shapes, lifecycle states, `is_simulated` marker | True invariant (architectural) | migration `20260101000148` |
| Prediction/Quote/OrderIntent/Order/Fill/Position conceptual separation | True invariant (architectural) | no `Order`/`Fill`/`Position` table exists; `lib/execution/` never imports `lib/predictions/` |
| Provider-neutral `ExecutionQuoteProvider` contract | True invariant (architectural) | `lib/execution/types.ts` |
| Depth-walk/weighted-average slippage algorithm (the *mechanism*) | True invariant (architectural) | `lib/execution/quote-math.ts` |
| Simulation master on/off switch | Configurable operational policy | `platform_settings.execution_simulation_enabled` |
| Min/max amount | Configurable product policy | `platform_settings.execution_{min,max}_amount_cents` |
| Quote expiry duration | Configurable operational policy | `platform_settings.execution_quote_expiry_seconds` |
| Provider-data freshness threshold | Configurable operational policy | `platform_settings.execution_data_freshness_max_seconds` |
| Max allowed simulated slippage | Configurable operational policy | `platform_settings.execution_max_slippage_bps` |
| Recalculation tolerance (quote vs. confirmation price movement) | Configurable operational policy | `platform_settings.execution_recalculation_tolerance_bps` |
| Simulated provider/Brohda fee rates | Simulation-only policy (explicitly labeled, not authoritative provider data) | `platform_settings.execution_simulated_{provider,brohda}_fee_bps` |
| Rate-limit windows/max-attempts, and whether each class is enforced at all (quote, confirmation) | Configurable operational policy (values); fail-open vs. fail-closed behavior itself, and server-side-only enforcement, are true invariants per class | `platform_settings.execution_{quote,confirmation}_rate_limit_{enabled,window_seconds,max_attempts}` (migration `20260101000152`) |
| Simulated-execution diagnostics authorization (which role) | Configurable authorization policy | `capability_policies` (migrations `20260101000150`/`151`), `view_simulated_execution_diagnostics` |
| Simulation/ineligibility/rejection copy | Consolidated, not duplicated; reviewed and judged presentation code, not configuration (same reasoning as Prediction's own notification-copy classification's distinction between booleans and wording) | `lib/execution/copy.ts` |
| Failure-state vocabulary itself (the closed set of reason strings) | True invariant (architectural) | `lib/execution/types.ts` |

**Hard-coded mutable execution policy remaining: NONE.**

## 21. Known limitations

- No cleanup/garbage-collection job exists for expired, never-confirmed `execution_quotes` rows — logically inert (expiry is checked at every use) but not physically pruned. A reasonable Milestone 6-or-later addition, not required for Milestone 5's own correctness.
- `updatePredictionStreak`-style read-then-write races do not apply here (no aggregate counter is maintained by this milestone), but the *rate-limit* check-and-increment RPC's own concurrency behavior under truly simultaneous requests from the same user was not independently stress-tested this milestone — inherited as-is from the existing `check_and_increment_rate_limit` function.
- This milestone's automated tests depend on a small number of calls to Polymarket's real, live, read-only order-book endpoint for a specific currently-active market ("Xi Jinping out before 2027?", token id recorded in the test files) — there is no database-only equivalent to fixture against for live order-book depth. If that market resolves or Polymarket's API is unreachable, the small set of tests explicitly marked "live Polymarket read-only data" may fail for reasons unrelated to Brohda's own code; this is an accepted, documented tradeoff, not a hidden one.
- The exact real Polymarket provider fee (as opposed to the builder-fee cap Milestone 4 confirmed) remains unconfirmed — the simulated provider-fee assumption is exactly that, an assumption, clearly labeled.
- As with every prior milestone, this development environment's browser-preview tooling is anchored to an unrelated project directory — functional verification relied on the automated test suites (unit, integration, E2E), not a manual browser session.

## 22. Explicit Milestone 6 boundary

Nothing in this milestone creates, references, or assumes a real provider `Order`, `Fill`, `Position`, wallet, signing key, or custody record. No mutation endpoint is called or implemented — `ExecutionQuoteProvider` has no `submitOrder`/`cancelOrder` method, and none should be added until Milestone 6's own architecture review (the Decision Register in `docs/architecture/execution-architecture-gate.md` §29 must first move its `BLOCKED`/`COUNSEL REQUIRED` custody/signing/legal items to a resolved state — none of that happened in this milestone). Milestone 6 remains blocked by the Execution Architecture Gate's unresolved founder/legal/compliance prerequisites — see `docs/architecture/milestone-6-readiness.md` for the consolidated decision gate that supersedes this section's own status tracking (not its technical content) going forward.
