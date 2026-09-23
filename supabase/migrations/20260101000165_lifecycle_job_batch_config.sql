-- Milestone R13.5 (§27) — grading and Challenge-resolution both had a
-- hard-coded TypeScript default-parameter batch size
-- (listPendingPredictions(limit = 200), listUnresolvedAcceptedChallenges
-- (limit = 200)), the exact same shape platform_settings.
-- settlement_batch_size (R12, 20260101000159) already replaced for
-- settlement — a purely operational throughput knob an operator might
-- reasonably want to change without a deployment, once these jobs run on
-- a schedule instead of manually. Classified consistently with that
-- established precedent, not invented fresh.
alter table public.platform_settings
  add column grading_batch_size integer not null default 200 check (grading_batch_size >= 1 and grading_batch_size <= 5000),
  add column challenge_resolution_batch_size integer not null default 200 check (challenge_resolution_batch_size >= 1 and challenge_resolution_batch_size <= 5000);

comment on column public.platform_settings.grading_batch_size is
  'Maximum number of PENDING Predictions the grading runner (lib/predictions/grading.ts runGradingJob, scripts/grade-predictions.ts, app/api/cron/grade-predictions) considers per invocation. Read live by listPendingPredictions() when no explicit limit is passed. Purely an operational batch-size knob — never affects grading correctness.';

comment on column public.platform_settings.challenge_resolution_batch_size is
  'Maximum number of ACCEPTED Call BS Challenges the resolution runner (lib/challenges/resolution.ts resolveAcceptedChallenges, scripts/resolve-challenges.ts, app/api/cron/resolve-challenges) considers per invocation. Read live by listUnresolvedAcceptedChallenges() when no explicit limit is passed. Purely an operational batch-size knob — never affects resolution correctness.';

-- Extend R12's update_operations_settings() RPC (20260101000159) with
-- these two new fields — same domain, same shape, same atomic
-- update+audit pattern, same internal is_super_admin() check R13 already
-- added (20260101000161). This is a signature change (new parameters),
-- so both the revoke/grant AND the old-signature revoke are required —
-- unlike R13.5's own Call BS/get_call_bs_record fix above, which kept an
-- identical signature.
create or replace function public.update_operations_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamptz,
  p_settlement_batch_size integer,
  p_grading_batch_size integer,
  p_challenge_resolution_batch_size integer
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
      'challengeResolutionBatchSize', v_before.challenge_resolution_batch_size
    ),
    jsonb_build_object(
      'settlementBatchSize', v_after.settlement_batch_size,
      'gradingBatchSize', v_after.grading_batch_size,
      'challengeResolutionBatchSize', v_after.challenge_resolution_batch_size
    )
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

-- Drop the old 3-arg signature — CREATE OR REPLACE cannot change a
-- function's parameter list in place; the old signature would otherwise
-- remain callable (and, per the exact root-cause mechanism documented in
-- SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md, revert to PUBLIC-execute
-- defaults) unless explicitly dropped.
drop function if exists public.update_operations_settings(uuid, timestamptz, integer);

revoke all on function public.update_operations_settings(uuid, timestamptz, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.update_operations_settings(uuid, timestamptz, integer, integer, integer) to service_role;
