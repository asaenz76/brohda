-- Follow-teams/leagues feature: teams and leagues become first-class
-- reference data for the first time. Previously only denormalized text
-- columns (external_id/name/logo_url) existed on fixtures/pool_options —
-- a follow relationship needs a stable row to attach to, not scattered
-- duplicated text. Kept fresh going forward by the sync job (see
-- lib/sports-data/persist.ts's toTeamRows/toLeagueRow); backfilled for
-- already-existing fixtures in the next migration.

create table public.teams (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null,
  external_id text not null,
  name        text not null,
  logo_url    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index unique_team on public.teams (provider, external_id);

create trigger teams_set_updated_at
before update on public.teams
for each row execute function public.set_updated_at();

alter table public.teams enable row level security;

-- Same shape as fixtures: non-sensitive reference data, readable by any
-- authenticated member, all writes via the service role (sync job).
create policy "members_can_read_teams"
on public.teams for select
to authenticated
using (true);

grant select on public.teams to authenticated;
grant select, insert, update, delete on public.teams to service_role;

create table public.leagues (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null,
  external_id text not null,
  name        text not null,
  logo_url    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index unique_league on public.leagues (provider, external_id);

create trigger leagues_set_updated_at
before update on public.leagues
for each row execute function public.set_updated_at();

alter table public.leagues enable row level security;

create policy "members_can_read_leagues"
on public.leagues for select
to authenticated
using (true);

grant select on public.leagues to authenticated;
grant select, insert, update, delete on public.leagues to service_role;
