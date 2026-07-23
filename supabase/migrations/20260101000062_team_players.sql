-- Squad-list cache for the "Player to score" template's player picker
-- (app/(admin)/admin/pools/new/player-picker.tsx via
-- lib/actions/squads.ts's getTeamSquadAction). Populated lazily, on
-- demand, from API-Football's /players/squads endpoint — not by the cron,
-- since it's only ever needed at pool-creation time, not grading time.
create table public.team_players (
  id uuid primary key default gen_random_uuid(),
  team_external_id text not null,
  external_player_id text not null,
  name text not null,
  position text,
  jersey_number integer,
  synced_at timestamptz not null default now(),
  unique (team_external_id, external_player_id)
);

create index team_players_team_external_id_idx on public.team_players (team_external_id);

alter table public.team_players enable row level security;

create policy "authenticated_read_team_players"
on public.team_players for select
to authenticated
using (true);

grant select on public.team_players to authenticated;
grant select, insert, update on public.team_players to service_role;
