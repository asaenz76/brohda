-- Phase 7 (pool-creation league filter): hard-gate pool creation's fixture
-- pool at the data layer. Previously this view was never joined to
-- league_season_imports at all — any fixture from any imported league was
-- eligible for pool creation regardless of import_status/archived_at/
-- pool_creation_enabled. Now a fixture is only eligible when its
-- competition has a matching league_season_imports row that is IMPORTED,
-- not archived, and still enabled for pool creation.
--
-- Note for the eventual production rollout of this feature: fixtures
-- imported through the old ad-hoc /admin/fixtures search flow (which never
-- wrote a league_season_imports row) will disappear from pool creation
-- until a backfill inserts a matching row for their competition/season.
create or replace view public.fixtures_available_for_pool_creation as
select f.*
from public.fixtures f
where not f.hidden_from_pool_creation
  and f.internal_status not in ('COMPLETED', 'CANCELLED', 'ABANDONED', 'AWARDED')
  and exists (
    select 1 from public.league_season_imports lsi
    where lsi.provider = f.provider
      and lsi.external_league_id = f.competition_external_id
      and lsi.season = f.season
      and lsi.import_status = 'IMPORTED'
      and lsi.archived_at is null
      and lsi.pool_creation_enabled = true
  )
  and (
    not exists (
      select 1 from public.pools p where p.fixture_id = f.id
    ) or exists (
      select 1 from public.pools p
      where p.fixture_id = f.id
        and p.status not in ('SETTLED', 'CANCELLED', 'VOIDED')
    )
  );
