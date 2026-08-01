// Curated set of "major" competitions to surface first in the admin
// fixture-import league picker (see app/(admin)/admin/fixtures/league-select.tsx)
// — this platform's current focus, not every league/cup API-Football
// knows about. Tiers and IDs come from an internal review of which
// competitions have enough recognition, data coverage, and market depth to
// sustain pools year-round (A), serve as a solid complement especially in
// lighter weeks (B), or fill out the calendar despite lower recognition/
// coverage (C).
//
// Whether an entry is actually "in season now" is decided by the real
// per-season `current` flag API-Football provides (see
// lib/sports-data/league-picker.ts), not a hand-guessed calendar — a prior
// version of this file tried to approximate each league's active months by
// hand and had no way to represent irregularly-scheduled cups (e.g. the
// CONCACAF Central American Cup) at all, which is exactly why they were
// missing from the picker's top group.
export type LeagueTier = "A" | "B" | "C";

export interface PriorityLeague {
  externalLeagueId: string;
  tier: LeagueTier;
}

export const PRIORITY_LEAGUES: PriorityLeague[] = [
  // Tier A — always active whenever in season
  { externalLeagueId: "39", tier: "A" }, // Premier League
  { externalLeagueId: "140", tier: "A" }, // LaLiga
  { externalLeagueId: "135", tier: "A" }, // Serie A
  { externalLeagueId: "78", tier: "A" }, // Bundesliga
  { externalLeagueId: "61", tier: "A" }, // Ligue 1
  { externalLeagueId: "2", tier: "A" }, // UEFA Champions League
  { externalLeagueId: "3", tier: "A" }, // UEFA Europa League
  { externalLeagueId: "71", tier: "A" }, // Brasileirão Série A
  { externalLeagueId: "128", tier: "A" }, // Argentina Liga Profesional
  { externalLeagueId: "262", tier: "A" }, // Liga MX
  { externalLeagueId: "253", tier: "A" }, // MLS
  { externalLeagueId: "307", tier: "A" }, // Saudi Pro League

  // Tier B — good complementary coverage
  { externalLeagueId: "239", tier: "B" }, // Colombia Primera A
  { externalLeagueId: "162", tier: "B" }, // Costa Rica Liga Promerica
  { externalLeagueId: "242", tier: "B" }, // Ecuador LigaPro
  { externalLeagueId: "281", tier: "B" }, // Peru Liga 1
  { externalLeagueId: "265", tier: "B" }, // Chile Primera División
  { externalLeagueId: "98", tier: "B" }, // J1 League
  { externalLeagueId: "292", tier: "B" }, // K League 1
  { externalLeagueId: "113", tier: "B" }, // Allsvenskan
  { externalLeagueId: "103", tier: "B" }, // Eliteserien
  { externalLeagueId: "268", tier: "B" }, // Uruguay Primera División
  { externalLeagueId: "250", tier: "B" }, // Paraguay División Profesional
  { externalLeagueId: "1028", tier: "B" }, // CONCACAF Central American Cup
  { externalLeagueId: "22", tier: "B" }, // CONCACAF Gold Cup
  { externalLeagueId: "536", tier: "B" }, // CONCACAF Nations League
  { externalLeagueId: "9", tier: "B" }, // Copa América

  // Tier C — fills out the calendar; lower recognition/coverage
  { externalLeagueId: "169", tier: "C" }, // Chinese Super League
  { externalLeagueId: "244", tier: "C" }, // Veikkausliiga
  { externalLeagueId: "357", tier: "C" }, // Ireland Premier Division
];

const TIER_ORDER: Record<LeagueTier, number> = { A: 0, B: 1, C: 2 };

export function getPriorityLeagueMap(): Map<string, PriorityLeague> {
  return new Map(PRIORITY_LEAGUES.map((entry) => [entry.externalLeagueId, entry]));
}

export function compareLeagueTier(a: LeagueTier, b: LeagueTier): number {
  return TIER_ORDER[a] - TIER_ORDER[b];
}
