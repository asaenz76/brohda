import { listByCategory } from "@/lib/pools/templates/registry";
import { getQuestionFamily, type QuestionFamily } from "@/lib/pools/templates/families";

export interface FixtureOption {
  id: string;
  externalFixtureId: string | null;
  homeTeamExternalId: string | null;
  homeTeamName: string;
  homeTeamLogoUrl: string | null;
  awayTeamExternalId: string | null;
  awayTeamName: string;
  awayTeamLogoUrl: string | null;
  competitionType: string | null;
  sport: string;
  // The sports-data provider this fixture came from (e.g. "api_nfl") —
  // threaded through so odds calls can be routed to the correct provider
  // instead of assumed, see lib/actions/odds.ts's assertProvider.
  provider: string;
  league: string | null;
  label: string;
  scheduledStartUtc: string;
}

// Cards from the registry (TEMPLATE_GRADED templates), unified into one
// tabbed picker. Shared by both the single-fixture wizard
// (pool-template-builder.tsx) and the multi-fixture mode
// (multi-fixture-builder.tsx) so the two pickers stay in sync automatically
// as templates are added.
//
// The legacy WHO_WILL_ADVANCE/REGULATION_RESULT pool_types are retired —
// they're never offered for new pool creation (see isLegacyId below, kept
// only so existing code paths can still recognize a historical pool of
// either type).
export type CardCategory = "MATCH_RESULT" | "GOALS" | "DISCIPLINE" | "PLAYER_PROPS";
export const CATEGORY_LABELS: Record<CardCategory, string> = {
  MATCH_RESULT: "Prediction questions",
  GOALS: "Goals",
  DISCIPLINE: "Cards",
  PLAYER_PROPS: "Players",
};

const DATA_SOURCE_LABELS: Record<string, string> = {
  FIXTURE: "Fixture score",
  FIXTURE_EVENTS: "Match events",
  FIXTURE_STATISTICS: "Fixture statistics",
  FIXTURE_PLAYERS: "Player statistics",
  LINEUPS: "Lineups",
};

// How reliably a template grades itself without admin intervention:
// - AUTO: only ever needs the fixture's final score, which every completed
//   fixture already has — the safest, "suggested" pick.
// - NEEDS_LIVE_DATA: needs the match-events feed, which is only fetched
//   once this pool already exists and the match has kicked off, and isn't
//   guaranteed to come back complete for every competition — grading may
//   fall back to Grade Manually if the feed doesn't report it.
// - MANUAL: never auto-grades at all (combo legs are checked by hand).
export type GradingReliability = "AUTO" | "NEEDS_LIVE_DATA" | "MANUAL";

export const GRADING_BADGE: Record<GradingReliability, { label: string; className: string }> = {
  AUTO: { label: "Auto-graded", className: "bg-credit/10 text-credit" },
  NEEDS_LIVE_DATA: { label: "Needs live match data", className: "bg-warning-muted/20 text-text-secondary" },
  MANUAL: { label: "Manual grading", className: "bg-warning-muted/20 text-text-secondary" },
};
// Suggested (AUTO) templates sort first within a category tab — the same
// signal as the badge color, just also reflected in list order.
const GRADING_RANK: Record<GradingReliability, number> = { AUTO: 0, NEEDS_LIVE_DATA: 1, MANUAL: 2 };

export interface TemplateCard {
  id: string;
  category: CardCategory;
  name: string;
  description: string;
  gradingReliability: GradingReliability;
  dataSource: string;
  family: QuestionFamily | null;
  // Which fixture.sport value(s) this card applies to. Registry cards get a
  // real array from PoolTemplate.sports (see registry.ts/types.ts).
  sports: string[] | null;
}

// True when `card` is applicable to a fixture of the given sport — the one
// place both wizards should check this, so a future sport doesn't need the
// filtering logic duplicated between pool-template-builder.tsx and
// multi-fixture-builder.tsx.
export function cardMatchesSport(card: TemplateCard, sport: string): boolean {
  return card.sports === null || card.sports.includes(sport);
}

const REGISTRY_BY_CATEGORY = listByCategory();
// Only activeForCreation templates are offered as cards — a retired
// template (launched, later dropped for simplicity) stays fully gradable
// via getTemplate(id, version) for any pool already created against it,
// it just stops appearing as a choice here. Mirrors getLatestTemplate's
// own filter in lib/pools/templates/registry.ts.
const REGISTRY_CARDS: TemplateCard[] = [
  ...(REGISTRY_BY_CATEGORY.MATCH_RESULT ?? []),
  ...(REGISTRY_BY_CATEGORY.GOALS ?? []),
  ...(REGISTRY_BY_CATEGORY.DISCIPLINE ?? []),
  ...(REGISTRY_BY_CATEGORY.PLAYER_PROPS ?? []),
]
  .filter((t) => t.activeForCreation)
  .map((t) => ({
  id: t.id,
  category: t.category as CardCategory,
  name: t.name,
  description: t.description,
  gradingReliability: (t.requiredDataSources.includes("FIXTURE_EVENTS")
    ? "NEEDS_LIVE_DATA"
    : "AUTO") as GradingReliability,
  dataSource: DATA_SOURCE_LABELS[t.requiredDataSources[0]] ?? "Fixture score",
  family: getQuestionFamily(t.id),
  sports: t.sports,
}));

export const ALL_CARDS = [...REGISTRY_CARDS].sort(
  (a, b) => GRADING_RANK[a.gradingReliability] - GRADING_RANK[b.gradingReliability],
);

export const TABS = (
  ["MATCH_RESULT", "GOALS", "DISCIPLINE", "PLAYER_PROPS"] as CardCategory[]
).filter((cat) => ALL_CARDS.some((c) => c.category === cat));

// Same as TABS, but for one specific sport — a tab with cards that don't
// apply to a given fixture's sport has nothing to show and shouldn't render
// as a clickable-but-empty tab. Both wizards use this instead of the static
// TABS once a fixture (or, in multi-fixture mode, at least one fixture) is
// selected.
export function tabsForSport(sport: string): CardCategory[] {
  return TABS.filter((tab) => ALL_CARDS.some((c) => c.category === tab && cardMatchesSport(c, sport)));
}

export function isLegacyId(id: string): id is "WHO_WILL_ADVANCE" | "REGULATION_RESULT" {
  return id === "WHO_WILL_ADVANCE" || id === "REGULATION_RESULT";
}

export const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
