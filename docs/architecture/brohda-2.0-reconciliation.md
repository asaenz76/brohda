# Brohda 2.0 — Architecture Reconciliation (Milestone R0.5)

**Status: AUDIT RECORD, not an implementation spec.** This document records what R0.5 verified to be true of the repository on 2026-09-21, and what the proposed "Brohda 2.0" social/P2P product direction would eventually require. It does **not** authorize building anything listed under "Target state" — see `docs/BROHDA_2_0_MILESTONE_MAP.md` for what is actually authorized, milestone by milestone.

**R1 update (2026-09-21):** Milestone R1 (Game ↔ Market Foundation) has since closed the specific gap §3 below describes (`markets` had no real relationship to `fixtures`). This document's findings are left exactly as R0.5 recorded them — they were true at the time and are the evidentiary basis R1 was built on — see `docs/architecture/game-market-foundation.md` for what actually changed.

This document exists because R0's own docs (`docs/PRODUCT_TRANSFORMATION_ROADMAP.md`, `docs/architecture/sports-prediction-network.md`) describe a `markets`/`PredictionQuestion` architecture that Brohda 2.0's canonical model (`GAME → POST → MARKET → PICK → CHALLENGE → MONETARY POSITION`) partially contradicts. Rather than silently editing R0's docs to match an unbuilt future, this document is the single place that says, explicitly, "here is what R0 got right, here is what R0.5 found incomplete, here is what's still undecided."

---

## 1. Canonical object mapping — current state vs target state

