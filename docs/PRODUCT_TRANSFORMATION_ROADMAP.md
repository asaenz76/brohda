# Brohda Product Transformation Roadmap

**Status: HISTORICAL / SUPERSEDED.** This document's R1–R9 milestone sequence is no longer the implementation authority. `docs/BROHDA_2_0_MILESTONE_MAP.md` is now the active canonical Brohda 2.0 implementation roadmap (R1–R14, recorded 2026-09-21). This document is preserved for historical context — what R0 originally planned before the Brohda 2.0 product refinement — and remains accurate for Milestone R0 itself, which is complete and unchanged.

**This document replaces, in full, the previous Polymarket-powered real-money-execution roadmap.** That direction (external-market discovery, a Brohda Prediction layer against Polymarket prices, simulated execution, an execution-operational-safety layer, and a Milestone 6 real-execution readiness package) was researched and partially built — **never deployed, never carrying real financial exposure** — before the founder decided, decisively, to abandon it. Every document describing that direction has been moved to `docs/deprecated/polymarket-execution-direction-2026/` and is historical only. See `docs/architecture/sports-prediction-network.md` for the full architecture this document's milestones implement, and that document's own §20/file-audit for exactly what was kept, repurposed, or removed from the abandoned direction.

**No implementation work beyond Milestone R0 is authorized by this document alone.** Future tasks should reference one milestone (R1, R2, ...) explicitly rather than re-deriving direction from first principles.

**Milestone R0.5 status note (2026-09-21):** the product direction was refined further into "Brohda 2.0" — a social layer (`Game → Post → Market → Pick → Challenge → Monetary Position`) sitting on top of the sports-prediction network this document describes. R0.5 was an audit-only milestone (no code or schema changed) that reconciled this document's R1–R9 sequence against the actual repository; see `docs/architecture/brohda-2.0-reconciliation.md` for what R0 got right and what it left incomplete (notably: no `Post`/`Community`/`Challenge` objects exist yet, and `markets` has no real foreign key to `fixtures`). The resequenced R1–R14 roadmap adopted from that audit now lives in `docs/BROHDA_2_0_MILESTONE_MAP.md`, which is the active implementation authority. The R1–R9 list below is preserved as historical context for what R0 originally planned; it is superseded by that document, not by silent edits here.

## Authority and supersession

`CLAUDE.md` (the Brohda Product Constitution) and `BROHDA_MANIFESTO.md` describe brohda.'s original, and still-current, product identity: a private, invite-only, equal-stakes sports pool platform where the reward is reputation, never a variable payout, and odds/spreads/variable stakes are a **hard, no-exceptions gate** (`CLAUDE.md`'s Founder Checklist). The abandoned Polymarket roadmap explicitly **superseded** that hard gate, because a market-priced, real-money product cannot exist without displaying continuous odds and variable stakes.

**That supersession is itself now reversed.** With real-money execution gone, Brohda's sports prediction network has **no wager, no stake, no variable payout** — a user's "correctness" is the entire product, exactly as the constitution always required. The one place this roadmap asks for a considered reading, not a silent assumption, is probability display (§4 below): a *derived, sportsbook-informed probability* shown as **difficulty context** ("this was a 70% favorite") is not the same thing as **exchange/wagering language** ("odds: -150," a stake-sizing form, a payout calculator) — the former is compatible with the constitution's hard gate, the latter is exactly what it forbids. This roadmap holds that line explicitly at every milestone that touches probability display.

**Security, testing, data integrity, auditability, production safety, and financial-history preservation rules remain authoritative and unchanged** by this document. The legacy PAID/FREE pool engine's own historical records remain permanent regardless of anything in this roadmap.

---

## 1. Target Product

Brohda is a **sports-only prediction network**. A user predicts YES or NO on a structured sports outcome (moneyline, spread, or total), sees the market-implied probability at the moment they predicted, and later finds out — automatically, from real game results — whether they were right. No money changes hands over the prediction itself. The product rewards being right, publicly and permanently, the same way the original brohda. constitution always intended — now applied to real sports outcomes across many games and leagues, not only the private pools a friend group manually creates.

