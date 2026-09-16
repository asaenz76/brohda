# Prediction Market Provider — Milestone 1

**Status**: Implements `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` Milestone 1 — Read-Only Market Foundation, and only that milestone. Read-only. No orders, trades, positions, signing, custody, or execution exist anywhere in this codebase as of this document.

## 1. Milestone scope

Prove Brohda can reliably ingest real Polymarket markets through a provider-neutral abstraction, without coupling the Brohda domain to Polymarket-specific concepts, and without any user-facing product change. Target architecture:

```
Polymarket read-only APIs (Gamma)
        ↓
Polymarket adapter          lib/prediction-markets/providers/polymarket/*
        ↓
Prediction Market Provider   lib/prediction-markets/types.ts (PredictionMarketProvider)
interface
        ↓
Normalized Brohda Market     lib/prediction-markets/types.ts (NormalizedMarket)
domain
        ↓
Brohda database              supabase/migrations/20260101000135_prediction_market_foundation.sql (`markets` table)
        ↓
Internal/server-side read    lib/prediction-markets/repository.ts
interface
```

## 2. Provider-neutral interface

`lib/prediction-markets/types.ts` defines the entire contract other code depends on: `NormalizedMarket`, `MarketEligibilityCriteria`, `MarketDiscoveryEvent`, `MarketIngestionResult`, and the `PredictionMarketProvider` interface itself (`isEnabled()` + `listMarkets()` only — deliberately no order/trade/position methods, per the roadmap's hard scope boundary). Nothing outside `lib/prediction-markets/providers/polymarket/` may import from that folder directly, or read a raw Gamma field name. The domain must not know about:

- Polymarket token IDs
- Polygon
- CLOB wire-format field names
- Polymarket-specific status strings (`active`/`closed`/`archived`/`acceptingOrders`)
- raw Polymarket response objects

These are isolated inside the adapter (`lib/prediction-markets/providers/polymarket/`) and, where kept for diagnostics, inside `markets.provider_metadata` — explicitly documented (§13) as opaque, not part of the normalized contract.

**Current provider**: `POLYMARKET` (`lib/prediction-markets/provider-names.ts`).

**Provider responsibilities** (read-only, this milestone only):
- list/fetch provider markets (`listMarkets`)
- normalize provider market → `NormalizedMarket`
- map provider status → `PredictionMarketStatus`
- map prices → independent YES/NO
- expose provider identifiers (`providerMarketId`, `providerEventId`)
- expose freshness (`last_synced_at`, stamped by the repository at write time)
- expose volume/liquidity
- report provider errors (`PolymarketTransientError`/`PolymarketPermanentError`/`PolymarketValidationError`)

**Explicitly out of scope, not yet designed**: Orders, trades, positions, signing, custody, fees, execution, and cash-out. No placeholder types exist for any of these — see `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` Milestones 4-7 for where they're designed.

## 3. Why prediction-market providers are a separate domain from sports-data providers

`lib/sports-data/` answers "what happened in a real-world game" (scores, fixture status) for the legacy pool engine's own grading. `lib/prediction-markets/` answers "what does an external market currently believe" (a live price, a provider's own resolution) for the transformed product. These are different questions serving different, currently-coexisting products (`docs/PRODUCT_TRANSFORMATION_ROADMAP.md` §6 — legacy coexistence). Sharing one registry would eventually force one of the two domains' assumptions onto the other; a separate module (`lib/prediction-markets/provider-registry.ts`, modeled on `lib/sports-data/provider-registry.ts`'s pattern, not its code) keeps them independent.

## 4. Official Polymarket endpoints used, and research trail

Confirmed against `docs.polymarket.com` directly (fetched during this milestone's implementation; official docs are the primary source per the roadmap's own instruction — no inference from blog posts where the official docs were available). **Additionally live-verified against `https://gamma-api.polymarket.com` directly on 2026-09-15** (Milestone 1 field-validation sanity check) — one real discrepancy was found and fixed (noted inline below), everything else matched.