| Brohda 2.0 concept | Current-state answer (verified) | Classification |
|---|---|---|
| **Game** | `fixtures` (`supabase/migrations/20260101000008_fixtures.sql`) — provider, external id, teams, venue, scheduled time, a rich `fixture_internal_status` enum already covering `POSTPONED`/`SUSPENDED`/`ABANDONED`/`CANCELLED`/`AWARDED`, live scores. This is a far more complete "canonical sports truth" object than anything in the `markets` table. | **KEEP as Game.** No new SportsEvent table needed. |
| **Market** | `markets` (`supabase/migrations/20260101000135_prediction_market_foundation.sql`) — single mutable row per market, `provider_event_id` is a **loose text field, not a foreign key** to `fixtures.id`. Confirmed via schema read and a grep for any FK between the two tables: none exists. | **REPURPOSE, with a gap.** The row shape (question/status/prices) is workable, but Market↔Game is currently **not a real relationship** — see §3. |
| **Pick** | `predictions` (`supabase/migrations/20260101000141_predictions.sql`) — write-once (`createPrediction` is the only mutation in `lib/predictions/*`/`lib/actions/predictions.ts`; no update/edit action exists at all), soft-referenced to `markets` by plain `market_id` uuid, snapshots probability permanently. No unique constraint on `(user_id, market_id)` — "one pick per market" is an app-level check only, not DB-enforced. | **KEEP as Pick, mostly.** Semantics already match (non-monetary opinion, no wallet). Adding "lock/change until T-10" would be a pure addition, not a rework — there is nothing today that lets a Pick be edited, so there's nothing to un-teach. |
| **Post** | Does not exist. Confirmed: no `posts` table anywhere in `supabase/migrations`, no "Post" abstraction in `lib/`. `/feed` and `/markets` are both single global lists, not per-Game canonical objects distributed into feeds. | **ADD.** Net-new object and net-new schema. |
| **Community** | Does not exist as a membership/feed-owning object. `discovery_categories` (`supabase/migrations/20260101000137_discovery_taxonomy.sql`) is a pure admin-managed tag list — no membership table, no RLS grant to `authenticated`, reads happen server-side only. `team_follows`/`league_follows` are private per-user notification preferences (email toggle on a team/league), not a public community. | **ADD.** `discovery_categories` and `team_follows`/`league_follows` are the closest existing analogs but are structurally filters/preferences, confirmed not communities. |
| **Comment** | `pool_comments` exists (`supabase/migrations/20260101000017_pool_comments.sql`, extended `20260101000031_comment_replies.sql`) — one level of nesting, SECURITY DEFINER RPCs (`add_pool_comment`/`delete_pool_comment`), mention notifications. **Scoped only to `pools`, not to `markets`/predictions, and not to any future `Post`.** | **REPURPOSE the pattern, not the table.** The RPC/rate-limit/notification pattern is proven and worth mirroring for Post-scoped comments; the table itself is pool-specific today. |
| **Challenge** (free) | Does not exist. No table, RPC, or UI concept of one user challenging another over opposing Picks. | **ADD — and unresolved:** the only two candidate "who beat whom" ledgers in the repo (`entries`/`settlements`) are pool-cardinality concepts (N entrants splitting a pot), not a 2-party record. Nothing to repurpose here beyond the general RPC/locking patterns in §4. |
| **Challenge** (monetary) / **Monetary Position** | Does not exist, and **must not be built from `lib/execution/*`** (deleted in R0 — Polymarket/CLOB/OrderIntent/exchange-execution architecture, dead by explicit product decision). The closest *reusable* primitive is the legacy pool wallet/ledger (§2). | **ADD**, on top of existing wallet/ledger — see §2 for exactly what is and isn't reusable. |
| **Reputation inputs** | `user_profiles.prediction_correct_count` / `prediction_incorrect_count` / `prediction_current_streak` / `prediction_best_streak` already exist as columns (`supabase/migrations/20260101000142_prediction_policy_and_reputation_hooks.sql`), added and deliberately left unpopulated/deferred (R0's own docs cite this as intentional, mirroring the Milestone-3-era streak deferral). | **KEEP, still deferred.** Columns exist; no writer populates them yet. Not a gap introduced by R0.5 — a pre-existing, documented deferral. |

---

## 2. Financial infrastructure — what's reusable for a P2P Monetary Position

Full evidence trail: `lib/actions/entries.ts`, `supabase/migrations/20260101000007_wallet.sql`, `20260101000009_pools.sql`, `20260101000010_settlements.sql`, `20260101000053_wallet_transaction_context_snapshot.sql`, `20260101000056_wallet_transaction_destination.sql`, `20260101000128_free_mode_create_pool_entry.sql`.

**Reusable as-is:**
- `wallet_balances` / `wallet_transactions` / `apply_wallet_transaction(...)` are **already provider- and product-neutral**. `apply_wallet_transaction`'s `p_pool_id`/`p_entry_id`/`p_settlement_id` parameters are optional and already called with all three `null` for plain `manual_deposit`/`manual_withdrawal` transactions today. A bilateral debit/credit pair could be built directly on this RPC (call it twice, shared idempotency-key prefix, pool fields left null) without touching its signature.
- The **idempotency-key pattern** (explicit key argument, checked first, short-circuits on retry) is proven across three call sites (`apply_wallet_transaction`, `create_pool_entry`, `wallet_requests`) and should carry forward unchanged.
- The **`SELECT ... FOR UPDATE` row-lock concurrency model** is proven (used for `wallet_balances`, `pools`, `settlements` rows) and generalizes to a bilateral position without new primitives.
- **`default_house_fee_bps`-style basis-point fee configuration** is an existing, precedented pattern (`pools.house_fee_bps`, capped 0–10000) — a P2P monetary-position fee could mirror this shape.

**NOT reusable — genuinely pool-shaped, would need new tables/logic:**
- **There is no reserved/held balance concept anywhere in the schema.** `wallet_balances` has exactly one `balance bigint` column. A grep across every migration and `lib/` for `available_balance|reserved_balance|held_balance` returns zero financial hits. This is the single most important gap: the entire "challenger's stake becomes unavailable but not yet transferred" mechanic in the Milestone R0.5 task's funding-rules section (and the André/Carlos trace scenario) **has no structural support today** and would require new schema (at minimum, a reservation/hold table or a computed-available-balance view over a new holds ledger) — not just new application logic on top of the existing single-number balance.
- `entries` hard-requires `pool_id not null references pools(id)` and `option_id not null references pool_options(id)` — there is no entry that isn't pool-shaped.
- `create_pool_entry` is a **single atomic debit at entry time** (not reserve-then-capture) — it debits the wallet in the same transaction as the entry insert, with no intermediate "held" state.
- `prepare_pool_settlement`/`confirm_pool_settlement` compute a pari-mutuel N-way split (`net_prize_pool / winning_entry_count`) hardwired to `pool_options` matched against fixture team IDs — for a 1v1 wager this degenerates correctly in the math, but the win-determination logic itself has no generic "party A vs party B" shape.
- `wallet_transaction_type` is a closed Postgres enum (11 values, confirmed never altered) — none of the existing values name a bilateral wager; a P2P type (e.g. `p2p_position_debit`/`p2p_position_credit`) would need a new enum value added via migration.

**Conclusion:** the ledger's *money-moving primitive* (`apply_wallet_transaction`) is safe to reuse unchanged. The *reservation/hold semantics* required by the Monetary Challenge funding rules do not exist today at any layer and are the primary net-new financial design surface for a future milestone — this is flagged, not designed, here.

---

## 3. The Market↔Game gap

`markets.provider_event_id` is a best-effort text field, never a foreign key to `fixtures.id`. Additionally, `upsertMarket` — the only write path into the `markets` table — has **zero current callers** anywhere in the codebase (its sole caller, the Polymarket ingestion script, was deleted in Milestone R0). This means, as of this audit, the `markets` table has no live ingestion pipeline at all; it is schema without a producer.

This is a real gap in R0's own architecture, not a Brohda-2.0-specific problem: a genuine `Market → Game` relationship (foreign key to `fixtures.id`) needs to be **added** regardless of the social-layer work, because "one Post per Game, one or more Markets per Post" cannot be expressed while Market and Game are only connected by a loose text field. No migration is created here; this is a finding for the roadmap in §5.

---

## 4. Reusable RPC/security patterns (apply broadly, not domain-specific)

Confirmed proven across the codebase and worth deliberately carrying into every Brohda 2.0 addition:
- **SECURITY DEFINER RPC + no direct client grant** for any state-changing social action (`add_pool_comment`, `toggle_pool_like`, `is_following`) — client roles get `SELECT` at most; every write is mediated.
- **Append-only + `forbid_audit_log_mutation()` trigger pattern** for anything that must never be edited post-write (`wallet_transactions`, `audit_logs`) — directly applicable to a future Challenge/Position ledger.
- **Plain-uuid soft references, never FK, for permanent-history rows** (`wallet_transactions.pool_id`/`entry_id`/`settlement_id`, `audit_logs.entity_id`) — the migration history shows this was tried as a real FK once and reverted after hitting exactly the "referenced row became permanently undeletable" failure. Any new Challenge/Position history table should default to this pattern from day one.
- **Table-privilege-hygiene regression gate** (`tests/integration/table-privilege-hygiene.test.ts`) — its `REPRESENTATIVE_TABLES` list must be extended with any new financial or social table added in a future milestone; it is not automatic.

---

## 5. Roadmap status

`docs/PRODUCT_TRANSFORMATION_ROADMAP.md`'s R1–R9 sequence was written before this audit and assumed `markets` could become `PredictionQuestion` and `predictions` could stand alone without a social layer. That assumption is **not wrong**, but it is **incomplete** — it never accounted for Post/Community/Challenge/Monetary Position. The roadmap document has been given a status note pointing here rather than being rewritten wholesale; a resequenced R1+ proposal is in the R0.5 completion report, not in this file, pending founder review.

---

## 6. What this document is not

This document does not define final schema, does not decide open product questions (line-versioning, push/void handling, event-timing-change policy, Challenge-plus-provider-correction interaction, Community identity rules, whether Comments should ever be Market-scoped) — those are listed as open in the R0.5 completion report. It does not authorize any migration, table, or code change. It supersedes no security or production-safety rule in `CLAUDE.md`.
