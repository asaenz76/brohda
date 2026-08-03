-- Root-cause fix: the admin Competitions list page's per-competition status
-- computation (getCompetitionManagerDataAction) used to fetch every raw
-- fixture row for every imported competition in one unordered
-- `.in("competition_external_id", ...)` query, then aggregate in JS.
-- PostgREST caps a single unordered select at its default row limit
-- (1000) — once the total fixtures across all imported competitions
-- crosses that (confirmed in production: 1852 rows across 8 competitions),
-- which rows are returned is effectively arbitrary, and an entire
-- competition's future fixtures can be silently dropped from the
-- aggregate while its past ones remain, making it look like every known
-- fixture is terminal ("season over") when it isn't. This aggregates
-- server-side instead, so correctness never depends on transferring every
-- row to the app. Also returns a recommendation-window fixture count (30
-- days by default) for the "All competitions" catalog rows, computed in
-- the same pass rather than a second query.
create or replace function public.get_competition_fixture_aggregates(
  p_external_league_ids text[],
  p_terminal_statuses text[],
  p_activation_window_days integer,
  p_recommendation_window_days integer default 30
)
returns table (
  external_league_id text,
  season text,
  next_fixture_at timestamptz,
  has_fixture_within_activation_window boolean,
  all_known_fixtures_terminal boolean,
  fixtures_within_recommendation_window bigint
)
language sql
stable
as $$
  select
    f.competition_external_id as external_league_id,
    f.season,
    min(f.scheduled_start_utc) filter (where f.scheduled_start_utc > now()) as next_fixture_at,
    bool_or(
      f.scheduled_start_utc > now()
      and f.scheduled_start_utc <= now() + (p_activation_window_days || ' days')::interval
    ) as has_fixture_within_activation_window,
    bool_and(f.internal_status::text = any(p_terminal_statuses)) as all_known_fixtures_terminal,
    count(*) filter (
      where f.scheduled_start_utc > now()
        and f.scheduled_start_utc <= now() + (p_recommendation_window_days || ' days')::interval
    ) as fixtures_within_recommendation_window
  from public.fixtures f
  where f.competition_external_id = any(p_external_league_ids)
    and f.competition_external_id is not null
    and f.season is not null
  group by f.competition_external_id, f.season;
$$;

grant execute on function public.get_competition_fixture_aggregates(text[], text[], integer, integer) to service_role;
