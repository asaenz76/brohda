-- Phase 3 (provider-neutral routing + provider-scoped health/quota):
-- additive schema for request-log detail, a shared raw-odds cache (both
-- providers), and closing team_players' provider-identity gap the same
-- way fixture_odds_cache's was already closed (20260101000116).

-- 1. provider_request_log: richer, still-optional detail per request.
-- Every column is nullable — populated only where a caller actually knows
-- the value (spec §8: "do not over-engineer if the current schema cannot
-- support all of this cleanly"). normalized_error_type mirrors the small
-- taxonomy in lib/sports-data/provider-errors.ts; caller_category
-- distinguishes manual_admin/scheduled_sync/pool_creation/discovery/
-- troubleshooting; cache_hit is only ever set by call sites that actually
-- have a cache to hit or miss; the quota_* columns stay null until a
-- provider is ever confirmed to expose that data in a response (none do
-- today — see provider-gateway.ts's own comment on this).
alter table public.provider_request_log
  add column normalized_error_type text,
  add column caller_category text,
  add column cache_hit boolean,
  add column quota_requests_remaining integer,
  add column quota_requests_limit integer,
  add column quota_reset_at timestamptz;

-- getProviderStatus's per-provider read (.eq("provider", provider).order
-- ("created_at", ...)) was previously backed only by the plain created_at
-- index — fine for one provider, but the Provider Status panel now runs
-- this query twice per page load (api_football and api_nfl independently,
-- spec §6), so the provider-scoped shape is the one actually queried.
create index idx_provider_request_log_provider_created_at
on public.provider_request_log (provider, created_at desc);

-- 2. Shared raw-odds-response cache — spec §14/§15. Both
-- api-football-provider.ts's callOddsEndpoint and
-- api-nfl-provider.ts's callNflOddsEndpoint check/populate this before
-- making a live request, so two odds-backed actions for the same fixture
-- within the TTL (e.g. the pool wizard's goals-line prefill and its
-- markets-driven recommendation fetch, confirmed to both fire for the
-- same fixture) share one live provider response instead of two. This is
-- a cache of the RAW provider item, not a re-derivation of
-- fixture_odds_cache's already-normalized markets — the two normalized
-- shapes (NormalizedFixtureOdds vs NormalizedFixtureMarkets) are built
-- from the same raw response but stay independently derived, so no
-- normalization/grading logic changes. Also gives API-NFL's odds path a
-- cache for the first time; it previously had none.
create table public.fixture_odds_raw_cache (
  provider            text not null,
  external_fixture_id text not null,
  raw_response        jsonb not null,
  fetched_at          timestamptz not null default now(),
  primary key (provider, external_fixture_id)
);

alter table public.fixture_odds_raw_cache enable row level security;

-- Internal cache only, same convention as fixture_odds_cache — nothing in
-- the client ever reads this table directly.
grant select, insert, update, delete on public.fixture_odds_raw_cache to service_role;

-- 3. team_players: close the same provider-identity gap
-- fixture_odds_cache had before 20260101000116. Currently dormant (only
-- ApiFootballProvider.getTeamSquad is ever called — NFL's is a stub — and
-- the one template that reaches this cache is football-only), but the
-- schema itself gave no guarantee of that, unlike every other
-- provider-external-id-keyed table in this codebase.
alter table public.team_players
  add column provider text not null default 'api_football';
alter table public.team_players
  alter column provider drop default;

alter table public.team_players
  drop constraint team_players_team_external_id_external_player_id_key;
alter table public.team_players
  add constraint team_players_provider_team_external_id_external_player_id_key
  unique (provider, team_external_id, external_player_id);
