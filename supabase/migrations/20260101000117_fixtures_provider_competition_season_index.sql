-- Phase 2 (local-first football browsing): the dominant query shape for
-- local fixture browsing — and already for get_competition_fixture_aggregates
-- (20260101000097) and enrichFixtures' fixture-import lookups — filters by
-- competition_external_id/season, always scoped to one provider. No
-- composite index existed for this (confirmed against every prior fixtures
-- migration: only scheduled_start_utc, internal_status, and the
-- (internal_status, scheduled_start_utc) pair). Justified by the actual
-- query shape used throughout lib/fixtures/local-browse.ts, not
-- speculative.
create index idx_fixtures_provider_competition_season
on public.fixtures (provider, competition_external_id, season);
