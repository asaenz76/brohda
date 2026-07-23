import type { NormalizedFixtureEvent } from "@/lib/sports-data/types";

/**
 * Deterministic grading outcome for a registry template — never derived
 * from natural-language interpretation. PENDING means "can't be determined
 * yet, try again later," never "assume the worst/zero."
 */
export type PoolResult = "YES" | "NO" | "VOID" | "PENDING";

export type PoolTemplateCategory =
  | "MATCH_RESULT"
  | "GOALS"
  | "TEAM_PROPS"
  | "PLAYER_PROPS"
  | "MATCH_STATS"
  | "DISCIPLINE"
  | "COMBO"
  | "CUSTOM";

/** Which API-Football-derived source a template needs. Phase 1 templates
 * only ever use FIXTURE (already synced for every pool); the rest are
 * typed now so later phases (match events, statistics, player props) don't
 * need a breaking change to this union. */
export type DataSource = "FIXTURE" | "FIXTURE_EVENTS" | "FIXTURE_STATISTICS" | "FIXTURE_PLAYERS" | "LINEUPS";

export interface GradingEvidenceItem {
  source: string;
  field?: string;
  rawValue?: unknown;
  normalizedValue?: unknown;
}

export interface GradingResult {
  result: PoolResult;
  reason: string;
  evidence: GradingEvidenceItem[];
}

export type TemplateAvailability =
  | { available: true }
  | { available: false; reason: string }
  | { available: true; warning: string };

/** TEAM_SIDE/INTEGER from Phase 1; PLAYER (Phase 2) needs the fixture's
 * actual roster at render time, which isn't known statically here — the
 * wizard fetches it via lib/actions/squads.ts once a fixture is picked and
 * renders app/(admin)/admin/pools/new/player-picker.tsx for it. */
export type ConfigFieldDefinition =
  | { key: string; label: string; type: "TEAM_SIDE" }
  | { key: string; label: string; type: "INTEGER"; min: number; max: number }
  | { key: string; label: string; type: "PLAYER" }
  | { key: string; label: string; type: "BOOLEAN" };

/** The minimal fixture shape every Phase-1 gradingRule reads — a subset of
 * the `fixtures` row's own columns (never provider-raw shapes). */
export interface TemplateFixtureScore {
  homeTeamName: string;
  awayTeamName: string;
  // Populated for every fixture (already synced by /fixtures) — Phase 2's
  // event templates need these to match a NormalizedFixtureEvent.teamExternalId
  // back to "home" or "away"; Phase 1 templates never read them.
  homeTeamExternalId: string | null;
  awayTeamExternalId: string | null;
  regulationHomeScore: number | null;
  regulationAwayScore: number | null;
  halftimeHomeScore: number | null;
  halftimeAwayScore: number | null;
}

/** `fixture` (Phase 1) and `events` (Phase 2) are populated; statistics/
 * players/lineups are typed now so Phases 3-4 can add real fetchers
 * without a breaking change to templates already written against this
 * type. `events` is only ever populated when the fixture's cached
 * provider_events_payload is non-null — see grade.ts's PENDING gate. */
export interface FixtureDataBundle {
  fixture?: TemplateFixtureScore;
  events?: NormalizedFixtureEvent[];
  statistics?: unknown[];
  players?: unknown[];
  lineups?: unknown[];
}

/** Stub for now — Phase 1 templates only ever need FIXTURE, which every
 * synced fixture already has, so there's no competition-coverage variable
 * to check yet. Real per-league coverage flags land with Phases 2-4. */
export type CompetitionCoverage = Record<DataSource, boolean>;

// The 3 config-dependent members use method shorthand (not arrow-typed
// properties) deliberately — TS applies bivariant parameter checking to
// interface methods, which is what lets a PoolTemplate<TeamSideConfig> (or
// any other per-template config shape) live alongside every other template
// in one homogeneous TEMPLATE_REGISTRY array without an unsafe cast.
export interface PoolTemplate<TConfig = Record<string, unknown>> {
  id: string;
  category: PoolTemplateCategory;
  name: string;
  description: string;
  questionBuilder(fixture: TemplateFixtureScore, config: TConfig): string;
  requiredConfigFields: ConfigFieldDefinition[];
  requiredDataSources: DataSource[];
  availabilityCheck(fixture: TemplateFixtureScore, coverage: CompetitionCoverage): TemplateAvailability;
  gradingRule(data: FixtureDataBundle, config: TConfig): GradingResult;
}
