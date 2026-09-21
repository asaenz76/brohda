# Sports Prediction Network — Milestone R0 Architecture

**Status**: Implements `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` Milestone R0 — the sports prediction network repivot. This document is the canonical architecture reference for Brohda's current and future direction. **There is no real-money execution, no Polymarket integration, no crypto, and no wallet/custody concept anywhere in this architecture.** The abandoned direction that once occupied this file's role is archived at `docs/deprecated/polymarket-execution-direction-2026/`.

---

## 1. Product scope

Brohda is a **sports-only** prediction network. A user predicts YES or NO on a structured sports outcome, sees a market-implied probability derived from real sportsbook lines, and later learns — automatically, from real game results — whether they were right. There is no stake, no wager, no payout, no financial exposure of any kind. The reward is being right, publicly and permanently.

## 2. Sports-only rule

No general-interest, political, financial, or entertainment prediction questions. Every `PredictionQuestion` traces to a real `SportsEvent`. This is a product boundary, not a technical limitation — the domain model (§9) has no field for a non-sports question, and none should be added without a separate, explicit product decision.

## 3. Event source

`SportsEvent` data comes from the existing API-Sports integration (`lib/sports-data/`) — the same provider abstraction already proven for the legacy PAID/FREE pool product's fixtures, teams, schedules, and results. No new sports-data provider is introduced in R0; R1 extends the existing provider surface (fixtures already ingested) rather than replacing it.

## 4. Question generation

`PredictionQuestion` rows are generated from real, scheduled `SportsEvent` fixtures, using one of the three approved templates (§6). Generation is selective and bounded, mirroring the discipline the abandoned Polymarket-ingestion layer already established (`lib/prediction-markets/eligibility.ts`'s conceptual pattern, before its own removal as dead code — see §18): Brohda does not blindly generate every conceivable question for every fixture. Which sports/leagues/templates are eligible for generation is configuration (`docs/architecture/sports-prediction-network.md` §19), never a hard-coded list. **Not implemented in R0** — R1's own scope.

## 5. Approved market templates (R1 scope)

| Template | YES means | Resolution input |
|---|---|---|
| **MONEYLINE** | The named side wins the game outright | Final winner |
| **SPREAD** | The named side covers the given spread | Final score margin vs. the spread at question-creation time |
| **TOTAL** | The combined final score is over the given total | Final combined score vs. the total at question-creation time |

No exotic prop markets, no player props, no in-game live markets in R0/R1. Each template must define, before any question using it is generated: question-text generation, odds mapping (which sportsbook market maps to this template), YES/NO semantics, the closing rule, the resolution rule (including push/void handling), and the exact provider data required to resolve it automatically. A template with ambiguous or unsupported resolution must not generate questions — ever, not just "until someone gets around to it."

## 6. Odds/lines source

API-Sports' odds endpoints (bookmaker-level lines per fixture/market), researched and integrated in R2. Brohda never depends on the provider retaining historical odds indefinitely — every observation Brohda cares about is persisted into its own `OddsSnapshot` storage (§8) at read time.

## 7. Bookmaker normalization

Raw bookmaker odds (moneyline/spread/total, in whatever format API-Sports returns them) are normalized into a single internal representation — decimal probability space — before any vig removal or aggregation happens. Bookmaker identity, market identity, selection, raw odds, and normalized odds are all preserved in the stored `OddsSnapshot` (§8), so the exact computation can be audited or reproduced later without re-fetching from the provider.

## 8. Odds snapshot storage (R2 scope)

Conceptual shape — **not implemented in R0**:

```
OddsSnapshot
  event               -- soft reference to SportsEvent
  question_type       -- MONEYLINE | SPREAD | TOTAL (+ template-specific line, e.g. spread value)
  bookmaker           -- which sportsbook
  selection            -- which side/outcome this observation is for
  raw_odds            -- as returned by the provider
  normalized_odds      -- decimal-probability form
  observed_at          -- when Brohda fetched this observation
  source               -- provider identity (api-sports), for future multi-source auditability even though only one exists today
```

Enough is stored to reproduce or audit the derived probability later without re-fetching the provider — never storing more of the raw provider payload than that diagnostic need justifies.

## 9. Multi-bookmaker aggregation (R2 scope)

1. Collect valid bookmaker observations for the question's market (per §14 configuration: eligible bookmakers, minimum source count, staleness threshold).
2. Remove vig within each bookmaker's own market (§13) to get that bookmaker's normalized probability.
3. Aggregate across eligible bookmakers' normalized probabilities using a configurable, documented statistic (a median is the preferred default — resistant to one outlier bookmaker — but the method itself must be config-driven, not hard-coded).
4. Record the resulting `MarketProbability` alongside the source count and the aggregation method actually used, so a later audit can see exactly how a given number was produced.

## 10. Vig removal (R2 scope)

For a two-outcome market: (1) convert each side's odds to a raw implied probability; (2) sum both sides' raw probabilities to get the overround; (3) divide each side's raw probability by the overround so both sides sum to exactly 1.0. Three-outcome markets (not in R1's approved template list) and push-eligible markets (spread/total) need their own template-specific normalization — not assumed to reduce to the two-outcome case blindly. Decimal precision and rounding behavior must be applied consistently and tested explicitly (rounding-error accumulation across many bookmakers is a real correctness risk, not a cosmetic one).

