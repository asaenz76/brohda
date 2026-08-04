-- Backs the date-first fixture discovery workflow's provider-search cache
-- (app/(admin)/admin/fixtures, mode=date — see lib/fixtures/cache.ts).
-- Deliberately DB-backed, not in-memory: this app runs on ephemeral
-- serverless functions, so an in-memory cache would rarely survive
-- between requests. competition_external_id uses an empty-string
-- sentinel rather than NULL for "no competition filter" so the unique
-- constraint actually dedupes repeat searches — Postgres treats NULL as
-- distinct from NULL for uniqueness purposes, which would otherwise let
-- every "no filter" search accumulate its own row instead of reusing one.

create table public.fixture_date_search_cache (
  id                      uuid primary key default gen_random_uuid(),
  provider                text not null default 'api_football',
  time_zone               text not null,
  utc_from                timestamptz not null,
  utc_to                  timestamptz not null,
  competition_external_id text not null default '',
  results                 jsonb not null,
  fixture_count           integer not null,
  fetched_at              timestamptz not null default now(),
  expires_at              timestamptz not null,
  unique (provider, time_zone, utc_from, utc_to, competition_external_id)
);

create index idx_fixture_date_search_cache_expires on public.fixture_date_search_cache (expires_at);

alter table public.fixture_date_search_cache enable row level security;

create policy "members_can_read_fixture_date_search_cache"
on public.fixture_date_search_cache for select to authenticated using (true);

grant select on public.fixture_date_search_cache to authenticated;
grant select, insert, update, delete on public.fixture_date_search_cache to service_role;
