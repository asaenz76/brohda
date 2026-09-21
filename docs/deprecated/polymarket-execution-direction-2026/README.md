# DEPRECATED — Polymarket / Real-Money Execution Direction (abandoned 2026-09-21)

**Everything in this directory is historical only. None of it describes Brohda's current or future product direction.**

Brohda's product direction changed decisively in Milestone R0 (`docs/PRODUCT_TRANSFORMATION_ROADMAP.md`, `docs/architecture/sports-prediction-network.md`). Brohda is now a **sports-only prediction network** powered by sports-data odds/results (API-Sports). There is **no** Polymarket integration, no crypto, no wallets, no custody, no Session Keys, no Builder integration, no CLOB, no order placement, no real-money execution, and no simulated-trading UX anywhere in the active product.

The documents archived here describe a **previous, fully abandoned direction**: a Polymarket-powered discovery/prediction/real-money-execution product, researched and partially built (simulated only — no real order was ever placed, no wallet was ever created, nothing here was ever deployed to production) across several milestones before the repivot:

| File | What it was |
|---|---|
| `prediction-market-provider.md` | Milestone 1 — read-only Polymarket market ingestion architecture |
| `prediction-market-discovery.md` | Milestone 2 — Polymarket market discovery/browsing UX |
| `execution-architecture-gate.md` | Milestone 4 — real-money execution architecture research/decision gate |
| `execution-threat-model.md` | Milestone 4 — threat model for the (never-built) real-execution capability |
| `simulated-execution.md` | Milestone 5 — simulated (no real money) Polymarket execution flow |
| `execution-operational-safety.md` | Milestone 5.5 — operational safety layer (kill switches, reconciliation, etc.) built around the simulated execution flow |
| `milestone-6-readiness.md`, `milestone-6-founder-decisions.md`, `milestone-6-provider-readiness.md`, `legal/milestone-6-counsel-brief.md`, `legal/milestone-6-legal-signoff.md` | The Milestone 6 real-execution readiness/decision-gate package — founder/counsel/provider blockers that were never resolved before the direction was abandoned |

**Do not resurrect any code, schema, or product decision from these documents without an explicit, separately-authorized new decision to re-enter real-money execution.** If a future session is tempted to reference these for "reusable patterns," check `docs/architecture/sports-prediction-network.md`'s own R0 file audit first — every genuinely reusable pattern (capability-based authorization, RLS/grant discipline, idempotency-key mutation, audit logging, permanent-record preservation) was already identified and carried forward into the active sports-prediction architecture; these documents exist for historical/audit traceability only.
