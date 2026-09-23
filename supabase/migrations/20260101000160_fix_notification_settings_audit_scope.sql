-- Milestone R12 fix: update_notification_settings()'s audit before/after
-- was accidentally written as `to_jsonb(v_before) - 'id' - 'updated_at' -
-- 'updated_by'`, capturing the ENTIRE platform_settings row (every other
-- domain's live values too) instead of just the Notifications domain's own
-- 10 fields — the one function in this milestone that didn't follow the
-- explicit jsonb_build_object(...) scoping every other update_*_settings
-- RPC uses (see 20260101000159_admin_brohda_settings.sql). Caught by
-- tests/integration/admin-brohda-settings.test.ts's own audit-scoping
-- assertion. Re-defined here rather than editing the already-applied
-- migration file, matching this project's own established convention
-- (e.g. 20260101000157_p2p_settlement.sql re-defining accept_monetary_
-- proposal() rather than editing 20260101000156's copy). No column,
-- grant, or business logic changes — only the audit JSON shape.
create or replace function public.update_notification_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamptz,
  p_prediction_notifications_enabled boolean,
  p_prediction_notify_on_correct boolean,
  p_prediction_notify_on_incorrect boolean,
  p_prediction_notify_on_void boolean,
  p_prediction_notify_title_correct text,
  p_prediction_notify_body_correct text,
  p_prediction_notify_title_incorrect text,
  p_prediction_notify_body_incorrect text,
  p_prediction_notify_title_void text,
  p_prediction_notify_body_void text
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
  select * into v_before from public.platform_settings where id = true for update;
  if v_before.updated_at <> p_expected_updated_at then
    return (v_before, 'conflict')::public.admin_settings_update_result;
  end if;

  update public.platform_settings set
    prediction_notifications_enabled = p_prediction_notifications_enabled,
    prediction_notify_on_correct = p_prediction_notify_on_correct,
    prediction_notify_on_incorrect = p_prediction_notify_on_incorrect,
    prediction_notify_on_void = p_prediction_notify_on_void,
    prediction_notify_title_correct = p_prediction_notify_title_correct,
    prediction_notify_body_correct = p_prediction_notify_body_correct,
    prediction_notify_title_incorrect = p_prediction_notify_title_incorrect,
    prediction_notify_body_incorrect = p_prediction_notify_body_incorrect,
    prediction_notify_title_void = p_prediction_notify_title_void,
    prediction_notify_body_void = p_prediction_notify_body_void,
    updated_at = now(),
    updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (
    p_admin_id, 'settings.notifications_updated', 'platform_settings', null,
    jsonb_build_object(
      'predictionNotificationsEnabled', v_before.prediction_notifications_enabled,
      'predictionNotifyOnCorrect', v_before.prediction_notify_on_correct,
      'predictionNotifyOnIncorrect', v_before.prediction_notify_on_incorrect,
      'predictionNotifyOnVoid', v_before.prediction_notify_on_void,
      'predictionNotifyTitleCorrect', v_before.prediction_notify_title_correct,
      'predictionNotifyBodyCorrect', v_before.prediction_notify_body_correct,
      'predictionNotifyTitleIncorrect', v_before.prediction_notify_title_incorrect,
      'predictionNotifyBodyIncorrect', v_before.prediction_notify_body_incorrect,
      'predictionNotifyTitleVoid', v_before.prediction_notify_title_void,
      'predictionNotifyBodyVoid', v_before.prediction_notify_body_void
    ),
    jsonb_build_object(
      'predictionNotificationsEnabled', v_after.prediction_notifications_enabled,
      'predictionNotifyOnCorrect', v_after.prediction_notify_on_correct,
      'predictionNotifyOnIncorrect', v_after.prediction_notify_on_incorrect,
      'predictionNotifyOnVoid', v_after.prediction_notify_on_void,
      'predictionNotifyTitleCorrect', v_after.prediction_notify_title_correct,
      'predictionNotifyBodyCorrect', v_after.prediction_notify_body_correct,
      'predictionNotifyTitleIncorrect', v_after.prediction_notify_title_incorrect,
      'predictionNotifyBodyIncorrect', v_after.prediction_notify_body_incorrect,
      'predictionNotifyTitleVoid', v_after.prediction_notify_title_void,
      'predictionNotifyBodyVoid', v_after.prediction_notify_body_void
    )
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

revoke all on function public.update_notification_settings(uuid, timestamptz, boolean, boolean, boolean, boolean, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.update_notification_settings(uuid, timestamptz, boolean, boolean, boolean, boolean, text, text, text, text, text, text) to service_role;
