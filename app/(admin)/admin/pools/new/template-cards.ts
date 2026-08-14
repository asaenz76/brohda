import { listByCategory } from "@/lib/pools/templates/registry";
import { getQuestionFamily, type QuestionFamily } from "@/lib/pools/templates/families";
import { getSupportedCompetitionGroup, type CompetitionGroup } from "@/lib/sports-data/supported-competitions";

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
  // The sports-data provider this fixture came from (e.g. "api_football",
  // "api_nfl") — threaded through so odds/markets calls can be routed to
  // the correct provider instead of assumed, see lib/actions/odds.ts's
  // assertProvider.
  provider: string;
  league: string | null;
  label: string;
  scheduledStartUtc: string;
  // Groups this fixture under one entry in the imported-competition filter
  // (`${provider}:${competitionExternalId}:${season}`) — null only for a
  // fixture missing competition linkage, which then can't be filtered by
  // competition (still shows up under "All competitions").
  competitionKey: string | null;
}

// One row in the pool-creation "Imported competition" filter — built
// directly from the already-gated fixtures list (fixtures_available_for_pool_creation
// already excludes anything not IMPORTED/archived/pool_creation_enabled=false,
// see the migration for that view), so a competition only ever appears here
// once it truly has at least one fixture eligible for pool creation right
// now. Deliberately not a second query against league_season_imports — that
// would risk drifting from what's actually in the fixtures list below it.
export interface CompetitionOption {
  key: string;
  label: string;
  group: CompetitionGroup | null;
  fixtureCount: number;
}

export function buildCompetitionOptions(fixtures: FixtureOption[]): CompetitionOption[] {
  const byKey = new Map<string, CompetitionOption>();
  for (const f of fixtures) {
    if (!f.competitionKey) continue;
    const existing = byKey.get(f.competitionKey);
    if (existing) {
      existing.fixtureCount += 1;
      continue;
    }
    // externalLeagueId is the middle segment of competitionKey
    // (`${provider}:${externalLeagueId}:${season}`).
    const externalLeagueId = f.competitionKey.split(":")[1] ?? "";
    byKey.set(f.competitionKey, {
      key: f.competitionKey,
      label: f.league ?? "Unknown competition",
      group: getSupportedCompetitionGroup(externalLeagueId),
      fixtureCount: 1,
    });
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
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
export type CardCategory = "MATCH_RESULT" | "GOALS" | "DISCIPLINE" | "PLAYER_PROPS" | "TRADITIONAL";
export const CATEGORY_LABELS: Record<CardCategory, string> = {
  MATCH_RESULT: "Prediction questions",
  GOALS: "Goals",
  DISCIPLINE: "Cards",
  PLAYER_PROPS: "Players",
  TRADITIONAL: "Traditional markets",
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
  // real array from PoolTemplate.sports (see registry.ts/types.ts) — every
  // football-era template is written in football-specific language
  // ("goals", "clean sheet") and most need FIXTURE_EVENTS data the NFL
  // provider never populates, so none of them are offered for NFL fixtures.
  // The 2 legacy cards are also always football-only now — their real
  // eligibility still depends on competition type (Cup vs League), checked
  // separately via getTemplateEligibility, but getTemplateEligibility
  // unconditionally disables both for any non-football sport regardless of
  // competition type, so `["football"]` here is behaviorally lossless and
  // lets tabsForSport correctly drop the whole "Traditional markets" tab
  // for NFL instead of showing it with both cards greyed out.
  sports: string[] | null;
}

// True when `card` is applicable to a fixture of the given sport — the one
// place both wizards should check this, so a future sport doesn't need the
// filtering logic duplicated between pool-template-builder.tsx and
// multi-fixture-builder.tsx.
export function cardMatchesSport(card: TemplateCard, sport: string): boolean {
  return card.sports === null || card.sports.includes(sport);
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
    sports: ["football"],
  },
  {
    id: "REGULATION_RESULT",
    category: "TRADITIONAL",
    name: "Result after regulation",
    description: "1X2 — home win, draw, or away win. 90 minutes + injury time only.",
    gradingReliability: "AUTO",
    dataSource: "Fixture score",
    family: getQuestionFamily("REGULATION_RESULT"),
    sports: ["football"],
  },
];

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

export const ALL_CARDS = [...REGISTRY_CARDS, ...LEGACY_CARDS].sort(
  (a, b) => GRADING_RANK[a.gradingReliability] - GRADING_RANK[b.gradingReliability],
);

export const TABS = (
  ["MATCH_RESULT", "GOALS", "DISCIPLINE", "PLAYER_PROPS", "TRADITIONAL"] as CardCategory[]
).filter((cat) => ALL_CARDS.some((c) => c.category === cat));

// Same as TABS, but for one specific sport — a tab with cards for football
// only (e.g. "Cards"/DISCIPLINE, entirely red-card templates) has nothing
// to show for an NFL fixture and shouldn't render as a clickable-but-empty
// tab. Both wizards use this instead of the static TABS once a fixture (or,
// in multi-fixture mode, at least one fixture) is selected.
export function tabsForSport(sport: string): CardCategory[] {
  return TABS.filter((tab) => ALL_CARDS.some((c) => c.category === tab && cardMatchesSport(c, sport)));
}

export function isLegacyId(id: string): id is "WHO_WILL_ADVANCE" | "REGULATION_RESULT" {
  return id === "WHO_WILL_ADVANCE" || id === "REGULATION_RESULT";
}

export const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
