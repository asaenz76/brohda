-- Milestone R13.10, Stage 4A (Social Discovery & Launch UX Remediation).
-- Two small, additive, backward-compatible changes supporting the feed
-- and notification-click-through work in this milestone. Neither column
-- changes any existing row's meaning, and neither is read by any code
-- path until this same milestone's application code (deployed together)
-- starts doing so.

-- 1) Feed eligibility policy (Stage 4 Part A, §3/§5): "only appropriate
-- current/relevant sports content" is mutable product policy, not a
-- technical invariant, so it gets a configurable column rather than a
-- hard-coded constant. How long a COMPLETED game's Post keeps appearing
-- in the discovery feed before dropping out — purely a feed-presentation
-- window, never touches grading/reputation/notifications, all of which
-- are keyed off `predictions.lifecycle_state`/`graded_at`, not this.
alter table public.platform_settings
  add column feed_completed_game_retention_hours integer not null default 24
    check (feed_completed_game_retention_hours >= 0);

comment on column public.platform_settings.feed_completed_game_retention_hours is
  'How many hours a COMPLETED game''s Post remains eligible for the social discovery feed (lib/communities/feed.ts) after its fixture reaches COMPLETED. NOT_STARTED/LIVE/HALFTIME/EXTRA_TIME/PENALTIES games are always feed-eligible regardless of this value; POSTPONED/SUSPENDED/ABANDONED/CANCELLED/AWARDED/UNKNOWN are never feed-eligible. Default 24h — a reasonable "keep last night''s result visible for a day" window, adjustable without a deployment.';

-- Extend update_market_settings() with this one new field — same domain
-- (feed policy lives alongside the other Brohda 2.0 content-pipeline
-- settings), same atomic update+audit pattern, same internal
-- is_super_admin() check. Signature change, so both the revoke/grant AND
-- the old-signature revoke are required (SECURITY_RPC_PRIVILEGE_INCIDENT_
-- REPORT.md's own documented lesson).
create or replace function public.update_market_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamptz,
  p_market_ingestion_enabled boolean,
  p_market_ingestion_min_bookmaker_count integer,
  p_post_publication_enabled boolean,
  p_post_publication_requires_active_market boolean,
  p_social_prediction_enabled boolean,
  p_feed_completed_game_retention_hours integer
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
    social_prediction_enabled = p_social_prediction_enabled,
    feed_completed_game_retention_hours = p_feed_completed_game_retention_hours,
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
      'postPublicationRequiresActiveMarket', v_before.post_publication_requires_active_market,
      'socialPredictionEnabled', v_before.social_prediction_enabled,
      'feedCompletedGameRetentionHours', v_before.feed_completed_game_retention_hours
    ),
    jsonb_build_object(
      'marketIngestionEnabled', v_after.market_ingestion_enabled,
      'marketIngestionMinBookmakerCount', v_after.market_ingestion_min_bookmaker_count,
      'postPublicationEnabled', v_after.post_publication_enabled,
      'postPublicationRequiresActiveMarket', v_after.post_publication_requires_active_market,
      'socialPredictionEnabled', v_after.social_prediction_enabled,
      'feedCompletedGameRetentionHours', v_after.feed_completed_game_retention_hours
    )
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

drop function if exists public.update_market_settings(uuid, timestamptz, boolean, integer, boolean, boolean, boolean);

revoke all on function public.update_market_settings(uuid, timestamptz, boolean, integer, boolean, boolean, boolean, integer) from public, anon, authenticated;
grant execute on function public.update_market_settings(uuid, timestamptz, boolean, integer, boolean, boolean, boolean, integer) to service_role;

-- 2) Notification click-through (Stage 4 Part A, §14 / remediation §17):
-- `prediction_graded` notifications currently resolve to no destination.
-- `notifications.post_id` already exists (added by
-- 20260101000153_post_comments.sql for POST_COMMENT_REPLY) — reused here
-- rather than adding a second, redundant Post-reference column.
-- lib/notifications/links.ts's resolveNotificationHref gets a shared
-- generic case for any type that populates this column (both
-- POST_COMMENT_REPLY, whose own click-through was ALSO missing until now
-- — the exact same class of gap, fixed once), rather than one bespoke
-- branch per type.
comment on column public.notifications.post_id is
  'The canonical Post this notification is about, for click-through (lib/notifications/links.ts, generic post_id branch). Populated for type=POST_COMMENT_REPLY (lib/notifications/post-comments.ts) and, as of Milestone R13.10 Stage 4A, type=prediction_graded (lib/predictions/grading.ts resolves it via the Market''s fixture_id at grading time). Null for every other notification type.';