```
Sports event appears
  → Brohda generates an eligible prediction question (moneyline / spread / total)
  → sportsbook odds/lines are collected
  → Brohda derives a vig-adjusted, multi-bookmaker market-implied probability
  → user predicts YES or NO
  → Brohda persists the selection AND the probability snapshot, permanently
  → event closes/locks (server-enforced, before kickoff)
  → sports-data provider returns the final result
  → Brohda resolves the question automatically
  → the prediction is graded CORRECT / INCORRECT / VOID
  → factual history/reputation inputs update
  → profile, feed, and leaderboard surfaces consume that history
```

**Brohda owns**: prediction questions, probability snapshots, prediction history, grading, reputation inputs, profiles, social graph, feed/discovery, notifications, and admin/configuration.

**The sports-data stack (API-Sports) provides**: fixtures, teams, schedules, scores/results, and — extended in R2 — bookmaker odds/lines. Brohda never re-derives a game result itself; resolution is always sports-data-driven.

```
Brohda UI
   ↓
Brohda domain (PredictionQuestion, Prediction, OddsSnapshot)
   ↓
Sports-data provider interface (existing lib/sports-data/ pattern)
   ↓
API-Sports adapter
   ↓
API-Sports infrastructure
```

---

## 2. Core Architectural Principle — Locked

**Brohda must never become tightly coupled to API-Sports-specific concepts.** Exactly the same discipline the abandoned Polymarket direction correctly established, now applied to the surviving provider: fixture/bookmaker/odds-endpoint specifics are isolated inside the sports-data adapter layer; the Brohda domain speaks only provider-neutral concepts (`SportsEvent`, `PredictionQuestion`, `Prediction`, `OddsSnapshot`, `MarketProbability`).

**One clean interface, one provider, now** — API-Sports is the sports-data source. This roadmap explicitly does not build a speculative multi-provider abstraction for hypothetical future sports-data vendors (docs/architecture/sports-prediction-network.md §19).

---

## 3. Domain Separation — Non-Negotiable

- **SportsEvent** — the real scheduled game. Permanent, provider-sourced.
- **PredictionQuestion** — one Brohda prediction opportunity attached to a SportsEvent (a specific moneyline/spread/total question), with its own resolution rule and closing time.
- **Prediction** — a user's permanent YES/NO answer to a PredictionQuestion, with its own permanently-snapshotted probability. **Never rewritten by later odds movement.**
- **Legacy Pool/Entry/Wallet** (the original PollPools engine) — a completely separate, pre-existing domain. It must never be merged with, or leak into, the sports prediction network's own domain. See `docs/architecture/sports-prediction-network.md` §17.

There is no `Order`, `Fill`, `Trade`, or `Position` concept anywhere in this roadmap. Those existed only in the abandoned real-execution direction and are not being replaced by a sports-flavored equivalent — a Prediction has no financial exposure to reconcile.

---

## 4. Probability Display — Reinterpreted, Not Superseded

The market-implied probability (§9) is shown to the consumer as **difficulty/context language** — "this was a 70% favorite," "you called an upset (28% chance)" — computed once, at prediction time, and permanently attached to that Prediction. It is:

- **Never** presented as a betting line ("-150," "+120," "spread -3.5" in wagering form).
- **Never** attached to a stake-sizing or payout-calculator UI — there is no amount to enter and nothing to win beyond being right.
- **Never** recalculated for a Prediction after the fact — the value the user saw when they predicted is permanent history (§9 of `sports-prediction-network.md`).

This is a direct extension of the precedent the (now-superseded) Prediction layer already established for Polymarket-derived probabilities: showing "you predicted YES at 62%" was never a wager even when the number came from a real market — the same logic applies with a sportsbook-derived number instead. Any future screen that starts to look like a betting slip (odds format, stake input, payout math) fails the Founder Checklist's hard gate and must be redesigned before it ships.

---

