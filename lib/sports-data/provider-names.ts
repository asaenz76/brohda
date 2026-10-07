/**
 * Single source of truth for provider identity strings stored in
 * `fixtures.provider` / `provider_request_log.provider` / etc. Exists so
 * routing logic (which provider's odds endpoint may a given fixture use)
 * compares against one shared constant instead of scattered string
 * literals — a typo'd literal in a comparison would silently defeat a
 * routing guard rather than fail to compile.
 *
 * `"api_football"` is deliberately not defined here anymore — Association
 * football/soccer is retired as a Brohda sport (no new provider code
 * should ever reference it), but the literal string still exists in
 * historical `fixtures`/`pools`/`provider_request_log` rows and is read
 * back as plain `string` wherever that history is displayed, never through
 * this type.
 */
export const API_NFL_PROVIDER = "api_nfl" as const;
export const API_NBA_PROVIDER = "api_nba" as const;
export const API_NHL_PROVIDER = "api_nhl" as const;
// Declared so the shared architecture is provably MLB-compatible (see docs/MLB_COMPATIBILITY_AUDIT.md); there is deliberately NO MLB adapter
// registered in provider-registry.ts, so nothing can ingest or publish MLB until a launch milestone adds one.
export const API_MLB_PROVIDER = "api_mlb" as const;

// One identity per upstream API (their numeric ids are only unique inside one API), all sharing one pipeline — see sport-registry.ts.
export type FixtureProvider = typeof API_NFL_PROVIDER | typeof API_NBA_PROVIDER | typeof API_NHL_PROVIDER | typeof API_MLB_PROVIDER;
