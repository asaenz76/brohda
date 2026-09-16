import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getMarketById, listActiveMarkets, type MarketRecord } from "../repository";
import { POLYMARKET_PROVIDER } from "../provider-names";
import { computeMarketCategoryIds, type CategoryMappingRow } from "./category-mapping";
import { compareDiscoveryMarkets, DEFAULT_SORT_POLICY, type SortCriterion, type SortDirection, type SortPolicy } from "./ordering";
import { getFreshnessPolicy } from "./policy";
import type { DiscoveryCategory, DiscoveryCategoryRef, DiscoveryMarketCard, DiscoveryMarketDetail } from "./types";
import { isDetailReachable, isFeedEligible } from "./eligibility";
import { toDiscoveryMarketCard, toDiscoveryMarketDetail } from "./view-model";

// Server-side read/write layer for the discovery taxonomy tables
// (`discovery_categories`, `discovery_category_provider_mappings`) and the
// consumer-facing feed/detail queries built on top of Milestone 1's
// `markets` repository. Every consumer read in Milestone 2 goes through
// this file — no Server Component queries Supabase directly for discovery
// data (roadmap STEP 18: "Brohda UI -> Brohda server/domain read layer ->
// normalized Brohda database").

interface CategoryRow {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  display_order: number;
  enabled: boolean;
  icon_key: string | null;
}

function toCategory(row: CategoryRow): DiscoveryCategory {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    displayOrder: row.display_order,
    enabled: row.enabled,
    iconKey: row.icon_key,
  };
}

function toCategoryRef(c: DiscoveryCategory): DiscoveryCategoryRef {
  return { id: c.id, slug: c.slug, displayName: c.displayName };
}

/** Admin surface: every category, in display order, regardless of enabled state. */
export async function listAllCategories(): Promise<DiscoveryCategory[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("discovery_categories").select("*").order("display_order", { ascending: true });
  if (error) throw error;
  return (data as CategoryRow[]).map(toCategory);
}

/** Consumer surface: only enabled categories, in display order — this is what "Disabled categories must disappear from consumer discovery without a deployment" (roadmap STEP 13) actually means in code. */
export async function listEnabledCategories(): Promise<DiscoveryCategory[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("discovery_categories")
    .select("*")
    .eq("enabled", true)
    .order("display_order", { ascending: true });
  if (error) throw error;
  return (data as CategoryRow[]).map(toCategory);
}

export async function getCategoryById(id: string): Promise<DiscoveryCategory | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("discovery_categories").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toCategory(data as CategoryRow) : null;
}

export async function getCategoryBySlug(slug: string): Promise<DiscoveryCategory | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("discovery_categories").select("*").eq("slug", slug).maybeSingle();
  if (error) throw error;
  return data ? toCategory(data as CategoryRow) : null;
}

export async function createCategory(input: {
  slug: string;
  displayName: string;
  description: string | null;
  displayOrder: number;
  enabled: boolean;
  iconKey: string | null;
}): Promise<DiscoveryCategory> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("discovery_categories")
    .insert({
      slug: input.slug,
      display_name: input.displayName,
      description: input.description,
      display_order: input.displayOrder,
      enabled: input.enabled,
      icon_key: input.iconKey,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toCategory(data as CategoryRow);
}

export async function updateCategory(
  id: string,
  patch: Partial<{ slug: string; displayName: string; description: string | null; displayOrder: number; enabled: boolean; iconKey: string | null }>,
): Promise<DiscoveryCategory> {
  const admin = createAdminClient();
  const row: Record<string, unknown> = {};
  if (patch.slug !== undefined) row.slug = patch.slug;
  if (patch.displayName !== undefined) row.display_name = patch.displayName;
  if (patch.description !== undefined) row.description = patch.description;
  if (patch.displayOrder !== undefined) row.display_order = patch.displayOrder;
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  if (patch.iconKey !== undefined) row.icon_key = patch.iconKey;

  const { data, error } = await admin.from("discovery_categories").update(row).eq("id", id).select("*").single();
  if (error) throw error;
  return toCategory(data as CategoryRow);
}

export async function deleteCategory(id: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("discovery_categories").delete().eq("id", id);
  if (error) throw error;
}

interface MappingRow {
  id: string;
  category_id: string;
  provider: string;
  provider_tag: string;
  enabled: boolean;
}

export interface CategoryMapping {
  id: string;
  categoryId: string;
  provider: string;
  providerTag: string;
  enabled: boolean;
}

function toMapping(row: MappingRow): CategoryMapping {
  return { id: row.id, categoryId: row.category_id, provider: row.provider, providerTag: row.provider_tag, enabled: row.enabled };
}

export async function listAllMappings(): Promise<CategoryMapping[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("discovery_category_provider_mappings").select("*").order("provider_tag");
  if (error) throw error;
  return (data as MappingRow[]).map(toMapping);
}

async function listEnabledMappingRows(): Promise<CategoryMappingRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("discovery_category_provider_mappings")
    .select("category_id, provider, provider_tag")
    .eq("enabled", true);
  if (error) throw error;
  return (data as { category_id: string; provider: string; provider_tag: string }[]).map((r) => ({
    categoryId: r.category_id,
    provider: r.provider,
    providerTag: r.provider_tag,
  }));
}

interface SortPolicyRow {
  criterion: SortCriterion;
  priority: number;
  direction: SortDirection;
  enabled: boolean;
}

export type SortPolicyRule = SortPolicyRow;

/** Admin surface: every configured sort rule (including disabled ones), in priority order. */
export async function listAllSortRules(): Promise<SortPolicyRule[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("discovery_sort_policy").select("*").order("priority", { ascending: true });
  if (error) throw error;
  return data as SortPolicyRow[];
}

