-- Milestone R12 (docs/BROHDA_2_0_MILESTONE_MAP.md, Admin + Configuration).
-- Additive only. Turns the mutable product/operational policy R1-R11
-- already moved into `platform_settings` into an actual operator
-- product: typed, validated, role-protected, atomically-audited,
-- concurrency-safe settings mutation. See
-- docs/architecture/admin-configuration.md for the full rationale and
-- the complete configuration catalog (which settings are exposed here,
-- and which are deliberately not, and why).
--
-- Repository-truth-gather confirmed: `platform_settings` is already a
-- singleton row with no client write policy at all (only `service_role`
-- may UPDATE) — every column added here inherits that exact posture
-- automatically. The existing settings-mutation pattern
-- (lib/actions/settings.ts: requireSuperAdmin() -> plain .update() via
-- the admin client -> writeAuditLog() afterward) is NOT atomic between
-- the config write and the audit write — a crash between the two could
-- leave a changed setting with no audit trail. R12 does not repeat that
-- gap for its own new settings: every RPC below performs the UPDATE and
-- the audit_logs INSERT inside the same PL/pgSQL function body — one
-- Postgres transaction, atomic by construction — a deliberate,
-- documented improvement over the pre-existing (untouched, out of
-- scope) legacy pattern.

-- =====================================================================
-- Closes the R10 settlement-batch-size caveat (§36, §82): a genuine,
-- safe, bounded operational-policy value an operator might reasonably
-- want to change without deployment. Was a plain TypeScript function
-- parameter default (`listSettlementEligiblePositionIds(limit = 500)`);
-- now lives in canonical configuration instead.
-- =====================================================================
alter table public.platform_settings
  add column settlement_batch_size integer not null default 500 check (settlement_batch_size >= 1 and settlement_batch_size <= 5000);

comment on column public.platform_settings.settlement_batch_size is
  'Maximum number of COMMITTED Positions the settlement runner (scripts/settle-monetary-positions.ts) considers per invocation. Read live by listSettlementEligiblePositionIds() (lib/monetary/repository.ts). Purely an operational batch-size knob — never affects settlement correctness, only how much work one run does.';

-- Two previously-unconstrained columns get the same defense-in-depth
-- CHECK every sibling numeric policy column in this table already has
-- (§91 — this ADDS a constraint that was simply missing, never removes
-- or weakens an existing one).
alter table public.platform_settings
  add constraint platform_settings_prediction_cutoff_minutes_check check (prediction_cutoff_minutes_before_close >= 0);

alter table public.platform_settings
  add constraint platform_settings_notify_copy_correct_nonempty check (length(trim(prediction_notify_title_correct)) > 0 and length(trim(prediction_notify_body_correct)) > 0),
  add constraint platform_settings_notify_copy_incorrect_nonempty check (length(trim(prediction_notify_title_incorrect)) > 0 and length(trim(prediction_notify_body_incorrect)) > 0),
  add constraint platform_settings_notify_copy_void_nonempty check (length(trim(prediction_notify_title_void)) > 0 and length(trim(prediction_notify_body_void)) > 0);

-- =====================================================================
-- Shared (row, outcome) composite, reused by all 9 domain-settings RPCs
-- below — the same "materialize-or-report-a-specific-non-success-
-- outcome" reasoning already established repeatedly this project
-- (set_pick, accept_call_bs, accept_monetary_proposal,
-- settle_monetary_position): a stale optimistic-concurrency write
-- (§42, §74, §89) must be reported as `conflict`, not silently
-- overwritten and not a generic exception — the caller needs the
-- CURRENT row back either way.
-- =====================================================================
create type public.admin_settings_update_result as (
  settings public.platform_settings,
  outcome text
);

-- =====================================================================
-- update_prediction_settings(): Pick-eligibility timing/policy (§24,
-- catalog "Predictions" domain). Client input is limited to the exact
-- typed fields this domain owns (§9 — no generic key/value writer
-- anywhere in this milestone); p_admin_id/p_expected_updated_at are
-- supplied by the trusted, already-requireSuperAdmin()-gated Server
-- Action, never a raw end-user client (this function itself is
-- service_role-only, per its own grant below).
-- =====================================================================
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

