// Polymarket execution adapter (Milestone 5) — the ONLY place CLOB token
// IDs are read or referenced. Implements ExecutionQuoteProvider
// (lib/execution/types.ts). Read-only: calls only
// lib/execution/providers/polymarket/orderbook-client.ts's fetchOrderBook,
// never an order-placement/cancel endpoint (none exists in this codebase —
// see docs/architecture/simulated-execution.md §2/§17 for the explicit
// no-mutation-code discipline).
import "server-only";
import { getMarketProviderMetadata } from "@/lib/prediction-markets/repository";
import { POLYMARKET_PROVIDER } from "@/lib/prediction-markets/provider-names";
import { getExecutionPolicy } from "../../policy";
import { isProviderCallAllowed, recordProviderFailure, recordProviderSuccess } from "../../provider-health";
import { fetchOrderBook, PolymarketOrderBookUnavailableError, type RawOrderBook } from "./orderbook-client";
import type { DepthLevel, ExecutableMarketSnapshot, ExecutionQuoteProvider, ExecutionSide } from "../../types";

function isEnabled(): boolean {
  // Same gate Milestone 1 already established for the Polymarket read
  // path generally (lib/prediction-markets/providers/polymarket/adapter.ts) —
  // this is another read-only Polymarket capability, not a separate
  // provider relationship requiring its own flag.
  return process.env.PREDICTION_MARKETS_POLYMARKET_ENABLED === "true";
}

/**
 * Parses a Gamma `outcomes`/`clobTokenIds` field, which — like
 * `outcomes`/`outcomePrices` in Milestone 1's own normalize.ts — has been
 * observed as either a real array or a JSON-encoded string of one. Returns
 * null, never throws, on anything unparseable.
 */
function parseJsonStringArray(value: unknown): string[] | null {
  if (value == null) return null;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Finds the CLOB token id for `side`, by matching `outcomes` labels
 * exactly the way lib/prediction-markets/providers/polymarket/normalize.ts's
 * mapPrices already does for prices — same label-matching discipline, not
 * a positional assumption.
 */
function findTokenId(metadata: Record<string, unknown>, side: ExecutionSide): string | null {
  const outcomes = parseJsonStringArray(metadata.outcomes);
  const tokenIds = parseJsonStringArray(metadata.clobTokenIds);
  if (!outcomes || !tokenIds || outcomes.length !== tokenIds.length) return null;

  const wantedLabel = side === "YES" ? "yes" : "no";
  const index = outcomes.findIndex((o) => o.trim().toLowerCase() === wantedLabel);
  return index >= 0 ? tokenIds[index] : null;
}

function parseNumeric(value: string | number | undefined | null): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalizes raw ask levels into ascending-by-price order, regardless of
 * the raw provider's own array ordering (live-verified 2026-09-16: asks
 * are returned descending, best/lowest ask last — see
 * docs/architecture/simulated-execution.md §6). Never assumes the raw
 * order; always sorts explicitly.
 */
function normalizeAskLevels(book: RawOrderBook): DepthLevel[] {
  const levels = (book.asks ?? [])
    .map((level) => ({ price: parseNumeric(level.price), size: parseNumeric(level.size) }))
    .filter((level): level is DepthLevel => level.price !== null && level.size !== null && level.size > 0);
  return levels.sort((a, b) => a.price - b.price);
}

async function getExecutableSnapshot(providerMarketId: string, side: ExecutionSide): Promise<ExecutableMarketSnapshot | null> {
  // providerMarketId here is Brohda's own market id (soft reference) — the
  // caller (lib/execution/quote-service.ts) resolves it once via
  // getMarketById; this adapter looks up the raw metadata for that same
  // Brohda row, never a second provider lookup.
  const metadata = await getMarketProviderMetadata(providerMarketId);
  if (!metadata) return null;

  const tokenId = findTokenId(metadata, side);
  if (!tokenId) return null;

  // Milestone 5.5 circuit breaker (STEP 15/16) — wraps exactly the network
  // I/O boundary (fetchOrderBook), never the "no token id recorded" branch
  // above, which is a data-availability fact about this specific market,
  // not evidence the provider itself is unhealthy.
  if (!(await isProviderCallAllowed(POLYMARKET_PROVIDER))) return null;

  let book: RawOrderBook;
  try {
    book = await fetchOrderBook(tokenId);
    await recordProviderSuccess(POLYMARKET_PROVIDER);
  } catch (error) {
    if (error instanceof PolymarketOrderBookUnavailableError) {
      const policy = await getExecutionPolicy();
      await recordProviderFailure(POLYMARKET_PROVIDER, policy.circuitBreaker);
      return null;
    }
    throw error;
  }

  const askLevels = normalizeAskLevels(book);
  const tickSize = parseNumeric(book.tick_size);
  const minOrderSize = parseNumeric(book.min_order_size);
  const lastTradePrice = parseNumeric(book.last_trade_price);
  // Best (lowest) ask is the most honest "current price" for a BUY-side
  // quote — never derived from the opposite side, matching Milestone 1's
  // own "never derive NO from YES" discipline applied here to bid/ask.
  const currentPrice = askLevels[0]?.price ?? lastTradePrice;
  if (tickSize === null || minOrderSize === null || currentPrice === null) return null;

  return {
    currentPrice,
    askLevels,
    tickSize,
    minOrderSize,
    snapshotAt: new Date().toISOString(),
  };
}

export const polymarketExecutionAdapter: ExecutionQuoteProvider = {
  name: POLYMARKET_PROVIDER,
  isEnabled,
  getExecutableSnapshot,
};
