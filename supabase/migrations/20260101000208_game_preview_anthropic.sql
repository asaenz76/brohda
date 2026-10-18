-- Game Preview generation, Anthropic V1: provider becomes Anthropic (Claude Messages API + server-side web search), with the editorial-quality controls.
--
-- Additive on migration 207 apart from one narrowing the owner decided: the only implemented provider is 'anthropic' (the code keeps a provider-neutral interface and registry; a future provider is a new migration + registry entry).
-- New stored settings (nothing is a constant in code): effort (default 'medium'), the web-search tool version (the API versions its server tools; the default is the long-supported basic one and the admin can move to a newer
-- version without a deploy), how many facts one Preview may cite (one Game, one story), and the score below which a candidate story is not good enough to beat a records fallback. The web-search ceiling defaults to 3 per Game. The model id stays EMPTY here: it is set (audited) from Admin, never defaulted in code or SQL.
-- game_preview_runs gains `details` — what the run found and decided (sources reached / accepted / rejected, candidate facts, the candidate angles and which was chosen, what validation rejected) — plus the effort and tool version used.

alter table public.game_preview_config drop constraint if exists game_preview_config_provider_check;
update public.game_preview_config set provider = 'anthropic' where provider <> 'anthropic';
alter table public.game_preview_config
  alter column provider set default 'anthropic',
  add constraint game_preview_config_provider_check check (provider in ('anthropic')),
  add column effort text not null default 'medium' check (effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  add column web_search_tool_version text not null default 'web_search_20250305' check (web_search_tool_version in ('web_search_20250305', 'web_search_20260209', 'web_search_20260318')),
  add column max_cited_facts integer not null default 4 check (max_cited_facts between 1 and 10),
  add column min_story_score numeric(2, 1) not null default 3.0 check (min_story_score between 1 and 5),
  alter column max_search_calls_per_game set default 3;
update public.game_preview_config set max_search_calls_per_game = 3 where id = true and max_search_calls_per_game = 8;

alter table public.game_preview_runs
  add column details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  add column effort text,
  add column tool_version text;
comment on column public.game_preview_runs.details is 'What the run found and decided: sources reached/accepted/rejected, candidate facts, candidate angles with scores, the chosen angle, validation rejections per attempt.';

create or replace function public.admin_set_game_preview_config(p_admin_id uuid, p_config jsonb)
returns public.game_preview_config
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.game_preview_config;
  v_after public.game_preview_config;
  v_key text;
  v_allowed text[] := array['max_chars', 'hook_max_chars', 'lead_hours', 'stale_after_hours', 'min_refresh_interval_hours', 'generation_enabled', 'provider', 'model', 'web_search_enabled', 'verify_with_model', 'max_attempts', 'max_games_per_run',
    'max_search_calls_per_game', 'current_fact_max_age_hours', 'preferred_domains', 'blocked_domains', 'effort', 'web_search_tool_version', 'max_cited_facts', 'min_story_score'];
begin
  perform public.require_super_admin(p_admin_id);
  if p_config is null or jsonb_typeof(p_config) <> 'object' then raise exception 'invalid_config'; end if;
  for v_key in select jsonb_object_keys(p_config) loop
    if not (v_key = any (v_allowed)) then raise exception 'unknown_setting_%', v_key; end if;
  end loop;
  if p_config ? 'preferred_domains' and jsonb_typeof(p_config -> 'preferred_domains') <> 'array' then raise exception 'invalid_domains'; end if;
  if p_config ? 'blocked_domains' and jsonb_typeof(p_config -> 'blocked_domains') <> 'array' then raise exception 'invalid_domains'; end if;
  select * into v_before from public.game_preview_config where id = true for update;
  update public.game_preview_config set
    max_chars = coalesce((p_config ->> 'max_chars')::integer, max_chars),
    hook_max_chars = coalesce((p_config ->> 'hook_max_chars')::integer, hook_max_chars),
    lead_hours = coalesce((p_config ->> 'lead_hours')::integer, lead_hours),
    stale_after_hours = coalesce((p_config ->> 'stale_after_hours')::integer, stale_after_hours),
    min_refresh_interval_hours = coalesce((p_config ->> 'min_refresh_interval_hours')::integer, min_refresh_interval_hours),
    generation_enabled = coalesce((p_config ->> 'generation_enabled')::boolean, generation_enabled),
    provider = coalesce(p_config ->> 'provider', provider),
    model = coalesce(btrim(p_config ->> 'model'), model),
    web_search_enabled = coalesce((p_config ->> 'web_search_enabled')::boolean, web_search_enabled),
    verify_with_model = coalesce((p_config ->> 'verify_with_model')::boolean, verify_with_model),
    max_attempts = coalesce((p_config ->> 'max_attempts')::integer, max_attempts),
    max_games_per_run = coalesce((p_config ->> 'max_games_per_run')::integer, max_games_per_run),
    max_search_calls_per_game = coalesce((p_config ->> 'max_search_calls_per_game')::integer, max_search_calls_per_game),
    current_fact_max_age_hours = coalesce((p_config ->> 'current_fact_max_age_hours')::integer, current_fact_max_age_hours),
    effort = coalesce(p_config ->> 'effort', effort),
    web_search_tool_version = coalesce(p_config ->> 'web_search_tool_version', web_search_tool_version),
    max_cited_facts = coalesce((p_config ->> 'max_cited_facts')::integer, max_cited_facts),
    min_story_score = coalesce((p_config ->> 'min_story_score')::numeric, min_story_score),
    preferred_domains = case when p_config ? 'preferred_domains' then array(select lower(btrim(x)) from jsonb_array_elements_text(p_config -> 'preferred_domains') x where btrim(x) <> '') else preferred_domains end,
    blocked_domains = case when p_config ? 'blocked_domains' then array(select lower(btrim(x)) from jsonb_array_elements_text(p_config -> 'blocked_domains') x where btrim(x) <> '') else blocked_domains end,
    updated_by = p_admin_id, updated_at = now()
  where id = true returning * into v_after;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after) values (p_admin_id, 'settings.game_preview_updated', 'game_preview_config', null, to_jsonb(v_before), to_jsonb(v_after));
  return v_after;
end;
$$;
revoke all on function public.admin_set_game_preview_config(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_set_game_preview_config(uuid, jsonb) to service_role;
