import { getTemplate } from "./registry";

// Mirrors public.analytics_category (supabase/migrations/20260101000069_*.sql)
// exactly — one stable code per category, snapshotted onto pools.analytics_category
// at creation time so a later template-registry change (rename, recategorize,
// delete) never rewrites already-created pools' history. Display labels are
// a UI-only concern resolved from the code below, never stored.
export type AnalyticsCategoryCode =
  | "MATCH_RESULT"
  | "GOALS"
  | "TEAM_PROPS"
  | "PLAYER_PROPS"
  | "MATCH_STATS"
  | "DISCIPLINE"
  | "COMBO"
  | "CUSTOM"
  | "UNKNOWN";

export const ANALYTICS_CATEGORY_LABELS: Record<AnalyticsCategoryCode, string> = {
  MATCH_RESULT: "Match result",
  GOALS: "Goals",
  TEAM_PROPS: "Team props",
  PLAYER_PROPS: "Players",
  MATCH_STATS: "Match statistics",
  DISCIPLINE: "Cards",
  COMBO: "Combos",
  CUSTOM: "Custom props",
  UNKNOWN: "Other",
};

// The 4 legacy (non-registry) pool_type values map directly to a category —
// WHO_WILL_ADVANCE/REGULATION_RESULT are both plain match-result questions,
// COMBO/CUSTOM keep their own distinct buckets.
const LEGACY_POOL_TYPE_CATEGORY: Record<string, AnalyticsCategoryCode> = {
  WHO_WILL_ADVANCE: "MATCH_RESULT",
  REGULATION_RESULT: "MATCH_RESULT",
  COMBO: "COMBO",
  CUSTOM: "CUSTOM",
};

// Called once, at pool-creation time, to compute the immutable snapshot —
// and by the one-time backfill migration for pre-existing pools. Never
// call this at analytics read time; read pools.analytics_category instead.
export function resolvePoolAnalyticsCategory(poolType: string, templateId: string | null): AnalyticsCategoryCode {
  if (poolType === "TEMPLATE_GRADED" && templateId) {
    const template = getTemplate(templateId);
    if (template) return template.category;
  }
  return LEGACY_POOL_TYPE_CATEGORY[poolType] ?? "UNKNOWN";
}

export function resolvePoolCategoryLabel(poolType: string, templateId: string | null): string {
  return ANALYTICS_CATEGORY_LABELS[resolvePoolAnalyticsCategory(poolType, templateId)];
}
