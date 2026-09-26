import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { MarketTemplate, MarketYesSide, NormalizedMarket } from "./types";

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
  fixture_id: string;
  market_template: MarketTemplate;
  line_value: number | string | null;
  yes_side: MarketYesSide | null;
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
  fixtureId: string;
  marketTemplate: MarketTemplate;
  lineValue: number | null;
  yesSide: MarketYesSide | null;
  yesPrice: number | null;
  noPrice: number | null;
  /**
   * Human-language selection labels authored once at ingestion time
   * (lib/prediction-markets/ingestion/nfl.ts — e.g. `{yes: "Chiefs win", no:
   * "Chiefs do not win"}` for MONEYLINE, `{yes: "Over 47.5", no: "Under
   * 47.5"}` for TOTAL), stored verbatim on `markets.price_outcome_labels`.
   * Not a new snapshot column: `market_template`/`line_value`/`yes_side`
   * are DB-immutable once set (markets_forbid_identity_mutation), and this
   * value is deterministically recomputed from those same frozen inputs
   * plus the fixture's own (equally immutable) team names on every
   * ingestion refresh — so reading it live from this Market's own row
   * already gives correct, stable historical semantics for any Pick that
   * references this market_id, with no separate immutable snapshot needed
   * (Stage 4A remediation, §14).
   */
  priceOutcomeLabels: { yes: string | null; no: string | null } | null;
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
    fixtureId: row.fixture_id,
    marketTemplate: row.market_template,
    lineValue: row.line_value != null ? Number(row.line_value) : null,
    yesSide: row.yes_side,
    yesPrice: row.yes_price != null ? Number(row.yes_price) : null,
    noPrice: row.no_price != null ? Number(row.no_price) : null,
    priceOutcomeLabels: row.price_outcome_labels,
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
    fixture_id: market.fixtureId,
    market_template: market.marketTemplate,
    line_value: market.lineValue,
    yes_side: market.yesSide,
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

/**
 * Milestone R2 (docs/BROHDA_2_0_MILESTONE_MAP.md, Sports Market Ingestion):
 * the "current/preferred Market" lookup for a Game+template — distinct
 * from canonical Market *existence*, which every historical proposition
 * row retains forever regardless of status (R1's identity/uniqueness
 * constraints, unaffected by this query). Used by ingestion to decide
 * whether an observed proposition is a price refresh on the existing
 * current line (same identity, update in place via upsertMarket) or a
 * genuinely new line (a different identity — insert a new row, then
 * deactivateMarket the old one via this same lookup's result).
 */
/**
 * Milestone R3 (Post Foundation): every currently-current Market for a
 * Game, across all templates — the query a Post detail surface (or the
 * automatic publication policy's "does this fixture have an active
 * Market" check) needs. Deliberately not scoped to one template, unlike
 * getActiveMarketByFixtureAndTemplate above.
 */
export async function listActiveMarketsForFixture(fixtureId: string): Promise<MarketRecord[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("markets").select("*").eq("fixture_id", fixtureId).eq("status", "ACTIVE");
  if (error) throw error;
  return (data as MarketRow[]).map(toRecord);
}

/** Stage 4A remediation (feed primary-Market hydration): the same query as listActiveMarketsForFixture, batched across several fixtures in one round trip — callers group the result by fixtureId themselves (e.g. via selectPrimaryMarket per group). */
export async function listActiveMarketsForFixtures(fixtureIds: string[]): Promise<MarketRecord[]> {
  if (fixtureIds.length === 0) return [];
  const admin = createAdminClient();
  const { data, error } = await admin.from("markets").select("*").in("fixture_id", fixtureIds).eq("status", "ACTIVE");
  if (error) throw error;
  return (data as MarketRow[]).map(toRecord);
}

/** Stage 4A remediation (§13/§16 — a Prediction-history list needs only its Market's semantic labels, not the full record) — one query regardless of how many distinct markets appear across a user's Prediction history. */
export async function listPriceOutcomeLabelsByMarketIds(marketIds: string[]): Promise<Map<string, MarketRecord["priceOutcomeLabels"]>> {
  if (marketIds.length === 0) return new Map();
  const admin = createAdminClient();
  const { data, error } = await admin.from("markets").select("id, price_outcome_labels").in("id", marketIds);
  if (error) throw error;
  return new Map((data as { id: string; price_outcome_labels: MarketRecord["priceOutcomeLabels"] }[]).map((row) => [row.id, row.price_outcome_labels]));
}

export async function getActiveMarketByFixtureAndTemplate(fixtureId: string, marketTemplate: MarketTemplate): Promise<MarketRecord | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("markets").select("*").eq("fixture_id", fixtureId).eq("market_template", marketTemplate).eq("status", "ACTIVE").maybeSingle();
  if (error) throw error;
  return data ? toRecord(data as MarketRow) : null;
}

/**
 * Marks a Market row no-longer-current for discovery (R2 §17: existence vs
 * visibility are different concepts) — never deletes, never touches the
 * identity columns R1 made immutable. `status` alone is sufficient:
 * INACTIVE already means "not discoverable" per
 * lib/prediction-markets/discovery/status.ts's deriveConsumerStatus, and is
 * distinct from ARCHIVED (which specifically means "never resolved,
 * grades VOID" — not the right meaning for "superseded by a newer line").
 * Any Prediction that already referenced this row keeps working exactly as
 * before: its soft `market_id` reference, snapshot fields, and eventual
 * grading are all untouched by a status change here.
 */
export async function deactivateMarket(id: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("markets").update({ status: "INACTIVE" }).eq("id", id);
  if (error) throw error;
}
