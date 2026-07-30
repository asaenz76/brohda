-- Follow-teams/leagues feature: per-user follow relationships to teams.id
-- and leagues.id, each with its own independent email-notification switch
-- (default on when you follow — same "opt-out, not opt-in" philosophy as
-- 20260101000075's now-superseded global toggle). Unlike public.follows
-- (a cross-user, privacy-sensitive social graph with no direct grant to
-- authenticated at all), this is purely the current user's own private
-- preference data — nobody else needs to see or hide it, so a plain
-- own-row RLS policy with a real grant is the right shape, not a
-- SECURITY DEFINER RPC-only read path.

create table public.team_follows (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.user_profiles (id) on delete cascade,
  team_id       uuid not null references public.teams (id) on delete cascade,
  email_enabled boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Idempotent toggle via unique index on the natural key, same pattern as
-- unique_follow — a repeat INSERT hits 23505, the server action treats
-- that as success rather than an error.
create unique index unique_team_follow on public.team_follows (user_id, team_id);
create index team_follows_user_idx on public.team_follows (user_id);
create index team_follows_team_idx on public.team_follows (team_id);

alter table public.team_follows enable row level security;

create policy "select_own_team_follows"
on public.team_follows for select
to authenticated
using (user_id = auth.uid());

create policy "update_own_team_follow_email"
on public.team_follows for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- The RLS policy alone isn't enough (Phase 2 lesson, restated in
-- 20260101000008): the base privilege has to be granted too. No
-- insert/delete grant to authenticated at all — the follow/unfollow
-- toggle only ever happens through lib/actions/team-follows.ts via the
-- service role, same as public.follows.
grant select on public.team_follows to authenticated;
grant update (email_enabled) on public.team_follows to authenticated;
grant select, insert, update, delete on public.team_follows to service_role;

create table public.league_follows (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.user_profiles (id) on delete cascade,
  league_id     uuid not null references public.leagues (id) on delete cascade,
  email_enabled boolean not null default true,
  created_at    timestamptz not null default now()
);

create unique index unique_league_follow on public.league_follows (user_id, league_id);
create index league_follows_user_idx on public.league_follows (user_id);
create index league_follows_league_idx on public.league_follows (league_id);

alter table public.league_follows enable row level security;

create policy "select_own_league_follows"
on public.league_follows for select
to authenticated
using (user_id = auth.uid());

create policy "update_own_league_follow_email"
on public.league_follows for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

grant select on public.league_follows to authenticated;
grant update (email_enabled) on public.league_follows to authenticated;
grant select, insert, update, delete on public.league_follows to service_role;
