// Raw Gamma API response validation. Confirmed against official Polymarket
// documentation (docs.polymarket.com/market-data/market-details,
// docs.polymarket.com/market-data/discover-markets — see
// docs/architecture/prediction-market-provider.md's research notes for the
// exact pages and dates checked). Only `id` and `question` are required —
// every other field is optional/nullable, because real Gamma responses have
// documented gaps (e.g. the AFCON tournament issue where ended matches were
// still marked active/accepting orders — GitHub Polymarket/rs-clob-client
// #199), and a market missing a non-essential field is degraded data, not
// invalid data.
//
// `.passthrough()` deliberately keeps every field this schema doesn't name
// — normalize.ts stores the full raw object into `markets.provider_metadata`
// for diagnostics, so a field this codebase doesn't yet understand is never
// silently discarded.
import { z } from "zod";

// Gamma has been observed returning `outcomes`/`outcomePrices`/`clobTokenIds`
// as either a real JSON array or a JSON-encoded string of that array
// (confirmed in docs.polymarket.com/market-data/market-details's own
// example: "clobTokenIds (JSON array): CLOB token IDs... (string)"). Accept
// both shapes here; normalize.ts is responsible for parsing the string form.
const jsonArrayOrStringSchema = z.union([z.array(z.string()), z.string()]);

export const rawGammaMarketSchema = z
  .object({
    id: z.string().min(1),
    slug: z.string().nullish(),
    question: z.string().min(1),
    description: z.string().nullish(),
    conditionId: z.string().nullish(),

    outcomes: jsonArrayOrStringSchema.nullish(),
    outcomePrices: jsonArrayOrStringSchema.nullish(),

    active: z.boolean().nullish(),
    closed: z.boolean().nullish(),
    archived: z.boolean().nullish(),
    acceptingOrders: z.boolean().nullish(),
    restricted: z.boolean().nullish(),
    negRisk: z.boolean().nullish(),

    startDateIso: z.string().nullish(),
    endDateIso: z.string().nullish(),
    closedTime: z.string().nullish(),

    // Documented as strings on the market object; some deployments have
    // also been observed returning numbers for the same fields. Accept
    // both — normalize.ts is the single place that parses to a number.
    liquidity: z.union([z.string(), z.number()]).nullish(),
    volume24hr: z.union([z.string(), z.number()]).nullish(),
    lastTradePrice: z.union([z.string(), z.number()]).nullish(),
    bestBid: z.union([z.string(), z.number()]).nullish(),
    bestAsk: z.union([z.string(), z.number()]).nullish(),

    umaResolutionStatus: z.string().nullish(),
    resolvedBy: z.string().nullish(),

    // Present on markets reached via /events; absent when fetched directly
    // via /markets. Never assumed present.
    events: z
      .array(z.object({ id: z.string() }).passthrough())
      .nullish(),

    tags: z
      .array(z.union([z.string(), z.object({ id: z.union([z.string(), z.number()]) }).passthrough()]))
      .nullish(),
  })
  .passthrough();

export type RawGammaMarket = z.infer<typeof rawGammaMarketSchema>;

// The Gamma `/markets/keyset` list envelope. CONFIRMED against a live call
// (2026-09-15): the real shape is `{ "$schema": ..., "markets": [...],
// "next_cursor": ... }` — not a plain array, and not `{ data: [...] }` as
// originally assumed from the prose docs alone (which described the
// endpoint's behavior but did not show a full example response body). Both
// the originally-assumed shapes are kept accepted defensively alongside the
// confirmed real one, in case a different Gamma endpoint (e.g.
// `/events/keyset`) or a future API version uses one of them instead.
//
// Deliberately validates each item as `z.unknown()`, NOT as
// `rawGammaMarketSchema`, at this envelope level. Validating every market in
// the page against the full per-market schema here would mean one malformed
// market fails the whole page's zod parse — exactly the "one bad market
// corrupts unrelated rows" failure mode roadmap STEP 12 forbids. Per-market
// validation happens one level up, in the adapter, where a single failure
// can be isolated and reported without discarding the rest of the page.
export const rawGammaListResponseSchema = z.union([
  z.array(z.unknown()),
  z.object({
    markets: z.array(z.unknown()),
    next_cursor: z.string().nullish(),
    nextCursor: z.string().nullish(),
  }),
  z.object({
    data: z.array(z.unknown()),
    next_cursor: z.string().nullish(),
    nextCursor: z.string().nullish(),
  }),
]);
