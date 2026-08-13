-- Authoritative confirmed NFL result — sits upstream of grading
-- (lib/pools/templates/nfl-confirmed-result.ts), distinct from the raw,
-- live-syncing fixtures.regulation_home_score/away_score. Only a CONFIRMED
-- (or CORRECTED, its successor) row backs grading; a fixture whose
-- internal_status is COMPLETED but has no row here yet stays PENDING —
-- draft/provisional scores never settle a pool. Append-only in spirit:
-- a correction never overwrites an existing row's scores, it flips that
-- row's is_current to false (the one legal mutation, enforced below) and
-- inserts a new row, so history is never silently rewritten.
-- No FK on fixture_id, deliberately — mirrors pool_grading_evidence.pool_id
-- (see 20260101000060) so a fixture ever being hard-deleted never needs to
-- touch or is blocked by this table. The whole point of this table is that
-- its rows are permanent and outlive whatever they're about.
create table public.nfl_game_results (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null,
  home_team_external_id text,
  away_team_external_id text,
  home_final_score int not null,
  away_final_score int not null,
  status text not null check (status in ('CONFIRMED', 'CORRECTED')),
  is_current boolean not null default true,
  source text not null default 'SYNC_AUTO',
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Exactly one authoritative ("current") result per fixture at any time —
-- a correction must flip the old row's is_current to false in the same
-- transaction as inserting the new one, or this index rejects the insert.
create unique index nfl_game_results_one_current_per_fixture
  on public.nfl_game_results (fixture_id) where is_current;

create index nfl_game_results_fixture_id_idx on public.nfl_game_results (fixture_id);

alter table public.nfl_game_results enable row level security;

create policy "super_admins_read_nfl_game_results"
on public.nfl_game_results for select
to authenticated
using (public.is_super_admin(auth.uid()));

-- Writes happen exclusively through the NFL sync job (lib/sports-data/
-- sync-nfl.ts) using the service role. UPDATE is granted (unlike the fully
-- immutable pool_grading_evidence) because a correction's is_current flip
-- is a real, narrowly-permitted mutation — the trigger below is what
-- actually restricts what that UPDATE is allowed to do.
grant select on public.nfl_game_results to authenticated;
grant select, insert, update on public.nfl_game_results to service_role;

create or replace function public.nfl_game_results_guard_update()
returns trigger
language plpgsql
as $$
begin
  if old.is_current = true and new.is_current = false
    and new.id = old.id
    and new.fixture_id = old.fixture_id
    and coalesce(new.home_team_external_id, '') = coalesce(old.home_team_external_id, '')
    and coalesce(new.away_team_external_id, '') = coalesce(old.away_team_external_id, '')
    and new.home_final_score = old.home_final_score
    and new.away_final_score = old.away_final_score
    and new.status = old.status
    and new.source = old.source
    and new.confirmed_at = old.confirmed_at
    and new.created_at = old.created_at
  then
    return new;
  end if;
  raise exception 'nfl_game_results rows are append-only — the only permitted update is flipping is_current from true to false';
end;
$$;

create trigger nfl_game_results_guard_update
before update on public.nfl_game_results
for each row execute function public.nfl_game_results_guard_update();

create or replace function public.forbid_nfl_game_results_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'nfl_game_results rows can never be deleted';
end;
$$;

create trigger nfl_game_results_no_delete
before delete on public.nfl_game_results
for each row execute function public.forbid_nfl_game_results_delete();
