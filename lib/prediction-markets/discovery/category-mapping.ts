/**
 * Maps a market's raw provider category tags onto Brohda's configured
 * discovery categories (roadmap STEP 5). Deliberately simple, data-driven
 * matching — case-insensitive exact match against
 * `discovery_category_provider_mappings`, nothing resembling ML/semantic
 * classification. A tag with no matching enabled mapping row is silently
 * skipped (never throws) — the market simply ends up with fewer (possibly
 * zero) categories, which the eligibility/UI layer treats as
 * "uncategorized," not an error.
 */
export interface CategoryMappingRow {
  categoryId: string;
  provider: string;
  providerTag: string;
}

export function computeMarketCategoryIds(
  provider: string,
  marketTags: string[],
  mappings: CategoryMappingRow[],
): string[] {
  const tagSet = new Set(marketTags.map((t) => t.trim().toLowerCase()));
  const matched = new Set<string>();
  for (const mapping of mappings) {
    if (mapping.provider !== provider) continue;
    if (tagSet.has(mapping.providerTag.trim().toLowerCase())) {
      matched.add(mapping.categoryId);
    }
  }
  return [...matched];
}
