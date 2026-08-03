-- Competition import tracking: whether a specific (league, season) has been
-- imported into PollPools, independent of individual fixture rows. See
-- docs discussion "Competition Workspace" — this table backs the admin
-- /admin/competitions manager and the pool-creation league filter.
--
-- Deliberately does NOT track "not imported" as a stored value — that's
-- simply the absence of a row for a given (provider, external_league_id,
-- season). A failed import still gets a row (import_status = IMPORT_FAILED)
-- so it lands in "Needs attention," not back in "Recommended."
--
-- Operational status (Prepared/Active/No upcoming fixtures/Completed) is
-- intentionally NOT stored here — it's computed at read time against the
-- fixtures table (a fixture crossing the activation-window line changes
-- daily with no write to this table to catch it). Only the durable import/
-- sync lifecycle and season metadata snapshot are stored.

create type public.competition_import_status as enum ('IMPORTING', 'IMPORTED', 'IMPORT_FAILED');
create type public.competition_sync_status as enum ('IDLE', 'SYNCING', 'STALE', 'FAILED');

create table public.league_season_imports (
  id                         uuid primary key default gen_random_uuid(),
  provider                   text not null default 'api_football',
  external_league_id         text not null,
  -- Exact provider value (e.g. "2025" for a cross-year season) — never
  -- reformatted here; display formatting ("2025/26") happens in the UI.
  season                     text not null,
  league_id                  uuid not null references public.leagues(id),

  -- Season metadata snapshot, from NormalizedLeague.seasons[] at
  -- import/discovery time — season_end_date is what makes "Completed"
  -- computable; without it a season with simply no next-round fixtures
  -- scheduled yet would look identical to a truly finished one.
  season_start_date          date,
  season_end_date            date,
  provider_current           boolean not null default false,

  -- Raw API-Football league-season coverage object, stored verbatim
  -- (jsonb passthrough — exact shape confirmed via a live call before the
  -- Templates tab reads it) — informational for now, not yet enforced
  -- against template availability.
  coverage_snapshot          jsonb,
  coverage_checked_at        timestamptz,

  -- Import lifecycle summary — kept in sync with the latest
  -- competition_import_jobs row by the chunk-processing cron (see
  -- 20260101000093), denormalized here for cheap list-page filtering.
  import_status              public.competition_import_status not null default 'IMPORTING',
  imported_at                 timestamptz,

  -- Discovery-sync lifecycle (a separate, lighter-weight concern from the
  -- one-time import job below — see the discover-competitions cron).
  sync_status                  public.competition_sync_status not null default 'IDLE',
  last_synced_at                timestamptz,
  last_sync_error                text,
  last_fixture_discovery_at       timestamptz,
  latest_provider_fixture_at       timestamptz,

  -- Fixture counts — periodic snapshots for row display and the
  -- Needs-Attention "incomplete import" check, never the source of truth
  -- for Active/Prepared classification (that's always a live fixtures
  -- query against the activation window).
  fixture_count_imported        integer not null default 0,
  upcoming_fixture_count        integer not null default 0,
  completed_fixture_count       integer not null default 0,
  provider_fixture_count        integer,

  -- Pool-creation eligibility — independent of import/archive lifecycle;
  -- an admin can pull a healthy, active competition out of the pool
  -- creator without archiving it.
  pool_creation_enabled          boolean not null default true,

  is_active                       boolean not null default true,
  archived_at                      timestamptz,

  created_at                       timestamptz not null default now(),
  updated_at                        timestamptz not null default now(),

  unique (provider, external_league_id, season),
  unique (league_id, season)
);

create index idx_league_season_imports_status on public.league_season_imports (import_status, is_active);
create index idx_league_season_imports_league on public.league_season_imports (league_id);

create trigger league_season_imports_set_updated_at
before update on public.league_season_imports
for each row execute function public.set_updated_at();

alter table public.league_season_imports enable row level security;

-- Same pattern as leagues/fixtures/teams: broad authenticated read, admin
-- gating enforced at the server-action layer (requireAdminOrAbove), not
-- RLS. Remember the grant — RLS policies alone don't grant table access.
create policy "members_can_read_league_season_imports"
on public.league_season_imports for select
to authenticated
using (true);

grant select on public.league_season_imports to authenticated;
grant select, insert, update, delete on public.league_season_imports to service_role;
