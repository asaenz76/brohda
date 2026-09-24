-- Milestone R13.9 — R13.8's own production audit found two concrete gaps:
-- (1) background_jobs.status can only ever be 'success' or 'error', so a
-- job that completes without throwing but leaves per-item failures (e.g.
-- grading.ts's `failures: [...]`) or a financial invariant_violation
-- (settlement-runner.ts) is recorded identically to a fully clean run —
-- operationally indistinguishable. (2) the admin dashboard's job list was
-- a hard-coded 3-entry array (lib/reports/fetch.ts's old KNOWN_JOBS) that
-- had already drifted from reality (it named "sync-fixtures", but the
-- real job_name recorded by app/api/cron/sync-fixtures-nfl/route.ts is
-- "sync-fixtures-nfl" — that job's health has silently shown "never run"
-- ever since it was renamed). This migration only fixes (1); (2) is a
-- pure application-layer fix (lib/jobs/registry.ts) needing no schema
-- change.
--
-- Widening a CHECK constraint is additive/backward-compatible: every
-- existing 'success'/'error' row and every legacy job that never adopts
-- 'degraded' remain exactly as valid as before.
alter table public.background_jobs
  drop constraint background_jobs_status_check,
  add constraint background_jobs_status_check check (status in ('success', 'error', 'degraded'));

comment on column public.background_jobs.status is
  'success: fn() completed with no per-item failures. degraded: fn() completed without throwing, but its own result reported at least one per-item failure or financial invariant_violation (see lib/jobs/record.ts''s isDegradedResult) — the run itself did not crash, but needs operator attention. error: fn() threw.';

-- job_staleness_multiplier: R13.9's admin Job Health view needs a
-- principled way to decide when a job that HAS been running is now
-- overdue, rather than a hard-coded threshold buried in a UI component.
-- Each job already declares its own expected cadence in the new static
-- lib/jobs/registry.ts (a technical/architectural fact — how often this
-- job is *meant* to be scheduled — not something an operator tunes per
-- job). What operators genuinely may want to adjust is how much slack to
-- give before calling a job "stale" (e.g. a temporary provider blip
-- shouldn't immediately read as an incident) — one global multiplier
-- applied to every job's own expected cadence, following the exact same
-- "operationally mutable, not per-job" classification already used for
-- settlement_batch_size/grading_batch_size/challenge_resolution_batch_size.
-- One knob, not ten — avoids inventing a per-job settings row for a
-- single tunable number.
alter table public.platform_settings
  add column job_staleness_multiplier integer not null default 3 check (job_staleness_multiplier >= 1 and job_staleness_multiplier <= 20);

comment on column public.platform_settings.job_staleness_multiplier is
  'A lifecycle job is considered STALE in the admin Job Health view when no run has completed within (its own expected cadence, from lib/jobs/registry.ts) * this multiplier. Purely an operational alerting-sensitivity knob — never affects any job''s own scheduling or correctness.';

-- Extend R13.5's update_operations_settings() (20260101000165) with this
-- one new field — same domain, same shape, same atomic update+audit
-- pattern, same internal is_super_admin() check. Signature change, so
-- both the revoke/grant AND the old-signature revoke are required.
create or replace function public.update_operations_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamptz,
  p_settlement_batch_size integer,
  p_grading_batch_size integer,
  p_challenge_resolution_batch_size integer,
  p_job_staleness_multiplier integer
)
returns public.admin_settings_update_result
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.platform_settings;
  v_after public.platform_settings;
begin
  if not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

  select * into v_before from public.platform_settings where id = true for update;
  if v_before.updated_at <> p_expected_updated_at then
    return (v_before, 'conflict')::public.admin_settings_update_result;
  end if;

  update public.platform_settings set
    settlement_batch_size = p_settlement_batch_size,
    grading_batch_size = p_grading_batch_size,
    challenge_resolution_batch_size = p_challenge_resolution_batch_size,
    job_staleness_multiplier = p_job_staleness_multiplier,
    updated_at = now(),
    updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (
    p_admin_id, 'settings.operations_updated', 'platform_settings', null,
    jsonb_build_object(
      'settlementBatchSize', v_before.settlement_batch_size,
      'gradingBatchSize', v_before.grading_batch_size,
      'challengeResolutionBatchSize', v_before.challenge_resolution_batch_size,
      'jobStalenessMultiplier', v_before.job_staleness_multiplier
    ),
    jsonb_build_object(
      'settlementBatchSize', v_after.settlement_batch_size,
      'gradingBatchSize', v_after.grading_batch_size,
      'challengeResolutionBatchSize', v_after.challenge_resolution_batch_size,
      'jobStalenessMultiplier', v_after.job_staleness_multiplier
    )
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

-- Drop the old 5-arg signature — CREATE OR REPLACE cannot change a
-- function's parameter list in place; the old signature would otherwise
-- remain callable (and, per the exact root-cause mechanism documented in
-- SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md, revert to PUBLIC-execute
-- defaults) unless explicitly dropped.
drop function if exists public.update_operations_settings(uuid, timestamptz, integer, integer, integer);

revoke all on function public.update_operations_settings(uuid, timestamptz, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.update_operations_settings(uuid, timestamptz, integer, integer, integer, integer) to service_role;
