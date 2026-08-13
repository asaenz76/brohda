-- Cron overlap guard: background_jobs (20260101000011_reversal_and_reporting.sql)
-- has no in-progress row state at all — every row is inserted complete,
-- after the fact (status not null check (status in ('success','error')),
-- finished_at/duration_ms not null, service_role only has select+insert,
-- no update). It's a clean audit trail of completed runs, deliberately not
-- weakened here to also model "still running" — that's a different concern,
-- given its own dedicated table.
--
-- Real motivating incident (see SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md's
-- root-cause section): sync-fixtures once took 4-5 minutes per run but
-- fired every 1 minute with no overlap guard, so concurrent runs stacked
-- up and multiplied API-Football's request volume roughly 20x at its
-- worst. This migration adds the missing primitive so both the existing
-- sync-fixtures job and the new NFL sync job can't repeat that failure
-- mode — retrofitted onto lib/jobs/record.ts's shared recordJobRun, not
-- duplicated per cron route.

create table public.cron_job_locks (
  job_name text primary key,
  locked_until timestamptz not null
);

alter table public.cron_job_locks enable row level security;

-- No policy needed for authenticated/anon — nothing outside service_role
-- ever needs to read or write this table, matching background_jobs'/
-- provider_request_log's own "operational, not player-facing" posture.
revoke all on public.cron_job_locks from public, anon, authenticated;
grant select, insert, update on public.cron_job_locks to service_role;

-- Atomic acquire: a single INSERT ... ON CONFLICT ... DO UPDATE ... WHERE
-- is the correct primitive here (not two round trips of "check, then
-- write," which would race) — Postgres row-locks the conflicting row for
-- the duration of the statement, so two concurrent callers can never both
-- see the WHERE condition pass. Returns true only if this call actually
-- acquired the lock (no prior row, or the prior lock already expired);
-- false means another invocation currently holds it — the caller should
-- skip this tick rather than run.
create or replace function public.try_acquire_cron_lock(p_job_name text, p_ttl_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acquired boolean;
begin
  insert into public.cron_job_locks (job_name, locked_until)
  values (p_job_name, now() + make_interval(secs => p_ttl_seconds))
  on conflict (job_name) do update
    set locked_until = excluded.locked_until
    where public.cron_job_locks.locked_until < now()
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

revoke all on function public.try_acquire_cron_lock(text, integer) from public, anon, authenticated;
grant execute on function public.try_acquire_cron_lock(text, integer) to service_role;

-- Releases early on a normal completion (success or error), so the next
-- scheduled tick doesn't have to wait out the full TTL. If a run crashes
-- hard enough to skip even the release (e.g. the whole process is killed),
-- the TTL alone still self-heals — no lock is ever stuck forever.
create or replace function public.release_cron_lock(p_job_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.cron_job_locks set locked_until = now() where job_name = p_job_name;
end;
$$;

revoke all on function public.release_cron_lock(text) from public, anon, authenticated;
grant execute on function public.release_cron_lock(text) to service_role;
