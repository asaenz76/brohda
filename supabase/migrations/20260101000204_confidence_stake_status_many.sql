-- Feed parity for Confidence-backed Picks: the Home timeline shows the same Confidence control as the Post detail, so it needs the same per-Pick answer for many Picks at once without a query per card.
-- This is the SAME decision as confidence_stake_status (it calls it for each Pick), so the feed and the detail can never disagree about eligibility, the ladder, the available balance or an existing commitment.
-- Additive and read-only: no table, column or policy changes. Service role only, like every other Confidence function the application calls.
create or replace function public.confidence_stake_status_many(p_member_id uuid, p_prediction_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_result jsonb := '{}'::jsonb;
begin
  if p_prediction_ids is null then return v_result; end if;
  foreach v_id in array p_prediction_ids loop
    v_result := v_result || jsonb_build_object(v_id::text, public.confidence_stake_status(p_member_id, v_id));
  end loop;
  return v_result;
end;
$$;
revoke all on function public.confidence_stake_status_many(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.confidence_stake_status_many(uuid, uuid[]) to service_role;
