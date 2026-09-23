-- Milestone R13 remediation: adds a defense-in-depth `is_super_admin(p_admin_id)`
-- check inside all 9 `update_*_settings()` RPCs from R12
-- (20260101000159/20260101000160), mirroring the exact pattern
-- `reverse_pool_settlement()` already uses (20260101000155). Before this
-- migration, authorization for these 9 financial/product-policy RPCs
-- rested ENTIRELY on the Postgres EXECUTE grant being scoped to
-- `service_role` plus the calling Server Action's own `requireSuperAdmin()`
-- gate — with no internal check inside the function body itself. Given
-- this project has already suffered two real, documented incidents of
-- exactly this class (SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md — a
-- production-wide anon+authenticated EXECUTE grant drift; and
-- 20260101000134_free_mode_rpc_grant_remediation.sql, a second grant-drift
-- fix), relying solely on the grant for these specific 9 functions is a
-- real, if currently dormant, gap: if EXECUTE were ever accidentally
-- widened to `authenticated` (the exact failure mode already proven
-- possible twice), any authenticated user could call e.g.
-- update_monetary_settings with an arbitrary p_admin_id and flip
-- monetary_p2p_enabled/p2p_fee_bps. This migration closes that gap the
-- same way reverse_pool_settlement() already does for a sibling
-- financial-admin RPC — no other behavior changes.
--
-- No grant changes here (still service_role-only); no column changes; no
-- audit-log shape changes. Function bodies are otherwise byte-for-byte
-- identical to their current definitions (20260101000159, with
-- update_notification_settings using the already-corrected
-- 20260101000160 body).

