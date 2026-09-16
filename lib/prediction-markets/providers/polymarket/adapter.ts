import "server-only";
import { evaluateEligibility } from "../../eligibility";
import { POLYMARKET_PROVIDER } from "../../provider-names";
import type { MarketDiscoveryEvent, MarketEligibilityCriteria, PredictionMarketProvider } from "../../types";
import { fetchMarketsPage } from "./client";
import { extractCategoryTags, mapStatus, normalizePolymarketMarket } from "./normalize";
import { rawGammaMarketSchema, type RawGammaMarket } from "./schema";

/** Best-effort id extraction from an item that failed full schema validation — used only for failure reporting, never trusted for anything else. */
function extractBestEffortId(raw: unknown): string | null {
  if (raw && typeof raw === "object" && "id" in raw && typeof (raw as { id: unknown }).id === "string") {
    return (raw as { id: string }).id;
  }
  return null;
}

// Same "explicit env flag, false by default" convention as
// lib/sports-data/api-nfl-provider.ts's isEnabled() — kept independent
// (not derived from API_NFL_ENABLED) since this is a genuinely different
// provider domain (provider-names.ts).
function isEnabled(): boolean {
  return process.env.PREDICTION_MARKETS_POLYMARKET_ENABLED === "true";
}

// Gamma's documented page size — kept well under any plausible undocumented
// limit (roadmap STEP 2 found no documented rate limit or page-size cap;
// this is our own conservative choice, not a provider requirement).
const PAGE_SIZE = 100;
// Hard ceiling on pages fetched per call, independent of maxResults, so a
// provider that returns a cursor forever (a bug on either side) can never
// turn into an unbounded fetch loop (roadmap STEP 13).
const MAX_PAGES = 50;

function extractProviderEventId(raw: RawGammaMarket): string | null {
  const first = raw.events?.[0];
  return first && typeof first.id === "string" ? first.id : null;
}

/**
 * Read-only Polymarket adapter — the only file in this codebase allowed to
 * know Gamma's field names, and the only file that imports the Gamma HTTP
 * client. Everything it yields is already in NormalizedMarket shape
 * (lib/prediction-markets/types.ts); everything it fetches is validated
 * (schema.ts) before normalize.ts ever sees it.
 *
 * Deliberately implements only `listMarkets` — no order/trade/position
 * methods exist on this adapter, matching the roadmap's hard scope
 * boundary for Milestone 1.
 */
export const polymarketAdapter: PredictionMarketProvider = {
  name: POLYMARKET_PROVIDER,
  isEnabled,

  async *listMarkets(criteria: MarketEligibilityCriteria): AsyncGenerator<MarketDiscoveryEvent, void, void> {
    let cursor: string | undefined;
    let eligibleYielded = 0;
    let page = 0;

    // Gamma's `tag_id` filter accepts one value per request — when multiple
    // categoryTags are configured, request unfiltered and let
    // evaluateEligibility() do the (equally simple) client-side match,
    // rather than issuing N parallel requests for a Milestone-1-scale need.
    const serverSideTagId = criteria.categoryTags?.length === 1 ? criteria.categoryTags[0] : undefined;
    const serverSideClosedFilter = criteria.activeOnly ? false : undefined;

    while (eligibleYielded < criteria.maxResults && page < MAX_PAGES) {
      page += 1;
      const { rawMarkets, nextCursor } = await fetchMarketsPage({
        afterCursor: cursor,
        limit: PAGE_SIZE,
        closed: serverSideClosedFilter,
        tagId: serverSideTagId,
      });

      if (rawMarkets.length === 0) return;

      for (const rawItem of rawMarkets) {
        if (eligibleYielded >= criteria.maxResults) return;

        // Validated per-market, not per-page (schema.ts's comment on
        // rawGammaListResponseSchema) — one malformed market here is
        // reported and skipped without affecting any other item in the
        // same page (roadmap STEP 12).
        const parsed = rawGammaMarketSchema.safeParse(rawItem);
        if (!parsed.success) {
          eligibleYielded += 1;
          yield {
            kind: "eligible",
            result: {
              ok: false,
              providerMarketId: extractBestEffortId(rawItem),
              reason: `schema validation failed: ${parsed.error.message}`,
            },
          };
          continue;
        }
        const raw: RawGammaMarket = parsed.data;

        const decision = evaluateEligibility(
          {
            providerMarketId: raw.id,
            providerEventId: extractProviderEventId(raw),
            categoryTags: extractCategoryTags(raw),
            isActive: raw.active === true && mapStatus(raw) === "ACTIVE",
            liquidity: raw.liquidity != null ? Number.parseFloat(String(raw.liquidity)) : null,
          },
          criteria,
        );

        if (!decision.eligible) {
          yield { kind: "ineligible", providerMarketId: raw.id, reason: decision.reason };
          continue;
        }

        eligibleYielded += 1;
        yield { kind: "eligible", result: normalizePolymarketMarket(raw, { ingestionSource: decision.reason }) };
      }

      if (!nextCursor) return;
      cursor = nextCursor;
    }
  },
};
