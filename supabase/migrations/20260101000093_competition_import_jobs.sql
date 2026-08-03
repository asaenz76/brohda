-- Resumable, chunked competition import jobs — replaces a naive "one big
-- pending_fixtures blob on the tracking row" design with a real job/chunk
-- model: each chunk is a small, independent, retryable unit of work,
-- fixed at creation time and never rewritten wholesale.
--
-- Concurrency-safety requirements this migration exists to satisfy:
--  1. At most one PENDING/RUNNING job per competition (partial unique index).
--  2. Workers claim chunks with FOR UPDATE SKIP LOCKED, flipping them to
--     RUNNING in the same transaction (claim_import_job_chunks).
--  3. Job-level counters are never incremented in place — they're always
--     recalculated from chunk state (recalculate_import_job_progress).
--  4. A chunk below its job's max_attempts stays retryable; a job only
--     becomes FAILED once some chunk exhausts its attempts, and only
--     becomes SUCCEEDED once every chunk has succeeded.

create type public.import_job_status as enum ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

create table public.competition_import_jobs (
  id                       uuid primary key default gen_random_uuid(),
  league_season_import_id  uuid not null references public.league_season_imports(id) on delete cascade,
  status                   public.import_job_status not null default 'PENDING',
  include_historical       boolean not null default false,
  total_fixtures           integer not null default 0,
  processed_fixtures       integer not null default 0,
  failed_fixtures          integer not null default 0,
  -- Per-job, not a hardcoded app constant — inspectable/auditable on the
  -- row itself; the claim/recalculate RPCs take it as a parameter rather
  -- than assuming a single global value.
  max_attempts             integer not null default 5,
  started_at               timestamptz,
  completed_at             timestamptz,
  last_error               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- Requirement 1: prevents starting a second import while one is already
-- in flight for the same competition — a raw second INSERT fails outright
-- rather than relying on application-level coordination alone.
create unique index idx_one_active_import_job_per_competition
  on public.competition_import_jobs (league_season_import_id)
  where status in ('PENDING', 'RUNNING');

create index idx_import_jobs_league_season_import on public.competition_import_jobs (league_season_import_id);

create trigger competition_import_jobs_set_updated_at
before update on public.competition_import_jobs
for each row execute function public.set_updated_at();

create table public.competition_import_job_chunks (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references public.competition_import_jobs(id) on delete cascade,
  chunk_index       integer not null,
  -- This chunk's NormalizedFixture[] only (bounded by both fixture count
  -- and serialized byte size at creation — see lib/sports-data/import-chunks.ts),
  -- fixed once and never rewritten. Cleared to null by the retention
  -- cleanup once SUCCEEDED and past its recovery window — null here does
  -- NOT mean "not yet fetched," only "already processed and reclaimed."
  fixtures_payload  jsonb,
  fixture_count     integer not null,
  payload_bytes     integer not null,
  status            public.import_job_status not null default 'PENDING',
  attempt_count     integer not null default 0,
  last_error        text,
  processed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (job_id, chunk_index)
);

-- Requirement 7: leads with status (not job_id) since the cron scans for
-- processable chunks ACROSS every job, not within one job at a time.
create index idx_import_job_chunks_processable
  on public.competition_import_job_chunks (status, job_id, chunk_index)
  where status in ('PENDING', 'FAILED');

create trigger competition_import_job_chunks_set_updated_at
before update on public.competition_import_job_chunks
for each row execute function public.set_updated_at();

-- Requirement 2: atomically claims up to p_limit processable chunks
-- (PENDING, or FAILED with attempts remaining) across every job, locking
-- each claimed row so a concurrent cron invocation skips it rather than
-- double-processing it, and flips it to RUNNING in the same statement.
create or replace function public.claim_import_job_chunks(p_limit integer, p_max_attempts integer)
returns setof public.competition_import_job_chunks
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with claimed as (
    select c.id
    from public.competition_import_job_chunks c
    where c.status in ('PENDING', 'FAILED')
      and c.attempt_count < p_max_attempts
    order by c.job_id, c.chunk_index
    for update skip locked
    limit p_limit
  )
  update public.competition_import_job_chunks c
  set status = 'RUNNING',
      attempt_count = c.attempt_count + 1
  from claimed
  where c.id = claimed.id
  returning c.*;
