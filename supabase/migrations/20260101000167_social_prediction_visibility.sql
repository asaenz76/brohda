-- Milestone R13.10, Stage 0 — R13.8/R13.9 both deliberately deferred a
-- known gap: Brohda 2.0's ordinary-user-facing routes (/markets,
-- /markets/[id], /post/[id], /community/[slug], /leaderboard/predictions,
-- /my-picks) are reachable by any authenticated user regardless of
-- market_ingestion_enabled/post_publication_enabled/community_
-- distribution_enabled — those three flags gate *backend content
-- preparation*, never *user-facing exposure*. This migration adds the
-- dedicated, separate gate: DEPLOY != ACTIVATE requires a setting that
-- controls access, not content, so the content pipeline (ingestion,
-- publication, distribution) can run and be verified in production while
-- ordinary users still see nothing.
--
-- Deliberately NOT folded into any of the three existing content-prep
-- flags, and NOT reusing call_bs_enabled/monetary_p2p_enabled (both
-- explicitly forbidden by this milestone). Placed in the same "Markets"
-- domain/RPC as market_ingestion_enabled/post_publication_enabled since
-- it's the closest existing activation-flag cluster and this avoids
-- inventing a whole new settings domain/admin-UI card for one boolean.
alter table public.platform_settings
  add column social_prediction_enabled boolean not null default false;

comment on column public.platform_settings.social_prediction_enabled is
  'Gates ordinary-user access to Brohda 2.0''s social prediction routes (/markets, /markets/[id], /post/[id], /community/[slug], /leaderboard/predictions, /my-picks) via requireSocialPredictionAccess() (lib/social/access.ts). Independent of market_ingestion_enabled/post_publication_enabled/community_distribution_enabled, which gate backend content preparation only. Super Admin/Admin roles always pass regardless of this flag, for operational preview. Default false — deploying this migration and its application code does not expose anything.';

-- Extend update_market_settings() (20260101000161) with this one new
-- field — same domain, same shape, same atomic update+audit pattern,
-- same internal is_super_admin() check. Signature change, so both the
-- revoke/grant AND the old-signature revoke are required.
create or replace function public.update_market_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamptz,
  p_market_ingestion_enabled boolean,
  p_market_ingestion_min_bookmaker_count integer,
  p_post_publication_enabled boolean,
  p_post_publication_requires_active_market boolean,
  p_social_prediction_enabled boolean
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
      'socialPredictionEnabled', v_before.social_prediction_enabled
    ),
    jsonb_build_object(
      'marketIngestionEnabled', v_after.market_ingestion_enabled,
      'marketIngestionMinBookmakerCount', v_after.market_ingestion_min_bookmaker_count,
      'postPublicationEnabled', v_after.post_publication_enabled,
      'postPublicationRequiresActiveMarket', v_after.post_publication_requires_active_market,
      'socialPredictionEnabled', v_after.social_prediction_enabled
    )
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

-- Drop the old 6-arg signature — CREATE OR REPLACE cannot change a
-- function's parameter list in place; the old signature would otherwise
-- remain callable (and, per the exact root-cause mechanism documented in
-- SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md, revert to PUBLIC-execute
-- defaults) unless explicitly dropped.
drop function if exists public.update_market_settings(uuid, timestamptz, boolean, integer, boolean, boolean);

revoke all on function public.update_market_settings(uuid, timestamptz, boolean, integer, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.update_market_settings(uuid, timestamptz, boolean, integer, boolean, boolean, boolean) to service_role;
