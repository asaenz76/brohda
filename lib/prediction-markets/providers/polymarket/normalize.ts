// Raw Gamma market -> normalized Brohda Market. This is the one place
// Polymarket-specific field names (active/closed/archived, outcomePrices,
// etc.) are read — everything downstream of this file sees only the
// provider-neutral NormalizedMarket shape (lib/prediction-markets/types.ts).
import { POLYMARKET_PROVIDER } from "../../provider-names";
import type { NormalizeResult, PredictionMarketStatus } from "../../types";
import type { RawGammaMarket } from "./schema";

/**
 * Status precedence, most-terminal-first. Documented explicitly because the
 * provider does not expose a single status field — this is Brohda's own
 * interpretation of four independent booleans, not a 1:1 passthrough:
 *
 * - `archived` wins over everything: the provider's own docs describe it as
 *   "read-only, no updates" — the most terminal state regardless of what
 *   active/closed say.
 * - `closed` wins over `active`: per docs.polymarket.com/market-data/
 *   market-details, closed means "market has resolved; trading no longer
 *   possible" — a stronger signal than the active flag.
 * - `active` (with neither of the above) maps to ACTIVE.
 * - Anything else maps to INACTIVE — the honest "we have no positive
 *   evidence this market is currently tradeable" bucket, not an assumption
 *   that it's the same as CLOSED.
 *
 * Known limitation: these flags can lag real-world event completion — a
 * documented real case is Polymarket/rs-clob-client#199 (AFCON matches
 * still marked active/acceptingOrders after the match ended). This mapping
 * reflects the PROVIDER's own field semantics, not verified ground truth.
 */
export function mapStatus(raw: Pick<RawGammaMarket, "active" | "closed" | "archived">): PredictionMarketStatus {
  if (raw.archived === true) return "ARCHIVED";
  if (raw.closed === true) return "CLOSED";
  if (raw.active === true) return "ACTIVE";
  return "INACTIVE";
}

/**
 * Parses a Gamma `outcomes`/`outcomePrices` field, which has been observed
 * as either a real array or a JSON-encoded string of one (see schema.ts's
 * comment). Returns null — never throws — on anything that isn't
 * ultimately a string array, so callers can treat "unparseable" as one more
 * explicit unavailable state rather than a crash.
 */
function parseJsonStringArray(value: string[] | string | null | undefined): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function parseNumeric(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Maps outcomes/outcomePrices to independent YES/NO prices. Deliberately
 * never derives `no = 1 - yes` (roadmap STEP 8) — each outcome is priced
 * independently by the provider, from its own token's order book, and nothing
 * in Polymarket's documentation guarantees the two sum to exactly 1 at every
 * instant. If either label can't be found, or the arrays are missing/
 * mismatched/unparseable, that side is left null (not zero, not derived).
 */
export function mapPrices(raw: Pick<RawGammaMarket, "outcomes" | "outcomePrices">): {
  yes: number | null;
  no: number | null;
  outcomeLabels: { yes: string | null; no: string | null } | null;
} {
  const outcomes = parseJsonStringArray(raw.outcomes);
  const prices = parseJsonStringArray(raw.outcomePrices);

  if (!outcomes || !prices || outcomes.length !== prices.length) {
    return { yes: null, no: null, outcomeLabels: null };
  }

  const yesIndex = outcomes.findIndex((o) => o.trim().toLowerCase() === "yes");
  const noIndex = outcomes.findIndex((o) => o.trim().toLowerCase() === "no");

  const yes = yesIndex >= 0 ? parseNumeric(prices[yesIndex]) : null;
  const no = noIndex >= 0 ? parseNumeric(prices[noIndex]) : null;

  if (yes == null && no == null) {
    return { yes: null, no: null, outcomeLabels: null };
  }

  return {
    yes,
    no,
    outcomeLabels: {
      yes: yesIndex >= 0 ? outcomes[yesIndex] : null,
      no: noIndex >= 0 ? outcomes[noIndex] : null,
    },
  };
}

function extractEventId(raw: RawGammaMarket): string | null {
  const first = raw.events?.[0];
  return first && typeof first.id === "string" ? first.id : null;
}

function extractCategoryTags(raw: RawGammaMarket): string[] {
  if (!raw.tags) return [];
  return raw.tags.map((t) => (typeof t === "string" ? t : String(t.id))).filter(Boolean);
}

export interface NormalizeContext {
  ingestionSource: string;
}

/**
 * Normalizes one already-schema-validated raw market. Never throws on
 * degraded-but-present data (missing prices, missing dates) — those become
 * explicit nulls per field. Only returns `{ ok: false }` for the narrow set
 * of cases that make the row genuinely unusable (currently: none beyond
 * what the zod schema already rejects, since `id`/`question` are required
 * there) — kept as a discriminated result type regardless, so a future,
 * stricter validation rule has somewhere to report through without changing
 * every caller's error handling.
 */
export function normalizePolymarketMarket(raw: RawGammaMarket, context: NormalizeContext): NormalizeResult {
  const price = mapPrices(raw);
  const categoryTags = extractCategoryTags(raw);

  return {
    ok: true,
    market: {
      provider: POLYMARKET_PROVIDER,
      providerMarketId: raw.id,
      providerEventId: extractEventId(raw),
      question: raw.question,
      description: raw.description ?? null,
      status: mapStatus(raw),
      price,
      volume24hr: parseNumeric(raw.volume24hr),
      liquidity: parseNumeric(raw.liquidity),
      resolutionStatus: raw.umaResolutionStatus ?? null,
      resolvedBy: raw.resolvedBy ?? null,
      // Never populated in Milestone 1 — see types.ts's comment.
      resolvedOutcome: null,
      opensAt: raw.startDateIso ?? null,
      closesAt: raw.endDateIso ?? null,
      closedAt: raw.closedTime ?? null,
      ingestionSource: context.ingestionSource,
      providerMetadata: {
        ...raw,
        _categoryTagsExtracted: categoryTags,
      },
    },
  };
}

export { extractCategoryTags };
