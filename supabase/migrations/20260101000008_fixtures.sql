-- Phase 3: fixtures (spec §9.3 field list, provided directly by the user)
-- and provider_request_log (§18: "optional cache/debug", needed now for
-- the caching/backoff requirement).

create type public.fixture_internal_status as enum (
  'NOT_STARTED',
  'LIVE',
  'HALFTIME',
  'EXTRA_TIME',
  'PENALTIES',
  'COMPLETED',
  'POSTPONED',
  'SUSPENDED',
  'ABANDONED',
  'CANCELLED',
  'AWARDED',
  'UNKNOWN'
);

create table public.fixtures (
  -- Identity
  id                          uuid primary key default gen_random_uuid(),
  provider                    text not null default 'api_football',
  external_fixture_id         text not null,

  -- Sport and competition
  sport                       text not null default 'football',
  competition_external_id     text,
  competition_name            text,
  season                      text,
  round                       text,

  -- Teams
  home_team_external_id       text,
  home_team_name              text not null,
  home_team_logo_url          text,
  away_team_external_id       text,
  away_team_name              text not null,
  away_team_logo_url          text,

  -- Venue
  venue_name                  text,
  venue_city                  text,
  -- [v1.1] REQUIRED by Appendix X.7.2 (same-calendar-day void rule).
  -- API-Football returns venue city, not tz. Resolved city -> IANA tz at
  -- import (lib/sports-data/timezone.ts); on failure falls back to a
  -- competition default, then DEFAULT_TIMEZONE (America/Costa_Rica). Which
  -- source was used gets recorded in the void snapshot once that mechanism
  -- exists (Phase 4/5) — not a column here.
  venue_timezone               text,

  -- Scheduling
  scheduled_start_utc         timestamptz not null,
  provider_timezone           text,

  -- Status
  provider_status_code        text,
  provider_status_description text,
  -- [v1.1] normalized by ApiFootballProvider (lib/sports-data/status-map.ts).
  -- Application logic reads ONLY this column, never the raw code.
  internal_status              public.fixture_internal_status not null default 'NOT_STARTED',
  elapsed_minutes              integer,

  -- Scores. Nullable: absence is meaningful and must not be coerced to 0.
  home_score                   integer,
  away_score                   integer,
  halftime_home_score          integer,
  halftime_away_score          integer,
  -- 90 min + stoppage ONLY. Maps to API-Football score.fulltime, which
  -- remains the 90-minute score even when ET is played. Required by §16.3.
  regulation_home_score        integer,
  regulation_away_score        integer,
  extra_time_home_score        integer,
  extra_time_away_score        integer,
  penalty_home_score           integer,
  penalty_away_score           integer,

  -- Provenance
  provider_payload             jsonb,
  last_synced_at               timestamptz,
  sync_error                   text,

  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  constraint fixtures_provider_external_unique unique (provider, external_fixture_id)
);

create index idx_fixtures_scheduled_start on public.fixtures (scheduled_start_utc);
create index idx_fixtures_internal_status on public.fixtures (internal_status);
create index idx_fixtures_sync_window on public.fixtures (internal_status, scheduled_start_utc);

create trigger fixtures_set_updated_at
before update on public.fixtures
for each row execute function public.set_updated_at();

alter table public.fixtures enable row level security;

-- Fixtures are non-sensitive reference data: readable by any authenticated
-- member. All writes happen server-side (import action + sync job) via the
-- service role.
create policy "members_can_read_fixtures"
on public.fixtures for select
to authenticated
using (true);

-- The RLS policy alone isn't enough (Phase 2 lesson): the base privilege
-- has to be granted too.
grant select on public.fixtures to authenticated;
grant select, insert, update, delete on public.fixtures to service_role;

create table public.provider_request_log (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null,
  request_type      text not null,
  request_params    jsonb,
  response_status   integer,
  response_snippet  text,
  error             text,
  duration_ms       integer,
  created_at        timestamptz not null default now()
);

create index idx_provider_request_log_created_at on public.provider_request_log (created_at desc);

alter table public.provider_request_log enable row level security;

create policy "admins_read_provider_request_log"
on public.provider_request_log for select
to authenticated
using (public.is_super_admin(auth.uid()));

grant select on public.provider_request_log to authenticated;
grant select, insert on public.provider_request_log to service_role;
