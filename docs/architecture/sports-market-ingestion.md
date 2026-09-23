# Sports Market Ingestion (Milestone R2)

**Status**: Implements `docs/BROHDA_2_0_MILESTONE_MAP.md` Milestone R2 in full. Records CURRENT STATE only — see `docs/architecture/game-market-foundation.md` (R1) for the schema this writes into, and `docs/architecture/brohda-2.0-reconciliation.md` for the R0.5 audit that first found `markets` had no live writer at all.

## Provider boundary

**One real provider, one clean boundary**: `api_nfl` (American football), via the already-live `apiNflProvider.getFixtureRawOdds()` (`lib/sports-data/api-nfl-provider.ts`) — the exact same function that already backs the legacy pool-creation wizard's line prefill (`lib/actions/odds.ts`). No new provider client was written. No generic multi-provider odds abstraction was introduced — `lib/sports-data/types.ts` already documents, from direct experience with the now-retired `api_football` provider, that a shared cross-sport odds shape "fights every provider except the one it was modeled on"; R2 follows that same established precedent rather than reversing it.

Raw provider odds are parsed into `NormalizedNflFixtureOdds` (`bookmakers: NflBookmakerOdds[]`, each carrying raw `moneyline`/`asianHandicap`/`gameTotal`/`homeTeamTotal`/`awayTeamTotal` value/odd pairs, exactly as the provider labels them, e.g. `"Over 47.5"`) entirely inside the existing provider adapter — R2's own code never touches a raw HTTP response.

**Live verification (2026-09-21, read-only)**: performed directly against the real API-NFL `/odds` endpoint using credentials already present in `.env.local`, bypassing the app's own Supabase-backed cache to guarantee zero Supabase writes (hosted or local). Confirmed live: bet id 1 ("Home/Away") is the moneyline, bet id 3 ("Over/Under") the game total, bet ids 8/9 ("Total - Home"/"Total - Away") the team totals — all exactly matching the existing adapter's bet-id mapping. Also reproduced, with fresh data, the exact Asian Handicap ambiguity `lib/pools/templates/nfl-odds.ts`'s own header already documents from a real past incident (a "Home -1" entry priced identically to that bookmaker's moneyline "Home" price — not a coherent spread quote). This directly motivates §"Why SPREAD is not ingested" below.

## Normalized observation

No new "normalized observation" type was introduced beyond the existing `NormalizedNflFixtureOdds`/`NflBookmakerOdds` — R2 consumes that shape directly. Odds arrive as decimal already (API-NFL's native format); no format conversion was needed.

## Fixture matching

Every odds observation is fetched **by Brohda's own canonical fixture's `external_fixture_id`** (`apiNflProvider.getFixtureRawOdds(fixture.externalFixtureId)`) — there is no separate "match a provider event to a fixture" step, because the fixture *is* the query key. A fixture with no odds posted yet (common — only a minority of upcoming games had odds live during verification) or a provider fetch failure both resolve to the same safe outcome: skip that fixture entirely, write nothing.

## Approved Market templates

| Template | Ingested automatically? | Source bet | Aggregation |
|---|---|---|---|
| **MONEYLINE** | Yes | bet id 1 ("Home/Away") | Per-bookmaker de-vig (`devig2Way`), median across bookmakers, anchored to HOME |
| **TOTAL** | Yes | bet id 3 ("Over/Under") | Per-point-value de-vig + median; the point closest to a 50/50 split is selected as current |
| **SPREAD** | **No — deliberately excluded** | bet id 2 ("Asian Handicap") | Not implemented |

### Why SPREAD is not ingested

`lib/pools/templates/nfl-odds.ts`'s own header comment documents a real production incident: the smallest-offered Asian Handicap magnitude was assumed to approximate the true closing spread, and this was disproven live (estimated 1.5, real line was 6). That module's current heuristic (pick the magnitude whose fair probability is closest to 50/50) is explicitly still labeled "UNCONFIRMED... needing manual verification," not something R2 can inherit with confidence for **automated, ungraded-by-a-human, permanently-recorded** canonical Markets. R2's own live verification reproduced the same class of ambiguity with fresh data. Per the milestone's own instruction ("if an upstream provider market cannot be translated into an unambiguous approved binary proposition, DO NOT ingest it"), SPREAD ingestion is not implemented — this is a genuine, evidence-based technical limitation, not a configurable product choice (see the hard-coding audit in the R2 completion report).

### MONEYLINE binary-semantics review (§8)

Reviewed against R1's `MONEYLINE draw = NO` rule: live-verified API-NFL data confirms bet id 1 is a genuine two-way `Home`/`Away` market with **no draw outcome offered at all** (American football has no regulation ties in the sportsbook's own market structure — the rare real-world tie is not a priced outcome here). There is no three-way moneyline in this provider's NFL data, so R1's binary rule is not falsified for this sport/provider and required no correction. This finding is specific to `api_nfl`/American football — it is not asserted as a universal sports truth, and any future sport/provider with a genuine three-way market must not be silently forced into this same binary rule.

