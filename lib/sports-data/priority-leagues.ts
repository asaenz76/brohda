// Curated set of "major" leagues to surface first in the admin fixture-
// import league picker (see app/(admin)/admin/fixtures/league-select.tsx) —
// this platform's current focus, not every league API-Football knows
// about. Tiers and IDs come from an internal review of which leagues have
// enough recognition, data coverage, and market depth to sustain pools
// year-round (A), serve as a solid complement especially in lighter weeks
// (B), or fill out the calendar despite lower recognition/coverage (C).
//
// activeMonths is a stable, year-agnostic approximation (1 = January ... 12
// = December) of when each league is normally in season — deliberately NOT
// exact per-season start/end dates, which shift by a few days every year
// and would need constant upkeep here. Split-calendar leagues (e.g. Liga
// MX's Apertura/Clausura, most South American annual leagues) run close to
// year-round, so they're simply marked active every month rather than
// modeling each tournament's exact window.
export type LeagueTier = "A" | "B" | "C";

export interface PriorityLeague {
  externalLeagueId: string;
  tier: LeagueTier;
  activeMonths: number[];
}

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export const PRIORITY_LEAGUES: PriorityLeague[] = [
  // Tier A — always active whenever in season
  { externalLeagueId: "39", tier: "A", activeMonths: [1, 2, 3, 4, 5, 8, 9, 10, 11, 12] }, // Premier League
  { externalLeagueId: "140", tier: "A", activeMonths: [1, 2, 3, 4, 5, 8, 9, 10, 11, 12] }, // LaLiga
  { externalLeagueId: "135", tier: "A", activeMonths: [1, 2, 3, 4, 5, 8, 9, 10, 11, 12] }, // Serie A
  { externalLeagueId: "78", tier: "A", activeMonths: [1, 2, 3, 4, 5, 8, 9, 10, 11, 12] }, // Bundesliga
  { externalLeagueId: "61", tier: "A", activeMonths: [1, 2, 3, 4, 5, 8, 9, 10, 11, 12] }, // Ligue 1
  { externalLeagueId: "2", tier: "A", activeMonths: ALL_MONTHS }, // UEFA Champions League
  { externalLeagueId: "3", tier: "A", activeMonths: [1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12] }, // UEFA Europa League
  { externalLeagueId: "71", tier: "A", activeMonths: [4, 5, 6, 7, 8, 9, 10, 11, 12] }, // Brasileirão Série A
  { externalLeagueId: "128", tier: "A", activeMonths: ALL_MONTHS }, // Argentina Liga Profesional
  { externalLeagueId: "262", tier: "A", activeMonths: ALL_MONTHS }, // Liga MX
  { externalLeagueId: "253", tier: "A", activeMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }, // MLS
  { externalLeagueId: "307", tier: "A", activeMonths: [1, 2, 3, 4, 5, 8, 9, 10, 11, 12] }, // Saudi Pro League

  // Tier B — good complementary coverage
  { externalLeagueId: "239", tier: "B", activeMonths: ALL_MONTHS }, // Colombia Primera A
  { externalLeagueId: "162", tier: "B", activeMonths: ALL_MONTHS }, // Costa Rica Liga Promerica
  { externalLeagueId: "242", tier: "B", activeMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }, // Ecuador LigaPro
  { externalLeagueId: "281", tier: "B", activeMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }, // Peru Liga 1
  { externalLeagueId: "265", tier: "B", activeMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }, // Chile Primera División
  { externalLeagueId: "98", tier: "B", activeMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }, // J1 League
  { externalLeagueId: "292", tier: "B", activeMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }, // K League 1
  { externalLeagueId: "113", tier: "B", activeMonths: [3, 4, 5, 6, 7, 8, 9, 10, 11] }, // Allsvenskan
  { externalLeagueId: "103", tier: "B", activeMonths: [3, 4, 5, 6, 7, 8, 9, 10, 11] }, // Eliteserien
  { externalLeagueId: "268", tier: "B", activeMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }, // Uruguay Primera División
  { externalLeagueId: "250", tier: "B", activeMonths: ALL_MONTHS }, // Paraguay División Profesional

  // Tier C — fills out the calendar; lower recognition/coverage
  { externalLeagueId: "169", tier: "C", activeMonths: [3, 4, 5, 6, 7, 8, 9, 10, 11] }, // Chinese Super League
  { externalLeagueId: "244", tier: "C", activeMonths: [4, 5, 6, 7, 8, 9, 10] }, // Veikkausliiga
  { externalLeagueId: "357", tier: "C", activeMonths: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }, // Ireland Premier Division
];

const TIER_ORDER: Record<LeagueTier, number> = { A: 0, B: 1, C: 2 };

export function getPriorityLeagueMap(): Map<string, PriorityLeague> {
  return new Map(PRIORITY_LEAGUES.map((entry) => [entry.externalLeagueId, entry]));
}

export function isLeagueInSeason(league: PriorityLeague, month: number): boolean {
  return league.activeMonths.includes(month);
}

export function compareLeagueTier(a: LeagueTier, b: LeagueTier): number {
  return TIER_ORDER[a] - TIER_ORDER[b];
}
