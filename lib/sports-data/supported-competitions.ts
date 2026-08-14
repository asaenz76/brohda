// The single source of truth for which competitions PollPools supports —
// replaces the old three-tier PRIORITY_LEAGUES model. This is no longer a
// UI filter or a sorting hint: it's the application boundary. PollPools is
// a curated football prediction platform, not a generic browser over
// everything API-Football knows about (hundreds of leagues worldwide,
// most of which this platform will never create a pool for and should
// never spend provider quota checking).
//
// Every feature that needs to know "is this competition ours to manage" —
// sync, discovery, recommendations, the Competitions list, the Fixtures
// date search, the by-competition league picker, pool-creation template
// eligibility — reads this file. No feature should maintain its own
// competition list. Expanding coverage should mean adding one entry here,
// never touching business logic.
export type CompetitionGroup = "GLOBAL" | "COSTA_RICA";

// A competition's knockout-vs-league shape is an inherent, stable fact
// (not something that changes week to week the way a season or fixture
// count does), so it lives here as static config rather than requiring a
// live provider call to resolve on every use — this is exactly what
// pool-creation template eligibility (WHO_WILL_ADVANCE vs
// REGULATION_RESULT-shaped questions) and the Recommended/All-competitions
// type filter need, without ever touching the network for it.
export type CompetitionType = "LEAGUE" | "CUP";

export interface SupportedCompetition {
  // null = a real competition we intend to support but haven't resolved a
  // provider ID for yet (see the Costa Rica Cup/Super Cup entries below) —
  // never fabricate an ID; resolve it with a live getLeagueById/
  // searchLeagues lookup once provider quota allows, or have an admin
  // supply it directly.
  externalLeagueId: string | null;
  name: string;
  country: string;
  group: CompetitionGroup;
  type: CompetitionType;
  // A resolved-but-not-yet-active entry (enabled: false) is documented
  // here so its absence from every feature is a deliberate, visible
  // decision rather than a silent gap — never omit an entry just because
  // it isn't live yet.
  enabled: boolean;
}