create or replace function public.update_prediction_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamptz,
  p_pick_lock_minutes_before_kickoff integer,
  p_prediction_cutoff_minutes_before_close integer,
  p_prediction_allow_repeat boolean,
  p_prediction_allow_stale_price boolean,
  p_prediction_allow_unavailable_price boolean,
  p_prediction_allow_closed_market boolean
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
    pick_lock_minutes_before_kickoff = p_pick_lock_minutes_before_kickoff,
    prediction_cutoff_minutes_before_close = p_prediction_cutoff_minutes_before_close,
    prediction_allow_repeat = p_prediction_allow_repeat,
    prediction_allow_stale_price = p_prediction_allow_stale_price,
    prediction_allow_unavailable_price = p_prediction_allow_unavailable_price,
    prediction_allow_closed_market = p_prediction_allow_closed_market,
    updated_at = now(),
    updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (
    p_admin_id, 'settings.predictions_updated', 'platform_settings', null,
    jsonb_build_object(
      'pickLockMinutesBeforeKickoff', v_before.pick_lock_minutes_before_kickoff,
      'predictionCutoffMinutesBeforeClose', v_before.prediction_cutoff_minutes_before_close,
      'predictionAllowRepeat', v_before.prediction_allow_repeat,
      'predictionAllowStalePrice', v_before.prediction_allow_stale_price,
      'predictionAllowUnavailablePrice', v_before.prediction_allow_unavailable_price,
      'predictionAllowClosedMarket', v_before.prediction_allow_closed_market
    ),
    jsonb_build_object(
      'pickLockMinutesBeforeKickoff', v_after.pick_lock_minutes_before_kickoff,
      'predictionCutoffMinutesBeforeClose', v_after.prediction_cutoff_minutes_before_close,
      'predictionAllowRepeat', v_after.prediction_allow_repeat,
      'predictionAllowStalePrice', v_after.prediction_allow_stale_price,
      'predictionAllowUnavailablePrice', v_after.prediction_allow_unavailable_price,
      'predictionAllowClosedMarket', v_after.prediction_allow_closed_market
    )
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

revoke all on function public.update_prediction_settings(uuid, timestamptz, integer, integer, boolean, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.update_prediction_settings(uuid, timestamptz, integer, integer, boolean, boolean, boolean, boolean) to service_role;

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
  if not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

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

create or replace function public.update_market_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamptz,
  p_market_ingestion_enabled boolean,
  p_market_ingestion_min_bookmaker_count integer,
  p_post_publication_enabled boolean,
  p_post_publication_requires_active_market boolean
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
    market_ingestion_enabled = p_market_ingestion_enabled,
    market_ingestion_min_bookmaker_count = p_market_ingestion_min_bookmaker_count,
    post_publication_enabled = p_post_publication_enabled,
    post_publication_requires_active_market = p_post_publication_requires_active_market,
    updated_at = now(),
    updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (
    p_admin_id, 'settings.markets_updated', 'platform_settings', null,
    jsonb_build_object(
      'marketIngestionEnabled', v_before.market_ingestion_enabled,
      'marketIngestionMinBookmakerCount', v_before.market_ingestion_min_bookmaker_count,
      'postPublicationEnabled', v_before.post_publication_enabled,
      'postPublicationRequiresActiveMarket', v_before.post_publication_requires_active_market
    ),
    jsonb_build_object(
      'marketIngestionEnabled', v_after.market_ingestion_enabled,
      'marketIngestionMinBookmakerCount', v_after.market_ingestion_min_bookmaker_count,
      'postPublicationEnabled', v_after.post_publication_enabled,
      'postPublicationRequiresActiveMarket', v_after.post_publication_requires_active_market
    )
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

revoke all on function public.update_market_settings(uuid, timestamptz, boolean, integer, boolean, boolean) from public, anon, authenticated;
grant execute on function public.update_market_settings(uuid, timestamptz, boolean, integer, boolean, boolean) to service_role;

create or replace function public.update_community_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamptz,
  p_community_distribution_enabled boolean,
  p_community_team_distribution_enabled boolean,
  p_community_league_distribution_enabled boolean,
  p_community_sport_distribution_enabled boolean
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
    community_distribution_enabled = p_community_distribution_enabled,
    community_team_distribution_enabled = p_community_team_distribution_enabled,
    community_league_distribution_enabled = p_community_league_distribution_enabled,
    community_sport_distribution_enabled = p_community_sport_distribution_enabled,
    updated_at = now(),
    updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (
    p_admin_id, 'settings.communities_updated', 'platform_settings', null,
    jsonb_build_object(
      'communityDistributionEnabled', v_before.community_distribution_enabled,
      'communityTeamDistributionEnabled', v_before.community_team_distribution_enabled,
      'communityLeagueDistributionEnabled', v_before.community_league_distribution_enabled,
      'communitySportDistributionEnabled', v_before.community_sport_distribution_enabled
    ),
    jsonb_build_object(
      'communityDistributionEnabled', v_after.community_distribution_enabled,
      'communityTeamDistributionEnabled', v_after.community_team_distribution_enabled,
      'communityLeagueDistributionEnabled', v_after.community_league_distribution_enabled,
      'communitySportDistributionEnabled', v_after.community_sport_distribution_enabled
    )
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

revoke all on function public.update_community_settings(uuid, timestamptz, boolean, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.update_community_settings(uuid, timestamptz, boolean, boolean, boolean, boolean) to service_role;

create or replace function public.update_conversation_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamptz,
  p_post_comment_max_length integer,
  p_post_comment_rate_limit_window_seconds integer,
  p_post_comment_rate_limit_max_attempts integer
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
    post_comment_max_length = p_post_comment_max_length,
    post_comment_rate_limit_window_seconds = p_post_comment_rate_limit_window_seconds,
    post_comment_rate_limit_max_attempts = p_post_comment_rate_limit_max_attempts,
    updated_at = now(),
    updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (
    p_admin_id, 'settings.conversation_updated', 'platform_settings', null,
    jsonb_build_object(
      'postCommentMaxLength', v_before.post_comment_max_length,
      'postCommentRateLimitWindowSeconds', v_before.post_comment_rate_limit_window_seconds,
      'postCommentRateLimitMaxAttempts', v_before.post_comment_rate_limit_max_attempts
    ),
    jsonb_build_object(
      'postCommentMaxLength', v_after.post_comment_max_length,
      'postCommentRateLimitWindowSeconds', v_after.post_comment_rate_limit_window_seconds,
      'postCommentRateLimitMaxAttempts', v_after.post_comment_rate_limit_max_attempts
    )
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

revoke all on function public.update_conversation_settings(uuid, timestamptz, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.update_conversation_settings(uuid, timestamptz, integer, integer, integer) to service_role;

create or replace function public.update_call_bs_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamptz,
  p_call_bs_enabled boolean,
  p_call_bs_rate_limit_window_seconds integer,
  p_call_bs_rate_limit_max_attempts integer
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
    call_bs_enabled = p_call_bs_enabled,
    call_bs_rate_limit_window_seconds = p_call_bs_rate_limit_window_seconds,
    call_bs_rate_limit_max_attempts = p_call_bs_rate_limit_max_attempts,
    updated_at = now(),
    updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (
    p_admin_id, 'settings.call_bs_updated', 'platform_settings', null,
    jsonb_build_object(
      'callBsEnabled', v_before.call_bs_enabled,
      'callBsRateLimitWindowSeconds', v_before.call_bs_rate_limit_window_seconds,
      'callBsRateLimitMaxAttempts', v_before.call_bs_rate_limit_max_attempts
    ),
    jsonb_build_object(
      'callBsEnabled', v_after.call_bs_enabled,
      'callBsRateLimitWindowSeconds', v_after.call_bs_rate_limit_window_seconds,
      'callBsRateLimitMaxAttempts', v_after.call_bs_rate_limit_max_attempts
    )
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

revoke all on function public.update_call_bs_settings(uuid, timestamptz, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.update_call_bs_settings(uuid, timestamptz, boolean, integer, integer) to service_role;

create or replace function public.update_monetary_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamptz,
  p_monetary_p2p_enabled boolean,
  p_monetary_proposal_rate_limit_window_seconds integer,
  p_monetary_proposal_rate_limit_max_attempts integer,
  p_p2p_fee_bps integer
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
    monetary_p2p_enabled = p_monetary_p2p_enabled,
    monetary_proposal_rate_limit_window_seconds = p_monetary_proposal_rate_limit_window_seconds,
    monetary_proposal_rate_limit_max_attempts = p_monetary_proposal_rate_limit_max_attempts,
    p2p_fee_bps = p_p2p_fee_bps,
    updated_at = now(),
    updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (
    p_admin_id, 'settings.monetary_p2p_updated', 'platform_settings', null,
    jsonb_build_object(
      'monetaryP2pEnabled', v_before.monetary_p2p_enabled,
      'monetaryProposalRateLimitWindowSeconds', v_before.monetary_proposal_rate_limit_window_seconds,
      'monetaryProposalRateLimitMaxAttempts', v_before.monetary_proposal_rate_limit_max_attempts,
      'p2pFeeBps', v_before.p2p_fee_bps
    ),
    jsonb_build_object(
      'monetaryP2pEnabled', v_after.monetary_p2p_enabled,
      'monetaryProposalRateLimitWindowSeconds', v_after.monetary_proposal_rate_limit_window_seconds,
      'monetaryProposalRateLimitMaxAttempts', v_after.monetary_proposal_rate_limit_max_attempts,
      'p2pFeeBps', v_after.p2p_fee_bps
    )
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

revoke all on function public.update_monetary_settings(uuid, timestamptz, boolean, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.update_monetary_settings(uuid, timestamptz, boolean, integer, integer, integer) to service_role;

create or replace function public.update_reputation_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamptz,
  p_leaderboard_min_decided_picks integer
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
    leaderboard_min_decided_picks = p_leaderboard_min_decided_picks,
    updated_at = now(),
    updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (
    p_admin_id, 'settings.reputation_updated', 'platform_settings', null,
    jsonb_build_object('leaderboardMinDecidedPicks', v_before.leaderboard_min_decided_picks),
    jsonb_build_object('leaderboardMinDecidedPicks', v_after.leaderboard_min_decided_picks)
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

revoke all on function public.update_reputation_settings(uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.update_reputation_settings(uuid, timestamptz, integer) to service_role;

create or replace function public.update_operations_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamptz,
  p_settlement_batch_size integer
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
    updated_at = now(),
    updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (
    p_admin_id, 'settings.operations_updated', 'platform_settings', null,
    jsonb_build_object('settlementBatchSize', v_before.settlement_batch_size),
    jsonb_build_object('settlementBatchSize', v_after.settlement_batch_size)
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

revoke all on function public.update_operations_settings(uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.update_operations_settings(uuid, timestamptz, integer) to service_role;