end;
$$;

-- Requirement 3 + 4: the only place job.status/processed_fixtures/
-- failed_fixtures are ever written — always recomputed from the current
-- chunk states, never incremented in place. A chunk counts as
-- "permanently failed" only once it has exhausted p_max_attempts; while
-- attempts remain, a FAILED chunk is still "pending_or_retryable" and the
-- job stays RUNNING.
create or replace function public.recalculate_import_job_progress(p_job_id uuid, p_max_attempts integer)
returns public.competition_import_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_succeeded integer;
  v_exhausted_failed_fixtures integer;
  v_has_exhausted_chunk boolean;
  v_pending_or_retryable integer;
  v_job public.competition_import_jobs;
begin
  select coalesce(sum(fixture_count), 0) into v_succeeded
  from public.competition_import_job_chunks
  where job_id = p_job_id and status = 'SUCCEEDED';

  -- Two separate signals, deliberately not one: the fixture-count SUM is
  -- purely a display counter (failed_fixtures) and must never double as
  -- the "is this job exhausted" boolean — a chunk can validly have
  -- fixture_count = 0 (e.g. a discovery pass that staged no fixtures),
  -- and summing to 0 must not be mistaken for "nothing exhausted."
  select coalesce(sum(fixture_count), 0) into v_exhausted_failed_fixtures
  from public.competition_import_job_chunks
  where job_id = p_job_id and status = 'FAILED' and attempt_count >= p_max_attempts;

  select exists(
    select 1 from public.competition_import_job_chunks
    where job_id = p_job_id and status = 'FAILED' and attempt_count >= p_max_attempts
  ) into v_has_exhausted_chunk;

  select count(*) into v_pending_or_retryable
  from public.competition_import_job_chunks
  where job_id = p_job_id
    and status <> 'SUCCEEDED'
    and not (status = 'FAILED' and attempt_count >= p_max_attempts);

  update public.competition_import_jobs
  set
    processed_fixtures = v_succeeded,
    failed_fixtures = v_exhausted_failed_fixtures,
    -- Explicit cast required: plpgsql resolves a CASE expression's
    -- untyped string literals to `text` by default, which then fails to
    -- assign into an enum column ("column is of type import_job_status
    -- but expression is of type text") unless cast back explicitly.
    status = (case
      when v_has_exhausted_chunk then 'FAILED'
      when v_pending_or_retryable = 0 then 'SUCCEEDED'
      else 'RUNNING'
    end)::public.import_job_status,
    completed_at = case
      when v_has_exhausted_chunk or v_pending_or_retryable = 0 then coalesce(completed_at, now())
      else completed_at
    end
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$$;

-- Requirement 6: reclaims the (potentially sizeable) per-chunk fixture
-- payload once a chunk has been successfully processed and sat past its
-- recovery window — job/chunk metadata (status, counts, timestamps,
-- errors) is kept indefinitely; only the heavy jsonb blob is cleared.
create or replace function public.cleanup_import_job_chunk_payloads(p_recovery_window interval)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.competition_import_job_chunks
  set fixtures_payload = null
  where status = 'SUCCEEDED'
    and processed_at is not null
    and processed_at < now() - p_recovery_window
    and fixtures_payload is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter table public.competition_import_jobs enable row level security;
create policy "members_can_read_competition_import_jobs"
on public.competition_import_jobs for select to authenticated using (true);
grant select on public.competition_import_jobs to authenticated;
grant select, insert, update, delete on public.competition_import_jobs to service_role;

alter table public.competition_import_job_chunks enable row level security;
create policy "members_can_read_competition_import_job_chunks"
on public.competition_import_job_chunks for select to authenticated using (true);
grant select on public.competition_import_job_chunks to authenticated;
grant select, insert, update, delete on public.competition_import_job_chunks to service_role;

-- SECURITY DEFINER functions need an explicit EXECUTE grant, same as this
-- repo's other privileged RPCs (e.g. apply_wallet_transaction) — only the
-- service-role cron/action path ever calls these.
grant execute on function public.claim_import_job_chunks(integer, integer) to service_role;
grant execute on function public.recalculate_import_job_progress(uuid, integer) to service_role;
grant execute on function public.cleanup_import_job_chunk_payloads(interval) to service_role;
