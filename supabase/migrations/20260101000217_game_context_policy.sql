-- Brohda 2.1 M3 — Deterministic Game Context: the policy, and nothing else.
--
-- Game Context is computed at read time from fixtures Brohda already stores (lib/game-context). It needs no table, no job and no generated content, so the whole database change is two
-- settings and the audited Super-Admin function that edits them:
--   platform_settings.game_context_enabled  boolean, default FALSE — applying this migration or deploying the code never turns the feature on;
--   platform_settings.game_context_config   jsonb, NULL = the built-in defaults; otherwise an object of the keys listed in admin_set_game_context_policy (every key optional).
--
-- Numbering: 217, not 216, on purpose. Migration 216 was the abandoned AI Game Story Engine: it was reverted from main and never applied to production, but it WAS applied to staging, whose migration
-- history therefore holds a 216 this repository no longer has. Reusing 216 here would collide with that history; 217 is unambiguous on production (215 -> 217), on staging (216 -> 217) and on a fresh
-- database (1..215 -> 217). Nothing here reads, depends on or touches anything 216 created.
--
-- No existing function, table or policy is changed. No down migration: rollback is turning the setting off (the feature then renders nothing; no data was ever written).

alter table public.platform_settings
  add column game_context_enabled boolean not null default false,
  add column game_context_config jsonb;

alter table public.platform_settings
  add constraint platform_settings_game_context_config_object
    check (game_context_config is null or jsonb_typeof(game_context_config) = 'object');

comment on column public.platform_settings.game_context_enabled is
  'M3: when true, a Game Post may show one short context line computed from stored sports data (lib/game-context). Default false = nothing is shown and nothing is computed. Edited only through admin_set_game_context_policy().';
comment on column public.platform_settings.game_context_config is
  'M3: Game Context thresholds as a jsonb object (min_win_streak, min_loss_streak, min_venue_streak, last_n, last_n_min_decisive, series_enabled, pairs_enabled, connective_enabled, min_score, max_chars). NULL = defaults. The application parses it fail-closed: anything invalid means the feature is off.';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The audited switch. Super Admin only (service role + require_super_admin). p_enabled NULL = leave as is; p_config NULL = leave as is, otherwise it REPLACES the whole config ('{}' = back to defaults).
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_set_game_context_policy(
  p_admin_id uuid,
  p_enabled boolean default null,
  p_config jsonb default null
)
returns public.platform_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.platform_settings;
  v_after public.platform_settings;
  v_int constant jsonb := '{"min_win_streak":[2,20],"min_loss_streak":[2,20],"min_venue_streak":[2,20],"last_n":[3,20],"last_n_min_decisive":[2,20],"min_score":[10,200],"max_chars":[40,200]}';
  v_bool constant text[] := array['series_enabled', 'pairs_enabled', 'connective_enabled'];
  v_key text;
  v_value jsonb;
  v_last_n int;
  v_decisive int;
begin
  perform public.require_super_admin(p_admin_id);

  if p_config is not null then
    if jsonb_typeof(p_config) <> 'object' then raise exception 'invalid_config'; end if;
    for v_key, v_value in select * from jsonb_each(p_config) loop
      if v_int ? v_key then
        if jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}') !~ '^[0-9]+$'
           or (v_value #>> '{}')::int < (v_int -> v_key ->> 0)::int or (v_value #>> '{}')::int > (v_int -> v_key ->> 1)::int then
          raise exception 'invalid_config';
        end if;
      elsif v_key = any (v_bool) then
        if jsonb_typeof(v_value) <> 'boolean' then raise exception 'invalid_config'; end if;
      else
        raise exception 'invalid_config';
      end if;
    end loop;
    -- "Notable" must be a real majority of the window and cannot exceed it (the defaults are 5 and 5).
    v_last_n := coalesce((p_config ->> 'last_n')::int, 5);
    v_decisive := coalesce((p_config ->> 'last_n_min_decisive')::int, 5);
    if v_decisive > v_last_n or v_decisive * 2 <= v_last_n then raise exception 'invalid_config'; end if;
  end if;

  select * into v_before from public.platform_settings where id = true for update;
  if (p_enabled is null or p_enabled = v_before.game_context_enabled)
     and (p_config is null or p_config is not distinct from v_before.game_context_config) then
    return v_before;
  end if;

  update public.platform_settings set
    game_context_enabled = coalesce(p_enabled, game_context_enabled),
    game_context_config = case when p_config is null then game_context_config else p_config end,
    updated_at = now(), updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
    values (p_admin_id, 'settings.game_context_policy_updated', 'platform_settings', null,
      jsonb_build_object('game_context_enabled', v_before.game_context_enabled, 'game_context_config', v_before.game_context_config),
      jsonb_build_object('game_context_enabled', v_after.game_context_enabled, 'game_context_config', v_after.game_context_config));
  return v_after;
end;
$$;
revoke all on function public.admin_set_game_context_policy(uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.admin_set_game_context_policy(uuid, boolean, jsonb) to service_role;
