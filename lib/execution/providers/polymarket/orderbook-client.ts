// Read-only Polymarket CLOB order-book client (Milestone 5). Calls only
// `GET https://clob.polymarket.com/book?token_id=...` — confirmed
// unauthenticated and read-only against official documentation
// (docs.polymarket.com/market-data/prices-order-books, fetched
// 2026-09-16) and live-verified against a real response the same day (see
// docs/architecture/simulated-execution.md §6). No mutation endpoint is
// called or referenced anywhere in this file.
import { z } from "zod";

const CLOB_BASE_URL = "https://clob.polymarket.com";

// Live-verified 2026-09-16: `price`/`size` are strings; `tick_size` and
// `min_order_size` came back as JSON numbers on a live response, though
// the docs describe them as decimal strings — accepting both defensively,
// the same discipline already applied to Gamma's own liquidity/volume
// fields in lib/prediction-markets/providers/polymarket/schema.ts.
const bookLevelSchema = z.object({
  price: z.union([z.string(), z.number()]),
  size: z.union([z.string(), z.number()]),
});

const rawOrderBookSchema = z
  .object({
    market: z.string().nullish(),
    asset_id: z.string().nullish(),
    timestamp: z.union([z.string(), z.number()]).nullish(),
    bids: z.array(bookLevelSchema).nullish(),
    asks: z.array(bookLevelSchema).nullish(),
    min_order_size: z.union([z.string(), z.number()]).nullish(),
    tick_size: z.union([z.string(), z.number()]).nullish(),
    last_trade_price: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

export type RawOrderBook = z.infer<typeof rawOrderBookSchema>;

export class PolymarketOrderBookUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolymarketOrderBookUnavailableError";
  }
}

/**
 * Fetches one token's order book. Read-only, no authentication, no
 * mutation. Throws `PolymarketOrderBookUnavailableError` on any network,
 * HTTP, or schema failure — the caller (the execution adapter) is
 * responsible for turning that into the domain's own `PROVIDER_UNAVAILABLE`
 * eligibility reason, never a raw error surfaced to a consumer.
 */
export async function fetchOrderBook(tokenId: string): Promise<RawOrderBook> {
  let response: Response;
  try {
    response = await fetch(`${CLOB_BASE_URL}/book?token_id=${encodeURIComponent(tokenId)}`, {
      method: "GET",
      cache: "no-store",
    });
  } catch (error) {
    throw new PolymarketOrderBookUnavailableError(
      `Failed to reach the Polymarket order-book endpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new PolymarketOrderBookUnavailableError(`Polymarket order-book endpoint returned HTTP ${response.status}`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new PolymarketOrderBookUnavailableError("Polymarket order-book response was not valid JSON");
  }

  const parsed = rawOrderBookSchema.safeParse(json);
  if (!parsed.success) {
    throw new PolymarketOrderBookUnavailableError("Polymarket order-book response did not match the expected shape");
  }
  return parsed.data;
}