-- =====================================================================
-- update_notification_settings(): prediction-graded notification
-- enablement + copy (§33-34, catalog "Notifications" domain — the only
-- notification copy this codebase makes configurable at all; free
-- Challenge/monetary/settlement notifications are plain hard-coded
-- TypeScript strings by deliberate prior design, unchanged here).
-- =====================================================================
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
    to_jsonb(v_before) - 'id' - 'updated_at' - 'updated_by',
    to_jsonb(v_after) - 'id' - 'updated_at' - 'updated_by'
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

revoke all on function public.update_notification_settings(uuid, timestamptz, boolean, boolean, boolean, boolean, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.update_notification_settings(uuid, timestamptz, boolean, boolean, boolean, boolean, text, text, text, text, text, text) to service_role;

-- =====================================================================
-- update_market_settings(): ingestion + post-publication policy (§27-28,
-- catalog "Markets" domain). Deliberately does NOT expose
-- `post_primary_market_template_priority` (a display-ordering array over
-- the fixed MONEYLINE/SPREAD/TOTAL enum) — no operator-control signal
-- exists for it yet; see the architecture doc's "not exposed" section.
-- market_ingestion_min_bookmaker_count keeps its existing >= 1 CHECK.
-- =====================================================================
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

-- =====================================================================
-- update_community_settings(): distribution enablement, global + 3
-- independent per-type switches (§26, catalog "Communities" domain).
-- Disabling any of these never rewrites or deletes historical
-- post_communities rows (lib/communities/distribution.ts's own policy
-- check runs only at distribution-decision time, on new Posts) — no
-- destructive behavior exists to accidentally expose here.
-- =====================================================================
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

-- =====================================================================
-- update_conversation_settings(): comment length + rate limit (§29,
-- catalog "Conversation" domain). post_comment_max_length keeps its
-- existing `between 1 and 2000` CHECK — the 2000 upper bound IS the
-- technical DB ceiling (post_comments.body's own CHECK constraint,
-- untouched); this column can never exceed it, so the admin-configurable
-- product limit and the technical invariant stay correctly distinct
-- without any new code (§29's own "maintain that distinction").
-- =====================================================================
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

-- =====================================================================
-- update_call_bs_settings(): feature flag + rate limit (§30, catalog
-- "Call BS" domain). No Challenge scoring/stakes/ranking-weight fields
-- exist to expose — none were ever built (free Challenges have no such
-- concept), matching §30's own explicit "do not add" instruction.
-- =====================================================================
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

-- =====================================================================
-- update_monetary_settings(): the financial-policy domain (§7, §22,
-- §31, §66-67) — enablement, rate limit, and the P2P fee. This is the
-- one domain the completion report gives the strongest role protection:
-- exactly the same requireSuperAdmin() gate as every other domain here
-- (this whole Brohda settings surface is super_admin-only, mirroring
-- the pre-existing /admin/settings page's own established, monolithic
-- super_admin gate — see the architecture doc's "Role model" section
-- for why no domain in this milestone was split to plain `admin`).
-- Changing p2p_fee_bps here NEVER touches monetary_positions.fee_bps —
-- that column is captured once, inside accept_monetary_proposal(),
-- entirely unmodified by this migration; this function only ever writes
-- the live platform_settings.p2p_fee_bps column new commitments read at
-- their own acceptance moment (§18, §67, verified by a dedicated test).
-- =====================================================================
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

-- =====================================================================
-- update_reputation_settings(): the leaderboard minimum-sample threshold
-- (§23, §32, §83, catalog "Reputation" domain). Deliberately the ONLY
-- reputation field exposed — ranking formula/tie-breaks/accuracy
-- denominator are transparent product invariants, never admin toggles
-- (§32's own explicit instruction).
-- =====================================================================
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

-- =====================================================================
-- update_operations_settings(): the settlement batch size (§36, §82,
-- catalog "Operations" domain) — the one genuinely new column this
-- migration adds.
-- =====================================================================
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
