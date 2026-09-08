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

export type FixtureProvider = typeof API_NFL_PROVIDER;
