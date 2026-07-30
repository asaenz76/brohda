-- One-time seed so currently-live fixtures are followable immediately,
-- not just future ones. The sync job only re-touches non-terminal
-- fixtures (see lib/sports-data/sync.ts's internal_status filter), so an
-- already-settled fixture would otherwise never populate teams/leagues.
-- do nothing (not do update): this is a best-effort one-time backfill —
-- ongoing freshness is the sync job's job going forward.

insert into public.teams (provider, external_id, name, logo_url)
select provider, home_team_external_id, home_team_name, home_team_logo_url
from public.fixtures
where home_team_external_id is not null
union
select provider, away_team_external_id, away_team_name, away_team_logo_url
from public.fixtures
where away_team_external_id is not null
on conflict (provider, external_id) do nothing;

insert into public.leagues (provider, external_id, name, logo_url)
select distinct provider, competition_external_id, competition_name, competition_logo_url
from public.fixtures
where competition_external_id is not null
on conflict (provider, external_id) do nothing;