## Market creation and identity

Ingestion writes through `upsertMarket` (R1) — no parallel write path. Canonical identity is synthesized per proposition, since API-NFL has no native "market id" concept (odds are posted per-fixture, not per-market):

- MONEYLINE: `providerMarketId = "{externalFixtureId}:MONEYLINE"` — one identity per fixture, forever (no line to move).
- TOTAL: `providerMarketId = "{externalFixtureId}:TOTAL:{line}"` — the line is embedded in the identity key itself, so a moved line naturally becomes a different key.

This means `upsertMarket`'s own existing (provider, provider_market_id) upsert logic does the identity-vs-price distinction for free: same key → UPDATE in place (price refresh only, R1's immutability trigger sees no identity-column change); new key → INSERT (a genuinely new proposition). R1's trigger is the enforced backstop, not the only guard — R2 never even attempts to construct an UPDATE that would change an identity column.

## Line movement and current/preferred behavior

When TOTAL's consensus line differs from the fixture's currently-`ACTIVE` TOTAL Market (`getActiveMarketByFixtureAndTemplate`), the old row is set to `status = 'INACTIVE'` (`deactivateMarket`) **before** the new line's row is upserted — never the reverse, so there is never a moment with two `ACTIVE` TOTAL Markets for one fixture. The old row's identity columns are never touched; only `status` changes. If the line later reverts to a previously-seen value, the dormant row for that value is naturally reactivated (its price gets refreshed and `status` flips back to `ACTIVE`) rather than creating a third duplicate — proposition uniqueness makes this the only possible outcome.

**Existence vs. visibility**: no new column or table was introduced for this. R1's own `status` field, combined with the already-existing `deriveConsumerStatus` (`ACTIVE` → discoverable, everything else → not), is sufficient — an `INACTIVE` superseded Market silently stops appearing in discovery while remaining permanently intact in the database for any Prediction that already referenced it.

## Historical retention

No new raw-observation-history table was introduced. Retention is: one row per proposition ever offered (permanent, per R1), each carrying only its own current price/probability — not a time series of every observation. This was judged sufficient because the only consumer that needs historical odds context is a Prediction's own permanent snapshot (`predictions.yes_probability_snapshot`/`no_probability_snapshot`), captured once at Pick time and already fully decoupled from the Market row's current state (R1, unchanged). Nothing in R2 required raw per-observation retention beyond that.

## Bookmaker policy

No curated bookmaker allowlist — API-NFL's bookmaker catalog carries no reputability metadata to curate from (same reasoning `nfl-odds.ts` already documents), so every bookmaker offering a usable, parseable price is included; median aggregation is the robustness mechanism against any single outlier, not curation.