## 11. Probability snapshot semantics

When a user predicts: (1) use the most recently computed valid `MarketProbability` for that question; (2) persist it, permanently, on the `Prediction` row itself — never as a live join back to a mutable odds table; (3) persist enough audit context (source count, computation timestamp) to explain the number later; (4) **never recalculate a Prediction's stored probability after the fact**, no matter how the market moves afterward. This is the single most load-bearing rule in this architecture — see §11 (Prediction permanence) below for why.

## 12. Prediction permanence

A Prediction is a permanent historical record of what a user believed, and what the market believed, **at that specific moment**. `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` §4/§7 already locks this as non-negotiable. Concretely: the `Prediction` row's probability field is written once, at creation, and is never subject to an `UPDATE` from any later odds-ingestion or re-aggregation process. This mirrors the exact discipline `lib/predictions/` already proved for Polymarket-derived probabilities (`predicted_at`-scoped snapshot, never rewritten) — R0 changes nothing about this guarantee, only the source of the number.

## 13. Automatic resolution (R3 scope)

Resolution is objective and automated from the sports-data provider's own final status/result — never editorial or manual where structured data can resolve automatically. Each template (§5) defines its own deterministic resolution logic and must explicitly handle: postponed, canceled, abandoned games; overtime (where the template cares — a moneyline question is typically unaffected, a total/spread question needs an explicit regulation-only-vs-full-game rule); push (spread/total landing exactly on the line); and provider corrections to an already-resolved event (a policy decision to make explicitly, not silently assume — mirroring the existing Prediction-grading precedent of never silently re-processing an already-finalized record, `lib/predictions/`'s own documented behavior).

## 14. Grading

Reuses the existing grading framework (`lib/predictions/grading.ts`) unchanged in shape: a Prediction's outcome is `CORRECT`, `INCORRECT`, or `VOID` (this codebase's existing minimal factual vocabulary — no new state is introduced). Grading updates only factual aggregates (`prediction_correct_count`/`prediction_incorrect_count`, unchanged from the existing schema) — **no financial settlement of any kind exists to reintroduce**. Final reputation scoring (difficulty-adjustment, weighting) is explicitly deferred to R4, exactly as the original Milestone 3 deferred it to (the now-renumbered) R4 rather than inventing it ad hoc.

## 15. Factual history

A Prediction's permanent record preserves: the question, the user's YES/NO, the predicted timestamp, the market-implied probability snapshot, the final result, CORRECT/INCORRECT/VOID, and sport/league/team context. This never mixes with legacy pool-entry history (`wallet_transactions`/pool `entries`) — two structurally and permanently separate domains (§17).

## 16. Reputation inputs

R0-R3 preserve raw factual inputs for R4 to eventually score: correct/incorrect/void counts, probability at prediction time, sport, league, market/question type, prediction timestamp, and (if useful) bookmaker source-count/quality. **No streak or difficulty-adjusted score is invented in R0-R3** — this repeats, deliberately, the exact discipline already proven correct once in this codebase: Milestone 3 originally also maintained `current_streak`/`best_streak` counters, discovered on its own re-review that a streak embeds real undecided product policy (does INCORRECT reset it? does VOID preserve it?), and deferred them rather than guessing — those two columns remain unused today, reserved for whichever milestone finally defines that policy with founder review.

## 17. Legacy separation

