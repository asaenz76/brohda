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
  league: string | null;
  label: string;
  scheduledStartUtc: string;
}

// Cards from the registry (17 TEMPLATE_GRADED templates) plus the 3 legacy
// pool_types, unified into one tabbed picker. Legacy cards keep their exact
// existing creation behavior (server derives question, hardcoded eligibility
// check) — they're catalog metadata only here, not registry entries, since
// their grading lives in SQL, not a gradingRule. Shared by both the
// single-fixture wizard (pool-template-builder.tsx) and the multi-fixture
// mode (multi-fixture-builder.tsx) so the two pickers stay in sync
// automatically as templates are added.
//
// Stage 4: TEMPLATE_GRADED is now the suggested/default path — registry
// cards are concatenated before legacy cards (see ALL_CARDS below).
//
// Question Family evolution: WHO_WILL_ADVANCE/REGULATION_RESULT no longer
// share the MATCH_RESULT category with the 4 registry match-result
// templates — they're genuinely traditional 1X2/knockout markets, not
// binary prediction questions, and both still stamp Question Family
// MATCH_RESULT (lib/pools/templates/families.ts) so duplicate/mirror
// detection still catches the overlap between "Who will advance?" and
// "Will Team X win?" even though they now live in separate tabs.
export type CardCategory = "MATCH_RESULT" | "GOALS" | "DISCIPLINE" | "PLAYER_PROPS" | "TRADITIONAL" | "COMBO";
export const CATEGORY_LABELS: Record<CardCategory, string> = {
  MATCH_RESULT: "Prediction questions",
  GOALS: "Goals",
  DISCIPLINE: "Cards",
  PLAYER_PROPS: "Players",
  TRADITIONAL: "Traditional markets",
  COMBO: "Combos",
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
}

const LEGACY_CARDS: TemplateCard[] = [
  {
    id: "WHO_WILL_ADVANCE",
    category: "TRADITIONAL",
    name: "Who will advance?",
    description: "Knockout matches only — winner counts extra time and penalties.",
    gradingReliability: "AUTO",
    dataSource: "Fixture score",
    family: getQuestionFamily("WHO_WILL_ADVANCE"),
  },
  {
    id: "REGULATION_RESULT",
    category: "TRADITIONAL",
    name: "Result after regulation",
    description: "1X2 — home win, draw, or away win. 90 minutes + injury time only.",
    gradingReliability: "AUTO",
    dataSource: "Fixture score",
    family: getQuestionFamily("REGULATION_RESULT"),
  },
  {
    id: "COMBO",
    category: "COMBO",
    name: "Combo (multi-leg Yes/No)",
    description: "Yes/No prop tied to this match. “Yes” wins only if every condition is met.",
    gradingReliability: "MANUAL",
    dataSource: "Manual grading",
    family: getQuestionFamily("COMBO"),
  },
];

const REGISTRY_BY_CATEGORY = listByCategory();
const REGISTRY_CARDS: TemplateCard[] = [
  ...(REGISTRY_BY_CATEGORY.MATCH_RESULT ?? []),
  ...(REGISTRY_BY_CATEGORY.GOALS ?? []),
  ...(REGISTRY_BY_CATEGORY.DISCIPLINE ?? []),
  ...(REGISTRY_BY_CATEGORY.PLAYER_PROPS ?? []),
].map((t) => ({
  id: t.id,
  category: t.category as CardCategory,
  name: t.name,
  description: t.description,
  gradingReliability: (t.requiredDataSources.includes("FIXTURE_EVENTS")
    ? "NEEDS_LIVE_DATA"
    : "AUTO") as GradingReliability,
  dataSource: DATA_SOURCE_LABELS[t.requiredDataSources[0]] ?? "Fixture score",
  family: getQuestionFamily(t.id),
}));

export const ALL_CARDS = [...REGISTRY_CARDS, ...LEGACY_CARDS].sort(
  (a, b) => GRADING_RANK[a.gradingReliability] - GRADING_RANK[b.gradingReliability],
);

export const TABS = (
  ["MATCH_RESULT", "GOALS", "DISCIPLINE", "PLAYER_PROPS", "TRADITIONAL", "COMBO"] as CardCategory[]
).filter((cat) => ALL_CARDS.some((c) => c.category === cat));

export function isLegacyId(id: string): id is "WHO_WILL_ADVANCE" | "REGULATION_RESULT" | "COMBO" {
  return id === "WHO_WILL_ADVANCE" || id === "REGULATION_RESULT" || id === "COMBO";
}

export const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
