// NFL's equivalent of supported-competitions.ts — deliberately a separate,
// much smaller file rather than folding into SUPPORTED_COMPETITIONS.
//
// Two reasons this isn't just "add a provider field to SupportedCompetition
// and one more entry": (1) getSupportedCompetitionMap() there keys purely
// by bare externalLeagueId, with 11 call sites across the codebase — a
// shared map risks API-Football's and API-NFL's small numeric league IDs
// silently colliding, and touching all 11 call sites to disambiguate by
// provider is real surface area against working, production football code
// for a feature that doesn't need it. (2) football's config exists to
// curate a many-leagues problem (14 competitions and growing); the NFL is
// a single competition — the multi-competition discovery/availability-cache
// machinery football needs has no real analog here.
export const NFL_PROVIDER = "api_nfl" as const;

export interface SupportedNflCompetition {
  // null = intentionally not yet resolved — same convention as
  // supported-competitions.ts: never fabricate an ID, resolve it with a
  // live getLeagueById/searchLeagues call once the provider key is
  // configured and verified.
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