**Configurable** (`platform_settings`, migration `20260101000149`):
- `market_ingestion_enabled` (boolean, default `false`) — master switch; an unreadable settings row also resolves to `false` (fail-closed, since this gates a write action).
- `market_ingestion_min_bookmaker_count` (integer, default `2`) — minimum independent bookmakers required, evaluated **per proposition** (a TOTAL's alternate lines are not pooled together — each specific point value needs its own sufficient evidence).

**Not configurable, and why**: enabled sports/leagues/competitions. There is currently exactly one supported sport, provider, and competition (NFL is API-NFL's only competition). A configuration axis with exactly one possible value would be speculative, not evidence-based — this is documented as a deliberate non-implementation, to be revisited only when an actual second sport/competition exists.

## Probability / vig methodology

Standard proportional de-vig (`devig2Way`, already shared/generic, unmodified): each side's raw implied probability (`1/decimalOdds`) is divided by the sum of both sides' implied probabilities, distributing the bookmaker's margin proportionally rather than assuming it sits entirely on one side. Cross-bookmaker aggregation is the **median** of each bookmaker's independently de-vigged probability — not a weighted average, not the single best price — for the same reason the existing wizard-prefill code already chose median: robust to one outlier book without needing a curated-bookmaker allowlist.

## Freshness

No new freshness concept was introduced for ingestion itself — `markets.last_synced_at` is set to the ingestion run's own timestamp on every write (unchanged `upsertMarket` behavior), and the **existing** downstream policy that already governs whether a user can act on a price (`lib/predictions/policy.ts`'s `prediction_allow_stale_price`, keyed off that same timestamp) applies to ingested sports Markets exactly as it already did to any other Market row — no new column, no new policy needed.

## Failure handling

- Provider returns no data (not enabled, no odds posted, fetch throws): the fixture is skipped entirely — zero writes, canonical state for every other fixture is unaffected.
- Insufficient bookmakers for a given template/line: that template is skipped for that fixture — no malformed or thinly-evidenced Market is ever created.
- One fixture's ingestion throwing an unexpected error does not abort the run: `runNflMarketIngestion` catches per-fixture and records the failure in its summary, continuing to the next fixture.
- Malformed/unparseable odds entries (failing the `"Over 47.5"`/`"Home"` value-shape regex) are silently excluded from that bookmaker's contribution — never crash the aggregation, never get treated as a usable price.

## Concurrency and idempotency

Idempotent by construction: re-running ingestion against unchanged provider data reproduces the exact same `provider_market_id` for every proposition, so `upsertMarket` always resolves to the same row (verified: three consecutive runs with identical mocked data never create more than one row per template). Concurrency is backstopped by R1's own database uniqueness constraint (`markets_sports_proposition_unique`) — two overlapping ingestion calls racing to insert the same new proposition can only ever leave one row committed; verified directly with two concurrent `ingestNflMarketsForFixture` calls in the test suite.

## Configuration ownership summary

| Concern | Owner | Why |
|---|---|---|
| Enabled sports/templates for automatic ingestion | Hard-coded (MONEYLINE, TOTAL only) | Genuine current technical/data-quality limitation (SPREAD), not product policy — see above |
| Ingestion master switch | `platform_settings.market_ingestion_enabled` | Same domain as existing `paid_pools_enabled`/`free_pools_enabled` feature-flag precedent |
| Minimum bookmaker count | `platform_settings.market_ingestion_min_bookmaker_count` | Same domain as existing `prediction_*` eligibility columns |
| Provider credentials | `API_NFL_KEY`/`API_NFL_ENABLED`/`API_NFL_BASE_URL` environment variables | Unchanged — existing mechanism, never stored in the database |
| Price freshness at prediction time | `platform_settings.prediction_allow_stale_price` (existing, unmodified) | Already the correct owner; nothing new needed |

## Operational execution

Three callers, one function, no parallel logic — mirroring the established `sync-fixtures-nfl`/`grade-predictions` precedent exactly:
- `runNflMarketIngestion()` (`lib/prediction-markets/ingestion/nfl.ts`) — the actual job.
- `app/api/cron/ingest-nfl-markets/route.ts` — bearer-secret-gated, wrapped in `recordJobRun` (overlap lock + `background_jobs` history, reusing the existing generic mechanism unchanged).
- `pnpm ingest-nfl-markets` (`scripts/ingest-nfl-markets.ts`) — manual/developer invocation, matching `grade-predictions`'s own script shape.

No actual external scheduler entry (Vercel Cron, cron-job.org, etc.) was created — none exists in this repository for `sync-fixtures-nfl` either; wiring one is an operational decision outside repository scope, not something this milestone should invent.

## What R2 explicitly does not do

No Posts, no Communities, no Pick editing, no Comments, no Challenges, no wallet/reservation changes, no Monetary Positions, no P2P settlement. No SPREAD ingestion (see above — a real, current, evidence-based limitation, flagged for a future milestone to resolve, not silently worked around). No generic multi-provider abstraction.
