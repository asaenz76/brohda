-- Recommendation-eligibility cache for the /admin/competitions "Recommended"
-- tab — refreshed by a scheduled cron (refresh-recommendation-cache), never
-- fanned out live across every PRIORITY_LEAGUES entry on page load. See the
-- discussion "Recommended availability cache" — 6h TTL when a league had
-- upcoming fixtures last check, 24h when it didn't, plus a per-row manual
-- refresh action.

create table public.competition_availability_cache (
  id                      uuid primary key default gen_random_uuid(),
  provider                text not null default 'api_football',
  external_league_id      text not null,
  season                  text not null,
  upcoming_fixture_count  integer not null default 0,
  next_fixture_at         timestamptz,
  window_days             integer not null,
  checked_at              timestamptz not null default now(),
  check_error             text,
  unique (provider, external_league_id, season)
);

alter table public.competition_availability_cache enable row level security;

create policy "members_can_read_competition_availability_cache"
on public.competition_availability_cache for select to authenticated using (true);

grant select on public.competition_availability_cache to authenticated;
grant select, insert, update, delete on public.competition_availability_cache to service_role;
