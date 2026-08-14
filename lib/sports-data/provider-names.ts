/**
 * Single source of truth for the two provider identity strings stored in
 * `fixtures.provider` / `provider_request_log.provider` / etc. Exists so
 * routing logic (which provider's odds endpoint may a given fixture use)
 * compares against one shared constant instead of scattered string
 * literals — a typo'd literal in a comparison would silently defeat a
 * routing guard rather than fail to compile.
 */
export const API_FOOTBALL_PROVIDER = "api_football" as const;
export const API_NFL_PROVIDER = "api_nfl" as const;

export type FixtureProvider = typeof API_FOOTBALL_PROVIDER | typeof API_NFL_PROVIDER;
