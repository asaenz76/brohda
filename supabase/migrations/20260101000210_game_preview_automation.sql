-- Game Preview automation: the scheduler's candidate rules, retry throttling, status-bearing refresh, who withdrew a Preview, and the daily report.
--
-- Principle: automation chooses WHEN to run the generation pipeline; it never changes WHAT the pipeline considers publishable. Nothing here writes editorial text. Everything is forward-only and callable by service_role only.
--   1. Configuration: which competitions automation covers, the retry intervals for a safe rejection and for a technical failure, and the status refresh (on/off and the refresh-before-Game window). The generic stale window (stale_after_hours) and
--      the minimum refresh interval (min_refresh_interval_hours) already existed and are reused for the status refresh.
--   2. game_previews.withdrawn_by: a withdrawal by an Admin SUPPRESSES ordinary automation for that Game (automation does not undo an owner's decision); a withdrawal by automation (a status refresh that could not be verified) does not.
--   3. automation_hide_game_preview: the safest existing publication state (WITHDRAWN, nothing deleted) for a status-bearing Preview whose status could not be re-established; audited with no human actor.
--   4. game_preview_automation_candidates: ONE rule for what the scheduler may run, with the reason every other Game was skipped.
--   5. game_preview_automation_report: the first-week monitoring numbers, derived from the run records.

alter table public.game_preview_config
  add column automation_competitions text[] not null default array['NFL', 'NBA', 'NHL'],
  add column automation_retry_hours integer not null default 24 check (automation_retry_hours between 1 and 720),
  add column automation_technical_retry_hours integer not null default 6 check (automation_technical_retry_hours between 1 and 720),
  add column status_refresh_enabled boolean not null default true,
  add column status_refresh_window_hours integer not null default 24 check (status_refresh_window_hours between 1 and 168);
comment on column public.game_preview_config.automation_competitions is 'Competitions (as stored on the fixture, e.g. NFL) the scheduled automation covers. Admin Generate works for any Game.';
comment on column public.game_preview_config.automation_retry_hours is 'A Game whose automatic run ended needs_review (REJECTED) is not retried automatically before this many hours (with a small tolerance for scheduler jitter). Default 24: once per day.';
comment on column public.game_preview_config.automation_technical_retry_hours is 'A Game whose automatic run ended in a technical FAILURE is not retried automatically before this many hours.';
comment on column public.game_preview_config.status_refresh_enabled is 'Whether a published Preview that states a current player status is refreshed (through the normal pipeline) before its Game.';
comment on column public.game_preview_config.status_refresh_window_hours is 'A status-bearing Preview is refresh-eligible only when its Game starts within this many hours.';

alter table public.game_previews
  add column withdrawn_by text check (withdrawn_by is null or withdrawn_by in ('ADMIN', 'AUTOMATION'));
comment on column public.game_previews.withdrawn_by is 'Who withdrew the Preview: ADMIN (suppresses ordinary automation for the Game) or AUTOMATION (a status refresh that could not be verified). Cleared when the Preview is published again.';
-- Every withdrawal so far was made by an Admin.
update public.game_previews set withdrawn_by = 'ADMIN' where status = 'WITHDRAWN' and withdrawn_by is null;

-- A withdrawal that does not say who made it is an Admin's (the admin_withdraw function is unchanged); publishing again clears the mark.
create or replace function public.game_previews_withdrawn_by_default()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'WITHDRAWN' and new.withdrawn_by is null then
    new.withdrawn_by := 'ADMIN';
  elsif new.status = 'PUBLISHED' then
    new.withdrawn_by := null;
  end if;
  return new;
end;
$$;
create trigger game_previews_withdrawn_by_default
  before insert or update of status, withdrawn_by on public.game_previews
  for each row execute function public.game_previews_withdrawn_by_default();

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Hiding a status-bearing Preview whose status could not be re-established. Withdrawal, never deletion: the text, claims and sources stay on record.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.automation_hide_game_preview(p_fixture_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_preview public.game_previews;
  v_fixture record;
  v_reason text := left(btrim(coalesce(p_reason, '')), 500);
begin
  if v_reason = '' then raise exception 'reason_required'; end if;
  select f.internal_status, f.scheduled_start_utc into v_fixture from public.fixtures f where f.id = p_fixture_id;
  if v_fixture.internal_status is null then return jsonb_build_object('outcome', 'fixture_not_found'); end if;
  perform pg_advisory_xact_lock(hashtext('game_preview:' || p_fixture_id::text));
  select * into v_preview from public.game_previews where fixture_id = p_fixture_id for update;
  if v_preview.id is null or v_preview.status <> 'PUBLISHED' then return jsonb_build_object('outcome', 'not_published'); end if;
  if v_preview.frozen_at is not null or v_fixture.internal_status <> 'NOT_STARTED' or v_fixture.scheduled_start_utc <= now() then return jsonb_build_object('outcome', 'game_started'); end if;
  update public.game_previews set status = 'WITHDRAWN', withdrawn_reason = v_reason, withdrawn_by = 'AUTOMATION' where id = v_preview.id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after, reason)
  values (null, 'game_preview.auto_hidden', 'game_previews', v_preview.id, jsonb_build_object('status', v_preview.status, 'hook', v_preview.hook), jsonb_build_object('status', 'WITHDRAWN', 'withdrawnBy', 'AUTOMATION'), v_reason);
  return jsonb_build_object('outcome', 'hidden', 'previewId', v_preview.id);
end;
$$;
revoke all on function public.automation_hide_game_preview(uuid, text) from public, anon, authenticated;
grant execute on function public.automation_hide_game_preview(uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- What the scheduler may run. Every published, unstarted Game inside the generation lead window, with the reason it is NOT a candidate (null = candidate):
--   INITIAL  no Preview (or one automation itself hid), within the lead window.
--   REFRESH  a published, unfrozen Preview that states a current player status, whose Game starts within the status refresh window, whose status was last established more than stale_after_hours ago, and which was not generated within the minimum refresh interval.
--            A Preview without a status claim is never refreshed by automation; a hand-edited Preview is never overwritten; an Admin-withdrawn Preview is never regenerated by automation.
--   A Game whose last automatic or Admin run ended needs_review (REJECTED) or in a technical FAILURE is throttled for the configured interval (minus a tolerance of 10%, at most 2 hours, for scheduler jitter and run time).
-- The start of the Game is enforced here (it must be in the future) and again by the pipeline and the database write.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.game_preview_automation_candidates(p_fixture_id uuid default null)
returns table (fixture_id uuid, post_id uuid, home_team_name text, away_team_name text, competition_name text, scheduled_start_utc timestamptz, kind text, reason text, skip_reason text)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, po.id, f.home_team_name, f.away_team_name, f.competition_name, f.scheduled_start_utc,
         case when gp.id is null or gp.status = 'WITHDRAWN' then 'INITIAL' else 'REFRESH' end,
         case when gp.id is null or gp.status = 'WITHDRAWN' then 'MISSING' else 'MATERIAL_NEW_INFORMATION' end,
         case
           when f.competition_name is null or not (f.competition_name = any (c.automation_competitions)) then 'UNSUPPORTED_COMPETITION'
           when gp.id is null or gp.status = 'WITHDRAWN' then
             case
               when gp.status = 'WITHDRAWN' and gp.withdrawn_by is distinct from 'AUTOMATION' then 'ADMIN_WITHDRAWN'
               when lr.last_rejected > now() - make_interval(secs => greatest(c.automation_retry_hours * 3600 - least(7200, c.automation_retry_hours * 360), 0)) then 'RETRY_THROTTLED'
               when lr.last_failed > now() - make_interval(secs => greatest(c.automation_technical_retry_hours * 3600 - least(7200, c.automation_technical_retry_hours * 360), 0)) then 'TECHNICAL_RETRY_THROTTLED'
               else null
             end
           when gp.frozen_at is not null then 'FROZEN'
           when coalesce((gp.generation_meta ->> 'manualEdit')::boolean, false) then 'ADMIN_EDITED'
           when not c.status_refresh_enabled then 'REFRESH_DISABLED'
           when f.scheduled_start_utc > now() + make_interval(hours => c.status_refresh_window_hours) then 'OUTSIDE_REFRESH_WINDOW'
           when not coalesce((gp.generation_meta -> 'status' ->> 'hasStatusClaim')::boolean,
                             exists (select 1 from jsonb_array_elements(case when jsonb_typeof(gp.generation_meta -> 'facts') = 'array' then gp.generation_meta -> 'facts' else '[]'::jsonb end) e where e ->> 'kind' = 'current' and e ->> 'category' = 'injury')) then 'NOT_STATUS_BEARING'
           when gp.generated_at > now() - make_interval(hours => c.min_refresh_interval_hours) then 'REFRESH_TOO_SOON'
           when coalesce(nullif(gp.generation_meta -> 'status' ->> 'asOf', '')::timestamptz, gp.generated_at) > now() - make_interval(hours => c.stale_after_hours) then 'STATUS_FRESH'
           when lr.last_rejected > now() - make_interval(secs => greatest(c.automation_retry_hours * 3600 - least(7200, c.automation_retry_hours * 360), 0)) then 'RETRY_THROTTLED'
           when lr.last_failed > now() - make_interval(secs => greatest(c.automation_technical_retry_hours * 3600 - least(7200, c.automation_technical_retry_hours * 360), 0)) then 'TECHNICAL_RETRY_THROTTLED'
           else null
         end
    from public.posts po
    join public.fixtures f on f.id = po.fixture_id
    cross join public.game_preview_config c
    left join public.game_previews gp on gp.fixture_id = f.id
    left join lateral (
      select max(r.started_at) filter (where r.status = 'REJECTED') as last_rejected,
             max(r.started_at) filter (where r.status = 'FAILED') as last_failed
        from public.game_preview_runs r
       where r.fixture_id = f.id and r.started_at > now() - interval '30 days'
    ) lr on true
   where po.published_at is not null
     and f.internal_status = 'NOT_STARTED'
     and f.scheduled_start_utc > now()
     and f.scheduled_start_utc <= now() + make_interval(hours => c.lead_hours)
     and (p_fixture_id is null or f.id = p_fixture_id)
   order by f.scheduled_start_utc, f.id;
$$;
revoke all on function public.game_preview_automation_candidates(uuid) from public, anon, authenticated;
grant execute on function public.game_preview_automation_candidates(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- First-week monitoring, derived from the run records of AUTOMATIC runs (Games considered / eligible / selected are in the scheduler job's own result in background_jobs).
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.game_preview_automation_report(p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with r as (select * from public.game_preview_runs where trigger = 'AUTOMATIC' and started_at >= p_since)
  select jsonb_build_object(
    'since', p_since,
    'attempted', count(*),
    'ready', count(*) filter (where status = 'SUCCEEDED'),
    'needsReview', count(*) filter (where status = 'REJECTED'),
    'failed', count(*) filter (where status = 'FAILED'),
    'initialRuns', count(*) filter (where reason = 'MISSING'),
    'refreshRuns', count(*) filter (where reason <> 'MISSING'),
    'searchCalls', coalesce(sum(search_calls), 0),
    'modelCalls', coalesce(sum(model_calls), 0),
    'parseRecoveries', coalesce(sum(case when jsonb_typeof(details -> 'parseRecoveries') = 'array' then jsonb_array_length(details -> 'parseRecoveries') else 0 end), 0),
    'statusBlocks', coalesce(sum(coalesce((details -> 'blockingCounts' -> 'reviewerByCategory' ->> 'status_source_ineligible')::integer, 0)), 0),
    'staleCurrentBlocks', coalesce(sum(coalesce((details -> 'blockingCounts' -> 'reviewerByCategory' ->> 'stale_current')::integer, 0)), 0),
    'statusClaimsRemoved', coalesce(sum(case when jsonb_typeof(details -> 'statusChecks') = 'array' then (select count(*) from jsonb_array_elements(details -> 'statusChecks') s where s ->> 'outcome' = 'removed') else 0 end), 0),
    'creditLookupRuns', count(*) filter (where jsonb_typeof(details -> 'creditLookups') = 'array' and jsonb_array_length(details -> 'creditLookups') > 0)
  ) from r;
$$;
revoke all on function public.game_preview_automation_report(timestamptz) from public, anon, authenticated;
grant execute on function public.game_preview_automation_report(timestamptz) to service_role;

-- The Admin settings call accepts the new automation settings too (audited, validated as a whole).
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
    'max_search_calls_per_game', 'current_fact_max_age_hours', 'preferred_domains', 'blocked_domains', 'effort', 'web_search_tool_version', 'max_cited_facts', 'min_story_score',
    'automation_competitions', 'automation_retry_hours', 'automation_technical_retry_hours', 'status_refresh_enabled', 'status_refresh_window_hours'];
begin
  perform public.require_super_admin(p_admin_id);
  if p_config is null or jsonb_typeof(p_config) <> 'object' then raise exception 'invalid_config'; end if;
  for v_key in select jsonb_object_keys(p_config) loop
    if not (v_key = any (v_allowed)) then raise exception 'unknown_setting_%', v_key; end if;
  end loop;
  if p_config ? 'preferred_domains' and jsonb_typeof(p_config -> 'preferred_domains') <> 'array' then raise exception 'invalid_domains'; end if;
  if p_config ? 'blocked_domains' and jsonb_typeof(p_config -> 'blocked_domains') <> 'array' then raise exception 'invalid_domains'; end if;
  if p_config ? 'automation_competitions' and jsonb_typeof(p_config -> 'automation_competitions') <> 'array' then raise exception 'invalid_competitions'; end if;
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
    automation_retry_hours = coalesce((p_config ->> 'automation_retry_hours')::integer, automation_retry_hours),
    automation_technical_retry_hours = coalesce((p_config ->> 'automation_technical_retry_hours')::integer, automation_technical_retry_hours),
    status_refresh_enabled = coalesce((p_config ->> 'status_refresh_enabled')::boolean, status_refresh_enabled),
    status_refresh_window_hours = coalesce((p_config ->> 'status_refresh_window_hours')::integer, status_refresh_window_hours),
    preferred_domains = case when p_config ? 'preferred_domains' then array(select lower(btrim(x)) from jsonb_array_elements_text(p_config -> 'preferred_domains') x where btrim(x) <> '') else preferred_domains end,
    blocked_domains = case when p_config ? 'blocked_domains' then array(select lower(btrim(x)) from jsonb_array_elements_text(p_config -> 'blocked_domains') x where btrim(x) <> '') else blocked_domains end,
    automation_competitions = case when p_config ? 'automation_competitions' then array(select upper(btrim(x)) from jsonb_array_elements_text(p_config -> 'automation_competitions') x where btrim(x) <> '') else automation_competitions end,
    updated_by = p_admin_id, updated_at = now()
  where id = true returning * into v_after;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after) values (p_admin_id, 'settings.game_preview_updated', 'game_preview_config', null, to_jsonb(v_before), to_jsonb(v_after));
  return v_after;
end;
$$;
revoke all on function public.admin_set_game_preview_config(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_set_game_preview_config(uuid, jsonb) to service_role;