- **Gamma API** — `https://gamma-api.polymarket.com`, "the discovery layer... discover events and markets, and retrieve the metadata needed to work with them" (`docs.polymarket.com/api-reference/predictions/overview`). **Public, no authentication, no API key, no wallet** — live-confirmed: `curl` with no headers returns `HTTP/2 200`.
- **`GET /markets/keyset`** — the list endpoint this adapter calls (`docs.polymarket.com/market-data/discover-markets`). Cursor-based pagination: `limit` + `after_cursor` (not offset-based) — live-confirmed with two real consecutive pages, zero id overlap. **Live-verified envelope shape**: `{ "$schema": "...", "markets": [...], "next_cursor": "..." }` — the prose docs described the endpoint's behavior but never showed a full example body, and the original implementation assumed a `{ data: [...] }` wrapper; the real key is `markets`. Fixed in `schema.ts`/`client.ts` (both the confirmed-real `markets` key and the originally-assumed `data` key are now accepted). Filters used/available: `closed` (boolean), `tag_id`.
- **`GET /markets/{id}` / `GET /markets/slug/{slug}`** — documented but not used by this milestone's bulk-ingestion path; noted for a later milestone that needs single-market lookup by user-facing slug.
- **Market object field schema** — `docs.polymarket.com/market-data/market-details`, live-confirmed field-for-field on real active markets: `id`, `slug`, `question`, `conditionId`, `outcomes`/`outcomePrices` (arrays, **confirmed live as JSON-encoded strings**, e.g. `"outcomes": "[\"Yes\", \"No\"]"` — the defensive string-parsing in `normalize.ts` was necessary, not speculative), `clobTokenIds`, `active`/`closed`/`archived`/`acceptingOrders`/`restricted`/`negRisk` (booleans), `startDateIso`/`endDateIso`/`closedTime`, `liquidity` (**confirmed live as a string**, e.g. `"227325.46985"`; a numeric `liquidityNum` sibling field also exists but isn't used — noted as a possible future cleanup, not a correctness issue), `volume24hr` (confirmed live as a plain number), `lastTradePrice`/`bestBid`/`bestAsk`/`spread` (CLOB-sourced, present on the Gamma object but not used for this milestone's normalized price — see §7). **Correction**: `endDateIso`/`startDateIso` are live-confirmed **date-only** strings (e.g. `"2027-01-01"`), not full ISO 8601 timestamps as originally documented — `endDate`/`startDate` (different fields) carry the full timestamp instead. This milestone only reads `endDateIso`/`startDateIso`, which still parse correctly as plain strings; nothing breaks, but the earlier "ISO 8601" description was imprecise.
- **Resolution fields** — `umaResolutionStatus`, `resolvedBy` (confirmed via search of Polymarket's own GitHub issues/SDKs referencing these field names). **Live-confirmed nuance**: `resolvedBy` is populated with a designated resolver address on fully active, unresolved markets (`active: true, closed: false`) — it is not itself a "this market has resolved" signal, consistent with §15's existing caution against treating these fields as an exhaustively-understood enum.
- **CLOB API** — `https://clob.polymarket.com`, "Read live market state, then place and manage orders." Its read endpoints (best bid/ask, midpoint, last trade) are also public and unauthenticated, but **this milestone does not call the CLOB API at all** — Gamma's own `outcomePrices` is used as the normalized price source (see §7 for why).
- **Data API** — `https://data-api.polymarket.com`, for account/position activity. Not used — no account/position concept exists yet.
- **Authentication**: none required for any endpoint this milestone calls.
- **Rate limits**: no documented rate limit was found in the official docs pages fetched. This codebase applies its own conservative, undocumented-by-Polymarket defaults (3-attempt retry with exponential backoff, a 100-market page size, a 50-page hard ceiling per run) — see `client.ts`/`adapter.ts` — not because the provider requires them, but as ordinary defensive engineering.
- **WebSockets**: confirmed optional for reading market data ("REST APIs... provide programmatic access... without requiring WebSocket subscriptions"). Not used by this milestone; polling via `/markets/keyset` only.
- **A real, documented data-quality caveat**: Polymarket/rs-clob-client#199 (public GitHub issue) reports Gamma marking ended AFCON matches as still `active`/`acceptingOrders` after the match concluded. This milestone's status mapping (§6) reflects the provider's own field semantics, not verified real-world ground truth, and this limitation is stated explicitly rather than papered over.

## 5. Raw → normalized field mapping

| Raw Gamma field | Normalized field | Notes |
|---|---|---|
| `id` | `providerMarketId` | Required; validation fails without it. |
| `events[0].id` | `providerEventId` | Best-effort; null if absent. |
| `question` | `question` | Required. |
| `description` | `description` | Nullable. |
| `active`/`closed`/`archived` | `status` | See §6. |
| `outcomes`/`outcomePrices` | `price.yes`/`price.no`/`price.outcomeLabels` | See §7. |
| `liquidity` (string or number) | `liquidity` | Parsed to number; null if unparseable — never coerced to 0. |
| `volume24hr` | `volume24hr` | Same parsing rule. |
| `umaResolutionStatus` | `resolutionStatus` | Raw pass-through, not a normalized enum (§15). |
| `resolvedBy` | `resolvedBy` | Raw pass-through. |
| *(not derived)* | `resolvedOutcome` | Always `null` in Milestone 1 (§15). |
| `startDateIso` | `opensAt` | |
| `endDateIso` | `closesAt` | |
| `closedTime` | `closedAt` | |
| *(ingestion's own clock)* | (stamped at write time as `markets.last_synced_at`) | No confirmed provider "last updated" field was found — see §15. |
| entire raw object + extracted category tags | `providerMetadata` | Diagnostic only, not part of the normalized contract (§2). |

## 6. Market status mapping

```
archived === true → ARCHIVED   (provider docs: "read-only, no updates" — most terminal)
closed === true   → CLOSED     (provider docs: "resolved; trading no longer possible")
active === true   → ACTIVE
otherwise         → INACTIVE   (no positive evidence the market is tradeable — not assumed CLOSED)
```

Explicit, tested (`tests/unit/prediction-markets/polymarket-normalize.test.ts`), and documented as an interpretation of four independent booleans, not a 1:1 provider passthrough — see `normalize.ts`'s `mapStatus` for the full reasoning, including the AFCON staleness caveat from §4.

## 7. Price semantics

`price.yes` and `price.no` are read **independently** from the `outcomes`/`outcomePrices` arrays, matched by label (case-insensitive `"yes"`/`"no"`). **`no` is never computed as `1 - yes`** — nothing in Polymarket's documentation guarantees the two sum to exactly 1 at every instant, and deriving one from the other would misrepresent a computed value as an observed one. If either label can't be found, or the arrays are missing, mismatched in length, or unparseable (including the documented JSON-encoded-string variant), that side is `null` — never `0`, never a stale/last-known value silently substituted.

**Why Gamma's `outcomePrices`, not the CLOB's `bestBid`/`bestAsk`/`lastTradePrice`**: this milestone is catalog-level discovery/ingestion (up to a few dozen markets per run, on no fixed schedule), not live execution pricing. Gamma's own market object already carries a documented current-price field per outcome, sourced from the same underlying market. The CLOB's order-book-level fields (`bestBid`/`bestAsk`/spread) are more relevant to a future milestone that needs an executable quote at the moment of order submission — noted explicitly as a known limitation (§15), not silently conflated with this milestone's normalized price.

## 8. Volume/liquidity semantics

`liquidity` and `volume24hr` are read from Gamma's own fields of the same purpose, parsed defensively (Gamma has been observed returning both as strings and as numbers across different fields/deployments — `normalize.ts`'s `parseNumeric` handles both, returning `null` on anything unparseable rather than `0`).

## 9. Pagination

Cursor-based (`limit` + `after_cursor`), matching Gamma's documented `/markets/keyset` contract. The adapter (`adapter.ts`) terminates on: an empty page, an absent `next_cursor`, `criteria.maxResults` eligible markets yielded, or a hard `MAX_PAGES` ceiling (50) — the last one specifically so a provider bug (or ours) returning a cursor forever can never become an unbounded fetch loop. Tested for single-page, multi-page, and empty-page cases (`tests/unit/prediction-markets/polymarket-adapter.test.ts`, `polymarket-client.test.ts`).

## 10. Selective-ingestion mechanism

`lib/prediction-markets/eligibility.ts` implements the roadmap's required curation boundary:

```
Provider market universe → Brohda eligibility/curation → normalized Brohda catalog → (future) consumer discovery feed
```

`MarketEligibilityCriteria` supports explicit market-id/event-id allowlists, a category-tag filter, an active-only flag, and a minimum-liquidity threshold — checked in a fixed, explicit order, each with an attributable reason string stored as `markets.ingestion_source`. **No recommendation or ranking logic exists.** The actual consumer-facing category/topic strategy is an explicit open decision left to Milestone 2 (`docs/PRODUCT_TRANSFORMATION_ROADMAP.md` §9 OPEN #9) — this milestone only proves selective ingestion is architecturally possible, and defaults (in `scripts/ingest-prediction-markets.ts`) to `activeOnly: true` with a small `maxResults`, never "ingest everything."

## 11. Persistence model

One table, `public.markets` (`supabase/migrations/20260101000135_prediction_market_foundation.sql`), additive-only — no legacy pool/entry/settlement table is touched or referenced by FK. Upsert is keyed on the `unique (provider, provider_market_id)` constraint (`lib/prediction-markets/repository.ts`'s `upsertMarket`): the first ingestion of a given provider market inserts; every subsequent ingestion updates the same row, preserving its Brohda `id`. No `orders`/`trades`/`positions`/`wallets`/`signing` table exists — those are later milestones' schema decisions.

## 12. Failure behavior

Read-only, so a failure must never destroy previously-valid data:

- **Per-market isolation**: one malformed market (fails Gamma schema validation, or fails to persist) is caught, counted as `failed`, and reported with a reason — every other market in the same page or run is still processed (`ingest.ts`, `adapter.ts`; tested explicitly in both).
- **Per-run isolation**: `upsertMarket` only ever inserts-or-updates the specific row it's given — there is no "clear the table, then repopulate" step anywhere in the ingestion path, so a thrown provider error partway through a run leaves every already-ingested row exactly as it was (tested in `tests/integration/prediction-markets.test.ts`).
- **HTTP-level classification** (`client.ts`): network errors, 5xx, and 429 are retried with exponential backoff (3 attempts); other 4xx errors and schema-validation failures are never retried, since an immediate retry of a permanently-invalid request or response would only waste the same request budget.

## 13. Security / RLS model

- `markets` has RLS enabled with **no policy for `anon` or `authenticated`** — deny-by-default for direct client access, matching this codebase's existing precedent for tables with no consumer need yet (`background_jobs`/`cron_job_locks`, per the architectural audit's §8). Milestone 1 has no consumer surface; a read policy is Milestone 2's decision to make.
- **All writes are server-only**, via `lib/supabase/admin.ts`'s existing service-role client — `grant select, insert, update, delete on public.markets to service_role` only.
- **No `SECURITY DEFINER` function was introduced.** Given this project's own history of two prior EXECUTE-grant-drift incidents (`20260101000107`, `20260101000134` — the second found and fixed in the same session that produced the architectural audit this milestone builds on), the simplest and safest choice for a brand-new, non-financial table was to skip RPCs entirely and use plain service-role table access instead, per the roadmap's own preference for that default. There is therefore no new privileged-function grant surface to verify for this milestone — confirmed by inspecting the migration itself (no `create function`/`security definer` statement appears in it).

## 14. Production-scheduling status

**No production auto-sync exists.** `scripts/ingest-prediction-markets.ts` is a manually-invoked script (`pnpm ingest-prediction-markets`) — nothing in this codebase's Vercel config, GitHub Actions, or any external scheduler (cron-job.org) invokes it. The adapter itself is gated behind `PREDICTION_MARKETS_POLYMARKET_ENABLED` (default: unset/false, mirroring `API_NFL_ENABLED`'s existing convention), so even a future accidental wiring-up would no-op unless someone deliberately flips that flag.

## 15. Known limitations

- **Resolution outcome is never derived in Milestone 1.** `markets.resolved_outcome` exists in the schema but is always `null` — `resolutionStatus`/`resolvedBy` are raw, provider-specific diagnostic pass-through, not a confirmed, exhaustively-documented enum. A future milestone building real settlement reconciliation should research Polymarket's resolution representation properly (ideally against a market that has actually resolved, observed live) before this becomes load-bearing, rather than inheriting an unverified heuristic from this one.
- **No confirmed provider "last updated" timestamp field.** `markets.last_synced_at` is Brohda's own ingestion clock, which is a genuine freshness signal (it tells you how long it's been since Brohda last asked Polymarket about this market) but is not the same as Polymarket's own last-price-change time, which was not confirmed present on the Gamma market object during this milestone's research.
- **Live execution pricing is out of scope.** `price.yes`/`price.no` come from Gamma's catalog-level `outcomePrices`, not the CLOB's live order book (`bestBid`/`bestAsk`). A future milestone building an execution-preview quote (roadmap Milestone 5) should read the CLOB directly for that purpose, not assume this milestone's stored price is fresh enough to execute against.
- **Provider status fields can lag real-world events** (§4's AFCON example) — `status` reflects Polymarket's own reporting, not independently verified ground truth.
- **No documented Polymarket rate limit was found**; this codebase's retry/backoff/page-size defaults are our own conservative choices, not provider-mandated values, and should be revisited if Polymarket publishes explicit limits later.
- **Category/topic taxonomy is not solved here.** `provider_metadata._categoryTagsExtracted` captures whatever tag information Gamma returns, for later use — Milestone 2 decides the actual consumer-facing category strategy.
- **Selective ingestion via a small explicit allowlist can scan far more pages than necessary.** Live-verified: `listMarkets({ explicitMarketIds: ["one-id"] })` correctly returned only that one market (no correctness issue), but the adapter kept paging toward `maxResults` — scanning up to its `MAX_PAGES` ceiling (5,000 markets) — rather than recognizing that an allowlist of size N can never yield more than N eligible markets and stopping once all N are found or exhausted. Purely an efficiency inefficiency in the loop's stopping condition, not a correctness bug (final results were exactly right, and the existing `MAX_PAGES` ceiling still bounds the worst case) — worth tightening in a later pass, not fixed here since it doesn't affect Milestone 1's correctness guarantees.

## 16. Future boundary — Prediction

Not implemented. `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` Milestone 3 defines the permanent Brohda Prediction record (a user's belief at a moment in time) as an independent object from both `Market` (this milestone) and any future `Position`. Nothing in this milestone creates, references, or assumes a Prediction table.

## 17. Future boundary — Order

Not implemented, not designed. No `orders` table, no order-submission method on any adapter, no order-status vocabulary exists anywhere in this codebase. Roadmap Milestone 6.

## 18. Future boundary — Trade

Not implemented, not designed. No concept of a partial fill, a matched trade, or trade-level reconciliation exists. Roadmap Milestone 6.

## 19. Future boundary — Position

Not implemented, not designed. No `positions` table, no current-value/cost-basis/P&L concept exists. Roadmap Milestone 7.

## 20. Signing, custody, and execution remain unimplemented

No wallet, signing key, embedded-wallet provider, or custody model of any kind exists in this codebase as of this milestone. No code path moves real money, submits a real order, or holds a private key. That decision is explicitly gated behind `docs/PRODUCT_TRANSFORMATION_ROADMAP.md` Milestone 4 — the Execution Architecture hard gate — and nothing in this milestone anticipates or assumes its outcome.
