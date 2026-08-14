-- fixture_odds_cache was keyed by external_fixture_id alone
-- (20260101000091_odds_recommendation_evidence.sql), but external fixture
-- IDs are only unique within one provider's own numbering — API-Football
-- and API-NFL can and do issue the same numeric ID to two unrelated
-- fixtures. Combined with a real routing bug (fixed alongside this
-- migration: a non-football fixture's markets were being fetched from
-- api_football regardless of its real provider), this table could in
-- principle have served one sport's cached markets back under the other
-- sport's fixture ID. Every row ever written here came from
-- apiFootballProvider.getFixtureMarkets (see lib/actions/odds.ts) — this
-- table has no other writer — so every existing row is safely backfilled
-- as api_football, not guessed.

alter table public.fixture_odds_cache
  add column provider text not null default 'api_football';

-- The default above exists only to backfill pre-existing rows cheaply; new
-- rows must always state their provider explicitly (see getFixtureMarketsAction),
-- so the default is dropped once existing rows have it.
alter table public.fixture_odds_cache
  alter column provider drop default;

alter table public.fixture_odds_cache
  drop constraint fixture_odds_cache_pkey;

alter table public.fixture_odds_cache
  add constraint fixture_odds_cache_pkey primary key (provider, external_fixture_id);
