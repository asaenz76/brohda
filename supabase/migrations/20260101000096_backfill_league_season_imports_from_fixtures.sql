-- One-time backfill so migration 95's pool-creation gate doesn't go dark
-- the moment it ships: every competition/season already present in
-- fixtures (imported through the old ad-hoc /admin/fixtures search flow,
-- long before league_season_imports existed) gets a matching row here,
-- marked IMPORTED and pool_creation_enabled, so today's pool-creation
-- availability carries over unchanged. leagues already has a row for
-- every (provider, competition_external_id) pair — lib/actions/fixtures.ts
-- upserts it on every fixture import, and 20260101000080 backfilled the
-- rest — so the join below never needs to create leagues rows itself.
-- do nothing (not do update): a genuinely new import going forward goes
-- through the real import pipeline (lib/competitions/process-chunk.ts),
-- which sets richer fields than this best-effort backfill would.
insert into public.league_season_imports (
  provider,
  external_league_id,
  season,
  league_id,
  import_status,
  imported_at,
  pool_creation_enabled,
  fixture_count_imported,
  upcoming_fixture_count,
  completed_fixture_count
)
select
  f.provider,
  f.competition_external_id,
  f.season,
  l.id,
  'IMPORTED',
  now(),
  true,
  count(*),
  count(*) filter (where f.internal_status not in ('COMPLETED', 'CANCELLED', 'ABANDONED', 'AWARDED')),
  count(*) filter (where f.internal_status in ('COMPLETED', 'AWARDED'))
from public.fixtures f
join public.leagues l
  on l.provider = f.provider and l.external_id = f.competition_external_id
where f.competition_external_id is not null
  and f.season is not null
group by f.provider, f.competition_external_id, f.season, l.id
on conflict (provider, external_league_id, season) do nothing;