/**
 * Consumer surface: the ordered list of ENABLED rules `compareDiscoveryMarkets`
 * actually applies (hard-coding remediation Finding 1). Fails open to
 * `DEFAULT_SORT_POLICY` — which reproduces Milestone 2's original behavior —
 * if the table is ever empty or unreadable, matching this codebase's
 * existing fail-open convention for settings reads.
 */
export async function getSortPolicy(): Promise<SortPolicy> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("discovery_sort_policy")
    .select("criterion, direction")
    .eq("enabled", true)
    .order("priority", { ascending: true });
  if (error || !data || data.length === 0) return DEFAULT_SORT_POLICY;
  return data as SortPolicy;
}

export async function updateSortRule(
  criterion: SortCriterion,
  patch: Partial<{ priority: number; direction: SortDirection; enabled: boolean }>,
): Promise<SortPolicyRule> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("discovery_sort_policy").update(patch).eq("criterion", criterion).select("*").single();
  if (error) throw error;
  return data as SortPolicyRow;
}

export async function createMapping(input: { categoryId: string; provider: string; providerTag: string; enabled: boolean }): Promise<CategoryMapping> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("discovery_category_provider_mappings")
    .insert({ category_id: input.categoryId, provider: input.provider, provider_tag: input.providerTag, enabled: input.enabled })
    .select("*")
    .single();
  if (error) throw error;
  return toMapping(data as MappingRow);
}

export async function updateMapping(id: string, patch: Partial<{ categoryId: string; enabled: boolean }>): Promise<CategoryMapping> {
  const admin = createAdminClient();
  const row: Record<string, unknown> = {};
  if (patch.categoryId !== undefined) row.category_id = patch.categoryId;
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  const { data, error } = await admin.from("discovery_category_provider_mappings").update(row).eq("id", id).select("*").single();
  if (error) throw error;
  return toMapping(data as MappingRow);
}

export async function deleteMapping(id: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("discovery_category_provider_mappings").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Builds the (marketId -> categoryRefs) index in exactly three queries
 * total, regardless of market count (roadmap STEP 18: "avoid N+1
 * queries") — one for markets (via listActiveMarkets, already a single
 * query), one for all enabled mappings, one for enabled categories.
 */
async function buildCategoryIndex(markets: MarketRecord[]): Promise<Map<string, DiscoveryCategoryRef[]>> {
  const [mappingRows, categories] = await Promise.all([listEnabledMappingRows(), listEnabledCategories()]);
  const categoryById = new Map(categories.map((c) => [c.id, toCategoryRef(c)]));

  const index = new Map<string, DiscoveryCategoryRef[]>();
  for (const market of markets) {
    const categoryIds = computeMarketCategoryIds(market.provider, market.categoryTags, mappingRows);
    const refs = categoryIds.map((id) => categoryById.get(id)).filter((c): c is DiscoveryCategoryRef => c != null);
    index.set(market.id, refs);
  }
  return index;
}

/**
 * The consumer discovery feed. `categorySlug` narrows to markets mapped
 * into that one enabled category; omit for "All." A market present in
 * `markets` but with no matching enabled mapping is "uncategorized" — it
 * appears under "All" but never under any specific category filter
 * (roadmap STEP 5's documented fallback behavior).
 */
export async function getDiscoveryFeed(categorySlug?: string): Promise<DiscoveryMarketCard[]> {
  const [markets, freshnessPolicy, sortPolicy] = await Promise.all([listActiveMarkets(200), getFreshnessPolicy(), getSortPolicy()]);
  const index = await buildCategoryIndex(markets);

  let targetCategoryId: string | null = null;
  if (categorySlug) {
    const category = await getCategoryBySlug(categorySlug);
    if (!category || !category.enabled) return []; // disabled/unknown category slug -> empty, never an error
    targetCategoryId = category.id;
  }

  const cards: (DiscoveryMarketCard & { liquidity: number | null })[] = [];
  for (const market of markets) {
    if (!isFeedEligible(market)) continue;
    const categories = index.get(market.id) ?? [];
    if (targetCategoryId && !categories.some((c) => c.id === targetCategoryId)) continue;

    const card = toDiscoveryMarketCard(market, categories, freshnessPolicy);
    if (card) cards.push({ ...card, liquidity: market.liquidity });
  }

  cards.sort((a, b) => compareDiscoveryMarkets(a, b, sortPolicy));
  return cards.map((card): DiscoveryMarketCard => ({
    id: card.id,
    question: card.question,
    categories: card.categories,
    yesPercent: card.yesPercent,
    noPercent: card.noPercent,
    status: card.status,
    closesAt: card.closesAt,
    freshness: card.freshness,
  }));
}

/** Market detail by Brohda id — reachable for ACTIVE/CLOSED/RESOLVED, honestly absent (null) for anything else, matching a nonexistent id (roadmap STEP 18). */
export async function getMarketDetail(id: string): Promise<DiscoveryMarketDetail | null> {
  const market = await getMarketById(id);
  if (!market || !isDetailReachable(market)) return null;

  const [mappingRows, categories, freshnessPolicy] = await Promise.all([
    listEnabledMappingRows(),
    listEnabledCategories(),
    getFreshnessPolicy(),
  ]);
  const categoryById = new Map(categories.map((c) => [c.id, toCategoryRef(c)]));
  const categoryIds = computeMarketCategoryIds(market.provider, market.categoryTags, mappingRows);
  const refs = categoryIds.map((cid) => categoryById.get(cid)).filter((c): c is DiscoveryCategoryRef => c != null);

  return toDiscoveryMarketDetail(market, refs, freshnessPolicy);
}

// Re-exported for admin diagnostics only (e.g. confirming which provider a
// mapping targets) — never imported by consumer-facing code.
export { POLYMARKET_PROVIDER };