## 5. Legacy PAID/FREE Pool System — Coexistence, Unaffected

**Unaffected by this repivot.** The legacy pool engine (`lib/actions/{pools,entries,settlements,pool-lifecycle,reversal}.ts`, `wallet_balances`/`wallet_transactions`, the private invite-only PAID/FREE pool product) continues exactly as it always has. This roadmap's sports prediction network is a parallel, separate domain — not a replacement, not a merge target. Its eventual wind-down (if the founder ever chooses one) remains its own, separately-authorized future decision, unrelated to anything in this document.

---

## 6. Milestones

### Milestone R0 — Sports Prediction Network Repivot

- **Objective**: Remove Polymarket and real-money execution from Brohda's active architecture; establish the sports-only direction as canonical.
- **Product outcome**: None new — this is a cleanup and re-documentation milestone.
- **Architecture outcome**: This roadmap and `docs/architecture/sports-prediction-network.md` become canonical; the Polymarket adapter, execution domain, simulated-execution UI, execution-operational-safety layer, and Milestone 6 readiness package are removed from active code/docs; the `markets` table and its surrounding discovery/eligibility/freshness machinery are repurposed (not replaced) as the candidate `PredictionQuestion` schema; the Brohda Prediction domain (`lib/predictions/`) is preserved unchanged.
- **In scope**: Full repository audit and cleanup (KEEP/REPURPOSE/REMOVE); migration squash of the never-shipped execution schema; local Supabase reset; doc archival; hard-coding audit of what remains.
- **Out of scope**: Building any new sports-question-generation, odds-ingestion, or aggregation code beyond what's needed to keep the repo coherent after removal.
- **Dependencies**: None — this is the pivot itself.
- **Founder decisions required before starting**: Already given (this task).
- **Major risks**: Deleting something still load-bearing for the Brohda Prediction domain — mitigated by tracing actual dependencies (not assuming) before removing anything; see the R0 completion report's file audit.
- **Rollback/reversibility**: A full local git checkpoint of the pre-repivot state exists before any destructive change.
- **Verification requirements**: Full three-tier test suite green for everything kept (Prediction, legacy pools, sports-data provider registry); build clean; no hosted Supabase mutation.
- **Exit criteria**: See the R0 completion report.
- **Legacy Brohda status**: Fully live, unaffected.

### Milestone R1 — Sports Prediction Question Foundation