The legacy PAID/FREE pool engine (`lib/actions/{pools,entries,settlements,pool-lifecycle,reversal}.ts`, `wallet_balances`/`wallet_transactions`) is a **completely separate domain**, unaffected by this repivot and never merged with the sports-prediction domain. No sports Prediction ever touches a wallet balance, a pool entry, or a settlement record, and no legacy pool concept is reused as shared state for sports predictions — only as a *pattern* precedent where genuinely useful (idempotency-key mutation, RLS/grant discipline, permanent-record preservation), exactly the same "pattern, not shared state" distinction the abandoned Polymarket roadmap already correctly drew for the same legacy system.

## 18. Removed Polymarket concepts — full accounting

See the R0 completion report for the exhaustive KEEP/REPURPOSE/REMOVE file audit. Summary of what no longer exists anywhere in the active codebase:

- The Polymarket Gamma API discovery adapter and CLOB read-only order-book client (`lib/prediction-markets/providers/polymarket/*`, `lib/execution/providers/polymarket/*`).
- The provider registry and ingestion pipeline built solely around that one provider (`lib/prediction-markets/provider-registry.ts`, `lib/prediction-markets/ingest.ts`, `lib/prediction-markets/eligibility.ts`, `scripts/{ingest,inspect}-prediction-markets.ts`).
- The entire `lib/execution/` domain: quote math, `Quote`/`OrderIntent`, the execution control plane, kill switches, rollout cohorts, execution limits, provider health/circuit breaking, execution audit events, reconciliation, correlation IDs, the execution failure taxonomy, and the simulated-execution consumer UI (`components/execution/`, the "Simulations" profile tab, `app/(admin)/admin/{simulated-execution,execution-operations}/`).
- Every execution-specific `platform_settings` column, `app_capability` value, and `capability_policies` row (removed via a clean local migration squash — see §8 of the roadmap and the R0 completion report's migration-cleanup section).
- The Milestone 4-6 research/decision documents (`execution-architecture-gate.md`, `execution-threat-model.md`, `simulated-execution.md`, `execution-operational-safety.md`, the Milestone 6 readiness/founder/provider/counsel/legal-signoff package) — archived, not deleted, at `docs/deprecated/polymarket-execution-direction-2026/`.

What survived, repurposed: the `markets` table itself (candidate `PredictionQuestion` schema — §9 below), its RLS/grant shape, `lib/prediction-markets/repository.ts` (minus the execution-only `getMarketProviderMetadata` export), the discovery/eligibility/freshness/category-mapping mechanics (`lib/prediction-markets/discovery/*`), and the consumer discovery feed UI shell (`app/(app)/markets/`, `components/discovery/*`) — all of it was already provider-neutral in shape, coupled to Polymarket only through the now-removed adapter and ingestion job, not through its own logic.

## 19. Configuration principles

Every mutable sports-prediction policy must live in configuration, never a source-code constant:

| Policy | True invariant | Configurable |
|---|---|---|
| Supported sports/leagues | — | Which ones are enabled (R1) |
| Approved question templates | The three templates' own resolution semantics (§5) | Which are enabled, question-generation eligibility rules |
| Eligible bookmakers | — | The list itself, per-market or globally (R2) |
| Minimum bookmaker count | — | The threshold value (R2) |
| Aggregation method | The requirement that one exists and is documented | Which statistic is used (median, other) (R2) |
| Odds staleness threshold | — | The window (R2) |
| Question closing window | The requirement that closing is server-enforced and no late prediction is ever accepted | The exact lead time before kickoff (R1) |
| Grading vocabulary | CORRECT/INCORRECT/VOID as the closed state set | Notification copy/triggers for each (already proven configurable in the existing Prediction domain) |
| Discovery visibility/ordering | — | Category mappings, sort policy (already configurable, reused) |
| Admin capability policy | The capability-based-authorization mechanism itself | Which role(s) satisfy a given capability |

One clean sports-data provider interface, one provider (API-Sports), reused rather than rebuilt as a speculative multi-provider abstraction (§32 of the R0 task's own instruction, mirrored here).

## 20. Future milestones

See `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` §6 for the full R1-R9 sequence (question foundation, odds/probability, automated resolution/grading, reputation, profiles/social graph, feed/discovery, leaderboards, notifications/growth, and any eventual, separately-authorized legacy wind-down). R0 itself implements none of R1-R9's actual functionality — it only removes what's abandoned and leaves the repurposed foundation (`markets`, discovery, Prediction, grading, notifications, capability policies) coherent and green for R1 to build on.
