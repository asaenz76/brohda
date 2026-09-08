// The NFL's curated list of supported competitions — deliberately a small,
// explicit allowlist rather than trusting every league id a provider
// returns. The NFL is a single competition, unlike a many-competitions
// sport (Association football, retired — see docs/ARCHITECTURE.md — used
// to need a much larger discovery/availability-cache machinery this file
// has no analog to, and doesn't need one).
export const NFL_PROVIDER = "api_nfl" as const;

export interface SupportedNflCompetition {
  // null = intentionally not yet resolved — never fabricate an ID, resolve
  // it with a live getLeagueById/searchLeagues call once the provider key
  // is configured and verified.
  externalLeagueId: string | null;
  name: string;
  enabled: boolean;
}

export const SUPPORTED_NFL_COMPETITIONS: SupportedNflCompetition[] = [
  // externalLeagueId "1" confirmed live against GET /leagues while
  // building the provider client (results also included "2" = NCAA,
  // deliberately not supported here).
  { externalLeagueId: "1", name: "NFL", enabled: true },
];

export function getSupportedNflCompetition(externalLeagueId: string | null | undefined): SupportedNflCompetition | null {
  if (!externalLeagueId) return null;
  return SUPPORTED_NFL_COMPETITIONS.find((c) => c.enabled && c.externalLeagueId === externalLeagueId) ?? null;
}

export function isSupportedNflCompetition(externalLeagueId: string | null | undefined): boolean {
  return getSupportedNflCompetition(externalLeagueId) != null;
}