- **Objective**: Generate real `PredictionQuestion` rows from real `SportsEvent` fixtures, using the approved templates (moneyline, spread, total).
- **Product outcome**: A structured, resolvable prediction question exists for real upcoming games — still without odds/probability (R2) or a consumer-facing feed (R6).
- **Architecture outcome**: The `SportsEvent`/`PredictionQuestion` domain (`docs/architecture/sports-prediction-network.md` §9) is implemented against real fixture data; each template's question-generation/closing/resolution rule (§10) is coded and tested.
- **In scope**: Fixture-to-question generation for the three approved templates; server-enforced closing; the provider-neutral resolution contract (not yet wired to a live result feed — that's part of this milestone too, per §10/§18 of the architecture doc); push/void handling per template.
- **Out of scope**: Odds/probability (R2); consumer discovery (R6); reputation scoring beyond raw factual inputs.
- **Dependencies**: R0.
- **Founder decisions required before starting**: Which sport(s)/league(s) launch first (bounded, not "all of API-Sports").
- **Exit criteria**: A real fixture reliably produces a correctly-typed, correctly-closing, correctly-resolvable PredictionQuestion for each of the three approved templates.
- **Legacy Brohda status**: Fully live, unaffected.

### Milestone R2 — Odds Snapshots & Market Probability

- **Objective**: Derive and persist a vig-adjusted, multi-bookmaker market-implied probability for each PredictionQuestion.
- **Product outcome**: None directly visible yet — this is the probability-computation engine R3/R6 will surface.
- **Architecture outcome**: `OddsSnapshot` storage (§8 of the architecture doc); vig-removal (§13); configurable multi-bookmaker aggregation (§14); the "no valid odds" decision (§16) implemented.
- **In scope**: API-Sports odds-endpoint integration; per-bookmaker vig removal; configurable aggregation (median or another robust statistic); minimum-source-count and stale-observation policy; probability-snapshot persistence at prediction time, permanently.
- **Out of scope**: Consumer display (R6); reputation weighting by probability (R4).
- **Dependencies**: R1.
- **Founder decisions required before starting**: None beyond confirming which bookmakers are eligible sources (a configuration decision, not an architectural one).
- **Exit criteria**: A real PredictionQuestion reliably produces a documented-methodology probability from ≥ the configured minimum bookmaker count, or is correctly withheld/flagged per the no-valid-odds policy.
- **Legacy Brohda status**: Fully live, unaffected.

### Milestone R3 — Automated Resolution & Grading

- **Objective**: Resolve PredictionQuestions automatically from final sports results and grade every Prediction against them.
- **Product outcome**: A user's prediction is automatically marked CORRECT/INCORRECT/VOID once the game ends — no manual/editorial resolution.
- **Architecture outcome**: The existing grading framework (`lib/predictions/grading.ts`) is extended to read `PredictionQuestion` resolution state instead of the (removed) Polymarket `resolved_outcome` field; per-template resolution logic (moneyline/spread/total, including postponed/canceled/push handling) is implemented and tested.
- **Dependencies**: R1 (question existence), a live sports-data result feed.
- **Exit criteria**: A completed real game reliably resolves its PredictionQuestion(s) and grades every associated Prediction correctly, including push/void edge cases.
- **Legacy Brohda status**: Fully live, unaffected.

### Milestone R4 — Reputation System

- **Objective**: Define and implement the actual reputation/difficulty-adjusted scoring algorithm, using the raw factual inputs R0-R3 preserve.
- **Founder decisions required before starting**: The exact reputation/difficulty-adjustment algorithm — explicitly **not** invented in R0-R3 (which only preserve the raw inputs: correct/incorrect/void, probability at prediction time, sport/league/market type, timestamp).
- **Major risks**: Reputation gaming (predicting only near-certain outcomes to farm accuracy cheaply) — must be designed against explicitly, not discovered after launch. Financial spend must never factor in — there is none in this product, which structurally forecloses the original gaming vector CLAUDE.md worried about.
- **Legacy Brohda status**: Fully live, unaffected.

### Milestone R5 — Public Profiles & Social Graph

- **Objective**: Extend existing profile/following infrastructure to fully represent sports-prediction identity and history.
- **Dependencies**: R3, R4.
- **Legacy Brohda status**: Fully live, unaffected.

### Milestone R6 — Feed & Discovery

- **Objective**: Build the actual consumer-facing discovery experience for sports predictions — upcoming events, active questions, followed teams/leagues, kickoff time, popularity.
- **In scope**: Repurposing (not rebuilding from scratch) the discovery feed shell, category-mapping pattern, and freshness/eligibility mechanics already proven for Polymarket markets, now populated with real sports questions.
- **Out of scope**: Polymarket-derived categories or tags of any kind.
- **Dependencies**: R1, R2.
- **Legacy Brohda status**: Fully live, unaffected.

### Milestone R7 — Leaderboards & Expertise

- **Objective**: Sport/league/market-type-specific leaderboards and expertise recognition, built on R4's reputation inputs.
- **Dependencies**: R4.
- **Legacy Brohda status**: Fully live, unaffected.

### Milestone R8 — Notifications, Sharing & Growth

- **Objective**: Extend the existing notification infrastructure (`lib/notifications/`) to sports-prediction events (question closing soon, result graded) and add sharing/growth surfaces.
- **Dependencies**: R3.
- **Legacy Brohda status**: Fully live, unaffected.

### Milestone R9 — Legacy Pool Wind-Down & Repository Cleanup

- **Objective**: Only if and when the founder separately decides to retire the legacy PAID/FREE pool engine — not assumed, not scheduled, not a consequence of this repivot.
- **Founder decisions required before starting**: An entirely separate, explicit decision. This roadmap does not authorize or schedule legacy wind-down; it is listed here only to preserve the original roadmap's own discipline that cleanup is a deliberate final step, never pulled forward.
- **Legacy Brohda status**: The milestone where "legacy Brohda" would stop being live, if and only if separately authorized.

---

## 7. Founder Decision Register

### LOCKED — already approved (this repivot)

1. Brohda is sports-only. No Polymarket, no crypto, no general-interest markets.
2. No real-money execution now or on any current roadmap. No wallets, custody, Session Keys, Builder integration, CLOB, order placement, Positions, fills/trades, or cash-out for the prediction product.
3. Sports predictions are about being right, not wagering money — equal, non-monetary, exactly like the original brohda. constitution.
4. Market-implied probability is shown as difficulty/context language only, never as a wagering price or stake-sizing mechanic (§4).
5. Prediction history is permanent and must survive later odds movement — the probability snapshot at prediction time is never rewritten.
6. Resolution must be objective, automated, and sports-data-driven — no editorial/manual outcome logic where structured data can resolve automatically.
7. The legacy PAID/FREE pool engine remains fully separate and unaffected; no silent merge with the new sports-prediction domain.
8. One provider (API-Sports) — no speculative multi-provider abstraction.
9. Bookmaker lists, aggregation methodology, freshness windows, closing windows, and every other mutable policy named in `docs/architecture/sports-prediction-network.md` §19 must be configuration, never a source-code constant.

### OPEN — not yet resolved; do not treat as settled

1. Which sport(s)/league(s) launch first (R1).
2. The eligible-bookmaker list and minimum source count (R2 — configuration, not architecture).
3. The exact reputation/difficulty-adjustment algorithm (R4).
4. Whether legacy pool wind-down is ever pursued at all (R9 — entirely separate future decision).
5. How far discovery/feed scope eventually goes (which sports/leagues are surfaced, R6).

---

## 8. Technical Principles — Locked

1. Additive migration before destructive migration — the one exception in this transformation's own history is R0's own migration squash, justified explicitly because the removed schema never shipped to production (see the R0 completion report).
2. Legacy systems (the pool engine) stay operational until a separately-authorized retirement decision.
3. No provider-specific fields leak across the application above the sports-data adapter boundary.
4. Idempotency is required for every mutation that could otherwise duplicate a record, extending the pattern already proven in `create_pool_entry`/Prediction creation.
5. RLS and server-side mutation boundaries remain mandatory for every table/RPC.
6. Every `SECURITY DEFINER` function's grants are verified before merge (Gate 1A discipline, unchanged).
7. Historical financial and prediction records are permanent.
8. Consumer UX stays simple — a prediction question, a YES/NO choice, and a result. Nothing that resembles a betting slip.
9. No milestone begins without its predecessor's exit criteria met.

---

## 9. Non-Goals

Brohda is explicitly **not** trying to become:

- A sportsbook, exchange, or wagering product of any kind.
- A crypto or DeFi product.
- A general-interest (non-sports) prediction market.
- A platform where users create their own prediction questions (not in this roadmap).
- A multi-sport-data-provider abstraction built ahead of actual need.

---

## 10. Documentation Hierarchy

1. **`docs/PRODUCT_TRANSFORMATION_ROADMAP.md`** (this document).
2. **`docs/architecture/sports-prediction-network.md`** — the full architecture this roadmap's milestones implement.
3. Milestone-specific approved implementation specs, when a specific milestone is scoped.
4. `CLAUDE.md`, `BROHDA_MANIFESTO.md` — the durable product constitution; authoritative for anything this roadmap does not address, and the standard §4's probability-display discipline is measured against.
5. `docs/deprecated/polymarket-execution-direction-2026/` — historical only. Never authoritative for current work.

**When a future task conflicts with this roadmap, stop and flag the conflict rather than silently following an older document — including any surviving reference to Polymarket, execution, or real-money mechanics anywhere in the active codebase.**