export const SUPPORTED_COMPETITIONS: SupportedCompetition[] = [
  // --- Global ---
  { externalLeagueId: "39", name: "Premier League", country: "England", group: "GLOBAL", type: "LEAGUE", enabled: true },
  { externalLeagueId: "140", name: "LaLiga", country: "Spain", group: "GLOBAL", type: "LEAGUE", enabled: true },
  { externalLeagueId: "135", name: "Serie A", country: "Italy", group: "GLOBAL", type: "LEAGUE", enabled: true },
  { externalLeagueId: "78", name: "Bundesliga", country: "Germany", group: "GLOBAL", type: "LEAGUE", enabled: true },
  { externalLeagueId: "61", name: "Ligue 1", country: "France", group: "GLOBAL", type: "LEAGUE", enabled: true },
  { externalLeagueId: "2", name: "UEFA Champions League", country: "Europe", group: "GLOBAL", type: "CUP", enabled: true },
  { externalLeagueId: "3", name: "UEFA Europa League", country: "Europe", group: "GLOBAL", type: "CUP", enabled: true },
  { externalLeagueId: "71", name: "Brasileirão Série A", country: "Brazil", group: "GLOBAL", type: "LEAGUE", enabled: true },
  { externalLeagueId: "128", name: "Liga Profesional Argentina", country: "Argentina", group: "GLOBAL", type: "LEAGUE", enabled: true },
  { externalLeagueId: "262", name: "Liga MX", country: "Mexico", group: "GLOBAL", type: "LEAGUE", enabled: true },
  { externalLeagueId: "253", name: "Major League Soccer", country: "USA", group: "GLOBAL", type: "LEAGUE", enabled: true },
  { externalLeagueId: "94", name: "Primeira Liga", country: "Portugal", group: "GLOBAL", type: "LEAGUE", enabled: true },
  { externalLeagueId: "88", name: "Eredivisie", country: "Netherlands", group: "GLOBAL", type: "LEAGUE", enabled: true },
  // Continental club competitions — added per Phase 1 of the universal
  // sports architecture proposal (2026-08). Grouped under GLOBAL rather
  // than a separate continental taxonomy, matching the already-established
  // UEFA Champions/Europa League precedent above — this grouping is an
  // admin/product convenience, not a formal statement about governing
  // bodies. IDs resolved live via searchLeagues (never fabricated); real
  // country values are a product-chosen display label here too, same as
  // "Europe" for the UEFA entries above, not a literal passthrough of the
  // provider's own (unhelpful "World") countryName field.
  { externalLeagueId: "13", name: "Copa Libertadores", country: "South America", group: "GLOBAL", type: "CUP", enabled: true },
  { externalLeagueId: "11", name: "Copa Sudamericana", country: "South America", group: "GLOBAL", type: "CUP", enabled: true },
  // Confirmed live: API-Football's own internal name for this competition
  // is still "CONCACAF Champions League" (id 16) — its real-world rebrand
  // to "Concacaf Champions Cup" (2023) isn't reflected in the provider's
  // league name. There is a separate id (1136, "CONCACAF W Champions Cup")
  // for the women's competition specifically, which is not this entry.
  { externalLeagueId: "16", name: "CONCACAF Champions Cup", country: "North America", group: "GLOBAL", type: "CUP", enabled: true },
  // Disabled per an explicit product decision (Phase 1 of the universal
  // sports architecture proposal, 2026-08) — not part of the curated
  // list going forward. Historical data already imported under this
  // league is intentionally left in place, not deleted; this entry stays
  // documented (not removed) so its disabled state is a visible,
  // deliberate decision — same convention as the two unresolved Costa
  // Rica cup entries below.
  { externalLeagueId: "307", name: "Saudi Pro League", country: "Saudi Arabia", group: "GLOBAL", type: "LEAGUE", enabled: false },

  // --- Costa Rica ---
  { externalLeagueId: "162", name: "Primera División", country: "Costa Rica", group: "COSTA_RICA", type: "LEAGUE", enabled: true },
  { externalLeagueId: "163", name: "Liga de Ascenso", country: "Costa Rica", group: "COSTA_RICA", type: "LEAGUE", enabled: true },
  // A Central American club competition, not exclusively Costa Rican, but
  // grouped here (a deliberate product decision, not a geography rule) —
  // Costa Rican clubs are regular participants and it's the closest fit to
  // "competitions we may realistically create pools for" in this region.
  { externalLeagueId: "1028", name: "CONCACAF Central American Cup", country: "Central America", group: "COSTA_RICA", type: "CUP", enabled: true },
  // Real competitions, intentionally supported, but their provider league
  // IDs are not yet resolved — resolving them costs a live provider call
  // (getLeagueById/searchLeagues), and the daily quota was exhausted at
  // the time this config was written. Leave disabled until a quota-safe
  // moment to look them up; do not guess an ID.
  { externalLeagueId: null, name: "Costa Rica Cup", country: "Costa Rica", group: "COSTA_RICA", type: "CUP", enabled: false },
  { externalLeagueId: null, name: "Costa Rica Super Cup", country: "Costa Rica", group: "COSTA_RICA", type: "CUP", enabled: false },
];

/** Every enabled entry, keyed by its resolved external league ID — the
 * lookup every feature actually needs (an unresolved `externalLeagueId:
 * null` entry can never match a real fixture/league, so it's excluded
 * here by construction rather than requiring every caller to null-check). */
export function getSupportedCompetitionMap(): Map<string, SupportedCompetition> {
  return new Map(
    SUPPORTED_COMPETITIONS.filter((c): c is SupportedCompetition & { externalLeagueId: string } => c.enabled && c.externalLeagueId != null).map((c) => [
      c.externalLeagueId,
      c,
    ]),
  );
}

export function isSupportedCompetition(externalLeagueId: string | null | undefined): boolean {
  if (!externalLeagueId) return false;
  return getSupportedCompetitionMap().has(externalLeagueId);
}

export function getSupportedCompetition(externalLeagueId: string | null | undefined): SupportedCompetition | null {
  if (!externalLeagueId) return null;
  return getSupportedCompetitionMap().get(externalLeagueId) ?? null;
}

export function getSupportedCompetitionGroup(externalLeagueId: string | null | undefined): CompetitionGroup | null {
  return getSupportedCompetition(externalLeagueId)?.group ?? null;
}

const GROUP_ORDER: Record<CompetitionGroup, number> = { GLOBAL: 0, COSTA_RICA: 1 };

export function compareCompetitionGroup(a: CompetitionGroup, b: CompetitionGroup): number {
  return GROUP_ORDER[a] - GROUP_ORDER[b];
}

export const COMPETITION_GROUP_LABEL: Record<CompetitionGroup, string> = {
  GLOBAL: "Global",
  COSTA_RICA: "Costa Rica",
};
