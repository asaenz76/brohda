import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { NormalizedMarket } from "./types";

// Server-side read/write layer for the `markets` table — repurposed
// (docs/architecture/sports-prediction-network.md §9) as the candidate
// PredictionQuestion schema after the Polymarket direction was abandoned.
// This is the ONLY module in the app allowed to run a Supabase query
// against `markets` — every future caller goes through here, never through
// its own ad hoc query, so the shape of "a normalized market" stays
// defined in exactly one place.

interface MarketRow {
  id: string;
  provider: string;
  provider_market_id: string;
  provider_event_id: string | null;
  question: string;
  description: string | null;
  status: string;
  yes_price: number | string | null;
  no_price: number | string | null;
  price_outcome_labels: { yes: string | null; no: string | null } | null;
  volume_24hr: number | string | null;
  liquidity: number | string | null;
  resolution_status: string | null;
  resolved_by: string | null;
  resolved_outcome: string | null;
  opens_at: string | null;
  closes_at: string | null;
  closed_at: string | null;
  last_synced_at: string;
  ingestion_source: string;
  provider_metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface MarketRecord {
  id: string;
  provider: string;
  providerMarketId: string;
  providerEventId: string | null;
  question: string;
  description: string | null;
  status: string;
  yesPrice: number | null;
  noPrice: number | null;
  volume24hr: number | null;
  liquidity: number | null;
  /** Never populated by Milestone 1's own ingestion (always null there) — kept here so a future milestone's real resolution data flows through without another repository change. */
  resolvedOutcome: string | null;
  closesAt: string | null;
  lastSyncedAt: string;
  ingestionSource: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Extracted provider category/tag labels only — NOT the raw provider
   * payload. This is the one deliberate exception to "provider internals
   * stop at the adapter boundary": the category-mapping layer
   * (lib/prediction-markets/discovery/category-mapping.ts) needs these
   * strings to match against `discovery_category_provider_mappings`, but
   * the consumer-facing
   * DiscoveryMarketCard/Detail view models never expose this field —
   * only the resolved Brohda category objects.
   */
  categoryTags: string[];
}

function extractCategoryTags(row: MarketRow): string[] {
  const raw = row.provider_metadata?._categoryTagsExtracted;
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
}

function toRecord(row: MarketRow): MarketRecord {
  return {
    id: row.id,
    provider: row.provider,
    providerMarketId: row.provider_market_id,
    providerEventId: row.provider_event_id,
    question: row.question,
    description: row.description,
    status: row.status,
    yesPrice: row.yes_price != null ? Number(row.yes_price) : null,
    noPrice: row.no_price != null ? Number(row.no_price) : null,
    volume24hr: row.volume_24hr != null ? Number(row.volume_24hr) : null,
    liquidity: row.liquidity != null ? Number(row.liquidity) : null,
    resolvedOutcome: row.resolved_outcome,
    closesAt: row.closes_at,
    lastSyncedAt: row.last_synced_at,
    ingestionSource: row.ingestion_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    categoryTags: extractCategoryTags(row),
  };
}

function toRow(market: NormalizedMarket) {
  const now = new Date().toISOString();
  return {
    provider: market.provider,
    provider_market_id: market.providerMarketId,
    provider_event_id: market.providerEventId,
    question: market.question,
    description: market.description,
    status: market.status,
    yes_price: market.price.yes,
    no_price: market.price.no,
    price_outcome_labels: market.price.outcomeLabels,
    volume_24hr: market.volume24hr,
    liquidity: market.liquidity,
    resolution_status: market.resolutionStatus,
    resolved_by: market.resolvedBy,
    resolved_outcome: market.resolvedOutcome,
    opens_at: market.opensAt,
    closes_at: market.closesAt,
    closed_at: market.closedAt,
    last_synced_at: now,
    ingestion_source: market.ingestionSource,
    provider_metadata: market.providerMetadata,
  };
}

export type UpsertOutcome = "inserted" | "updated";

/**
 * Idempotent upsert on (provider, provider_market_id) — the unique
 * constraint the migration defines. Returns whether this call inserted a
 * new row or updated an existing one (roadmap STEP 12's inserted/updated
 * count split) and the row's stable Brohda id either way.
 */
export async function upsertMarket(market: NormalizedMarket): Promise<{ id: string; outcome: UpsertOutcome }> {
  const admin = createAdminClient();

  const { data: existing, error: lookupError } = await admin
    .from("markets")
    .select("id")
    .eq("provider", market.provider)
    .eq("provider_market_id", market.providerMarketId)
    .maybeSingle();
  if (lookupError) throw lookupError;

  if (existing) {
    const { error } = await admin.from("markets").update(toRow(market)).eq("id", existing.id);
    if (error) throw error;
    return { id: existing.id, outcome: "updated" };
  }

  const { data: inserted, error } = await admin.from("markets").insert(toRow(market)).select("id").single();
  if (error) throw error;
  return { id: inserted.id, outcome: "inserted" };
}

export async function getMarketById(id: string): Promise<MarketRecord | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("markets").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toRecord(data as MarketRow) : null;
}

export async function getMarketByProviderMarketId(provider: string, providerMarketId: string): Promise<MarketRecord | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("markets")
    .select("*")
    .eq("provider", provider)
    .eq("provider_market_id", providerMarketId)
    .maybeSingle();
  if (error) throw error;
  return data ? toRecord(data as MarketRow) : null;
}

export async function listActiveMarkets(limit = 100): Promise<MarketRecord[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("markets")
    .select("*")
    .eq("status", "ACTIVE")
    .order("last_synced_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as MarketRow[]).map(toRecord);
}

export async function listRecentlySyncedMarkets(sinceIso: string, limit = 100): Promise<MarketRecord[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("markets")
    .select("*")
    .gte("last_synced_at", sinceIso)
    .order("last_synced_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as MarketRow[]).map(toRecord);
}
