import { getLatestTemplate } from "./registry";

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
    const template = getLatestTemplate(templateId);
    if (template) return template.category;
  }
  return LEGACY_POOL_TYPE_CATEGORY[poolType] ?? "UNKNOWN";
}

export function resolvePoolCategoryLabel(poolType: string, templateId: string | null): string {
  return ANALYTICS_CATEGORY_LABELS[resolvePoolAnalyticsCategory(poolType, templateId)];
}

// User-typed search terms → matching category codes, for /search's "search
// by market" feature (beta feedback: players expect to find pools by typing
// "goals", "cards", "result", etc., not just team/league names). Deliberately
// many-to-many where a term genuinely spans categories (e.g. "score" covers
// both goal counts and player-to-score props) — the search page unions every
// matched category's fixtures, so over-inclusion just surfaces a few extra
// fixtures, while under-inclusion would silently hide a real match.
const CATEGORY_SEARCH_SYNONYMS: Record<string, AnalyticsCategoryCode[]> = {
  goal: ["GOALS"],
  goals: ["GOALS"],
  score: ["GOALS", "PLAYER_PROPS"],
  scorer: ["PLAYER_PROPS"],
  scoring: ["GOALS", "PLAYER_PROPS"],
  card: ["DISCIPLINE"],
  cards: ["DISCIPLINE"],
  discipline: ["DISCIPLINE"],
  result: ["MATCH_RESULT"],
  winner: ["MATCH_RESULT"],
  win: ["MATCH_RESULT"],
  stats: ["MATCH_STATS"],
  statistics: ["MATCH_STATS"],
  player: ["PLAYER_PROPS"],
  players: ["PLAYER_PROPS"],
  props: ["PLAYER_PROPS", "TEAM_PROPS"],
  team: ["TEAM_PROPS"],
  combo: ["COMBO"],
  parlay: ["COMBO"],
  custom: ["CUSTOM"],
};

// Matches a query against the synonym map in both directions — "goals"
// contains the "goal" key, and (once the query is at least 3 characters,
// to avoid 1-2 letter queries fuzzy-matching half the map) a partial
// in-progress query like "sco" matches the "score"/"scorer" keys, so results
// update sensibly while the user is still typing under the existing
// debounced live search.
export function resolveCategoriesFromSearchTerm(query: string): AnalyticsCategoryCode[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 3) return [];

  const matched = new Set<AnalyticsCategoryCode>();
  for (const [term, categories] of Object.entries(CATEGORY_SEARCH_SYNONYMS)) {
    if (normalized.includes(term) || term.includes(normalized)) {
      for (const category of categories) matched.add(category);
    }
  }
  return [...matched];
}
