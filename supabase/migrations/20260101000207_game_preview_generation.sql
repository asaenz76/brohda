-- Game Preview generation: configuration, claim provenance, usage observability.
--
-- Builds on migration 206. The automated producer of Previews is provider-neutral (research and writing are separate interfaces in code); everything that is tunable about it is stored configuration, never constants:
-- provider, model, web search on/off, whether generation may run automatically (OFF by default), lead time, stale window, minimum refresh interval, length limits, source policy, freshness window, attempts, batch size.
-- The model id is deliberately NOT given a default: generation refuses to run until a Super Admin sets it.
--
-- Provenance grows from "which sources" to "which claim rests on which source": game_previews.claims maps every material statement to the research facts (and so to the stored sources) that support it, and generation_meta
-- records provider / model / prompt version. Every automated attempt is recorded in game_preview_runs (usage, outcome, why it failed) so cost and quality can be observed from day one.

alter table public.game_preview_config
  add column generation_enabled           boolean not null default false,
  add column provider                     text    not null default 'openai' check (provider in ('openai')),
  add column model                        text    not null default '' check (char_length(model) <= 100),
  add column web_search_enabled           boolean not null default true,
  add column verify_with_model            boolean not null default true,
  add column max_attempts                 integer not null default 2 check (max_attempts between 1 and 5),
  add column max_games_per_run            integer not null default 3 check (max_games_per_run between 1 and 50),
  add column max_search_calls_per_game    integer not null default 8 check (max_search_calls_per_game between 1 and 50),
  add column current_fact_max_age_hours   integer not null default 72 check (current_fact_max_age_hours between 1 and 8760),
  add column preferred_domains            text[]  not null default array['nfl.com','nhl.com','nba.com','espn.com','apnews.com','reuters.com','theathletic.com','cbssports.com','si.com','foxsports.com','nbcsports.com','profootballreference.com','hockey-reference.com','basketball-reference.com'],
  add column blocked_domains              text[]  not null default array['reddit.com','x.com','twitter.com','facebook.com','instagram.com','tiktok.com','threads.net','truthsocial.com'];

alter table public.game_previews
  add column claims          jsonb not null default '[]'::jsonb check (jsonb_typeof(claims) = 'array' and jsonb_array_length(claims) <= 30),
  add column generation_meta jsonb not null default '{}'::jsonb check (jsonb_typeof(generation_meta) = 'object');
comment on column public.game_previews.claims is 'Every material statement of the Preview and the research fact ids that support it: [{text, fact_ids}]. Empty for a hand-written Preview.';
comment on column public.game_previews.generation_meta is 'Provider, model, prompt version and usage of the generation that produced this Preview ({} for a hand-written one).';

alter table public.game_preview_sources
  add column excerpt text check (excerpt is null or char_length(excerpt) <= 1000);
comment on column public.game_preview_sources.excerpt is 'The passage of the source that supports the claim (research fact), kept so a claim can be audited without re-reading the page.';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Usage and outcome of every automated (or admin-triggered) generation attempt.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table public.game_preview_runs (
  id             uuid primary key default gen_random_uuid(),
  fixture_id     uuid not null references public.fixtures (id) on delete cascade,
  trigger        text not null check (trigger in ('AUTOMATIC', 'ADMIN')),
  reason         text not null,
  status         text not null check (status in ('SUCCEEDED', 'FAILED', 'REJECTED')),
  provider       text not null,
  model          text not null,
  attempts       integer not null default 0 check (attempts >= 0),
  search_calls   integer not null default 0 check (search_calls >= 0),
  model_calls    integer not null default 0 check (model_calls >= 0),
  input_tokens   bigint  not null default 0 check (input_tokens >= 0),
  output_tokens  bigint  not null default 0 check (output_tokens >= 0),
  facts_found    integer not null default 0 check (facts_found >= 0),
  error          text,
  preview_id     uuid references public.game_previews (id) on delete set null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz not null default now()
);
create index game_preview_runs_started_at on public.game_preview_runs (started_at desc);
create index game_preview_runs_fixture on public.game_preview_runs (fixture_id, started_at desc);
alter table public.game_preview_runs enable row level security;
revoke all on public.game_preview_runs from anon, authenticated;
grant select, insert, update, delete on public.game_preview_runs to service_role;

create or replace function public.game_preview_usage_summary(p_since timestamptz default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with r as (select * from public.game_preview_runs where p_since is null or started_at >= p_since)
  select jsonb_build_object(
    'since', p_since,
    'gamesResearched', (select count(distinct fixture_id) from r),
    'runs', (select count(*) from r),
    'succeeded', (select count(*) from r where status = 'SUCCEEDED'),
    'failed', (select count(*) from r where status = 'FAILED'),
    'rejected', (select count(*) from r where status = 'REJECTED'),
    'regenerations', (select count(*) from r where reason <> 'MISSING' and status = 'SUCCEEDED'),
    'searchCalls', (select coalesce(sum(search_calls), 0) from r),
    'modelCalls', (select coalesce(sum(model_calls), 0) from r),
    'inputTokens', (select coalesce(sum(input_tokens), 0) from r),
    'outputTokens', (select coalesce(sum(output_tokens), 0) from r),
    'avgCallsPerSuccessfulPreview', (select case when count(*) = 0 then null else round(sum(search_calls + model_calls)::numeric / count(*), 2) end from r where status = 'SUCCEEDED'),
    'byProviderModel', coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'model', model, 'runs', n)) from (select provider, model, count(*) n from r group by provider, model order by n desc) x), '[]'::jsonb)
  );
$$;
revoke all on function public.game_preview_usage_summary(timestamptz) from public, anon, authenticated;
grant execute on function public.game_preview_usage_summary(timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Writing a Preview, version 2: the owner's refresh vocabulary (MISSING, STALE, MATERIAL_NEW_INFORMATION, MANUAL_ADMIN_REQUEST), the claim map and generation metadata.
-- Replaces the 206 function (same rules: configured limits, complete provenance, never after kickoff, a replaced Preview is kept).
-- ---------------------------------------------------------------------------------------------------------------------------------------------
drop function if exists public.upsert_game_preview(uuid, text, text, text, text, jsonb);

create or replace function public.upsert_game_preview(p_fixture_id uuid, p_hook text, p_body text, p_generated_by text, p_reason text, p_sources jsonb, p_claims jsonb default '[]'::jsonb, p_meta jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.game_preview_config;
  v_fixture record;
  v_hook text := btrim(coalesce(p_hook, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_existing public.game_previews;
  v_source jsonb;
  v_n integer := 0;
  v_preview_id uuid;
  v_outcome text;
  v_url text;
  v_retrieved timestamptz;
  v_published timestamptz;
begin
  select * into v_cfg from public.game_preview_config where id = true;
  select f.id, f.internal_status, f.scheduled_start_utc into v_fixture from public.fixtures f where f.id = p_fixture_id;
  if v_fixture.id is null then return jsonb_build_object('outcome', 'fixture_not_found'); end if;

  perform pg_advisory_xact_lock(hashtext('game_preview:' || p_fixture_id::text));

  if v_fixture.internal_status <> 'NOT_STARTED' or v_fixture.scheduled_start_utc <= now() then return jsonb_build_object('outcome', 'game_started'); end if;
  if p_reason is null or p_reason not in ('MISSING', 'STALE', 'MATERIAL_NEW_INFORMATION', 'MANUAL_ADMIN_REQUEST') then return jsonb_build_object('outcome', 'invalid_reason'); end if;
  if v_hook = '' or v_body = '' then return jsonb_build_object('outcome', 'invalid_text'); end if;
  if char_length(v_hook) > v_cfg.hook_max_chars then return jsonb_build_object('outcome', 'hook_too_long', 'max', v_cfg.hook_max_chars); end if;
  if char_length(v_body) > v_cfg.max_chars then return jsonb_build_object('outcome', 'body_too_long', 'max', v_cfg.max_chars); end if;
  if p_generated_by is null or btrim(p_generated_by) = '' then return jsonb_build_object('outcome', 'invalid_generator'); end if;
  if p_claims is null or jsonb_typeof(p_claims) <> 'array' or jsonb_array_length(p_claims) > 30 then return jsonb_build_object('outcome', 'invalid_claims'); end if;
  if p_meta is null or jsonb_typeof(p_meta) <> 'object' then return jsonb_build_object('outcome', 'invalid_meta'); end if;

  if p_sources is null or jsonb_typeof(p_sources) <> 'array' or jsonb_array_length(p_sources) not between 1 and 12 then return jsonb_build_object('outcome', 'invalid_sources'); end if;
  for v_source in select * from jsonb_array_elements(p_sources) loop
    v_url := v_source ->> 'url';
    begin
      v_retrieved := (v_source ->> 'retrieved_at')::timestamptz;
      v_published := nullif(v_source ->> 'published_at', '')::timestamptz;
    exception when others then
      return jsonb_build_object('outcome', 'invalid_sources');
    end;
    if v_url is null or v_url !~* '^https?://[^[:space:]]+$'
       or nullif(btrim(coalesce(v_source ->> 'provider', '')), '') is null
       or nullif(btrim(coalesce(v_source ->> 'title', '')), '') is null
       or v_retrieved is null or v_retrieved > now() + interval '5 minutes'
       or char_length(coalesce(v_source ->> 'excerpt', '')) > 1000 then
      return jsonb_build_object('outcome', 'invalid_sources');
    end if;
  end loop;

  select * into v_existing from public.game_previews where fixture_id = p_fixture_id for update;

  if v_existing.id is null then
    if p_reason <> 'MISSING' then return jsonb_build_object('outcome', 'no_existing_preview'); end if;
    insert into public.game_previews (fixture_id, hook, body, generated_by, claims, generation_meta) values (p_fixture_id, v_hook, v_body, btrim(p_generated_by), p_claims, p_meta) returning id into v_preview_id;
    v_outcome := 'created';
  else
    if v_existing.frozen_at is not null then return jsonb_build_object('outcome', 'frozen'); end if;
    if v_existing.status = 'WITHDRAWN' then
      if p_reason <> 'MISSING' then return jsonb_build_object('outcome', 'no_existing_preview'); end if;
    elsif p_reason = 'MISSING' then
      return jsonb_build_object('outcome', 'already_exists');
    elsif p_reason = 'STALE' and v_existing.checked_at > now() - make_interval(hours => v_cfg.stale_after_hours) then
      return jsonb_build_object('outcome', 'not_stale');
    elsif p_reason = 'MATERIAL_NEW_INFORMATION' and v_existing.generated_at > now() - make_interval(hours => v_cfg.min_refresh_interval_hours) then
      return jsonb_build_object('outcome', 'too_soon');
    end if;
    insert into public.game_preview_revisions (preview_id, hook, body, generated_by, generated_at, checked_at, sources, replaced_reason)
    select v_existing.id, v_existing.hook, v_existing.body, v_existing.generated_by, v_existing.generated_at, v_existing.checked_at,
           coalesce((select jsonb_agg(jsonb_build_object('url', s.url, 'provider', s.provider, 'title', s.title, 'published_at', s.published_at, 'retrieved_at', s.retrieved_at, 'supports', s.supports, 'excerpt', s.excerpt) order by s.position)
                     from public.game_preview_sources s where s.preview_id = v_existing.id), '[]'::jsonb),
           p_reason;
    delete from public.game_preview_sources where preview_id = v_existing.id;
    update public.game_previews
       set hook = v_hook, body = v_body, generated_by = btrim(p_generated_by), generated_at = now(), checked_at = now(), status = 'PUBLISHED', withdrawn_reason = null,
           claims = p_claims, generation_meta = p_meta, refresh_count = refresh_count + 1
     where id = v_existing.id;
    v_preview_id := v_existing.id;
    v_outcome := 'refreshed';
  end if;

  for v_source in select * from jsonb_array_elements(p_sources) loop
    insert into public.game_preview_sources (preview_id, position, url, provider, title, published_at, retrieved_at, supports, excerpt)
    values (v_preview_id, v_n, v_source ->> 'url', btrim(v_source ->> 'provider'), btrim(v_source ->> 'title'), nullif(v_source ->> 'published_at', '')::timestamptz, (v_source ->> 'retrieved_at')::timestamptz,
            nullif(btrim(coalesce(v_source ->> 'supports', '')), ''), nullif(btrim(coalesce(v_source ->> 'excerpt', '')), ''));
    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('outcome', v_outcome, 'previewId', v_preview_id);
end;
$$;
revoke all on function public.upsert_game_preview(uuid, text, text, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_game_preview(uuid, text, text, text, text, jsonb, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Operator actions: configuration (extended) and a manual text edit that keeps the stored sources and claims untouched. Both audited.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
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
  v_allowed text[] := array['max_chars', 'hook_max_chars', 'lead_hours', 'stale_after_hours', 'min_refresh_interval_hours', 'generation_enabled', 'provider', 'model', 'web_search_enabled', 'verify_with_model', 'max_attempts', 'max_games_per_run', 'max_search_calls_per_game', 'current_fact_max_age_hours', 'preferred_domains', 'blocked_domains'];
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

create or replace function public.admin_edit_game_preview(p_admin_id uuid, p_fixture_id uuid, p_hook text, p_body text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.game_preview_config;
  v_preview public.game_previews;
  v_fixture record;
  v_hook text := btrim(coalesce(p_hook, ''));
  v_body text := btrim(coalesce(p_body, ''));
begin
  perform public.require_super_admin(p_admin_id);
  if p_note is null or btrim(p_note) = '' then raise exception 'note_required'; end if;
  select * into v_cfg from public.game_preview_config where id = true;
  select f.internal_status, f.scheduled_start_utc into v_fixture from public.fixtures f where f.id = p_fixture_id;
  if v_fixture.internal_status is null then return jsonb_build_object('outcome', 'fixture_not_found'); end if;
  select * into v_preview from public.game_previews where fixture_id = p_fixture_id for update;
  if v_preview.id is null then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_preview.frozen_at is not null or v_fixture.internal_status <> 'NOT_STARTED' or v_fixture.scheduled_start_utc <= now() then return jsonb_build_object('outcome', 'game_started'); end if;
  if v_hook = '' or v_body = '' then return jsonb_build_object('outcome', 'invalid_text'); end if;
  if char_length(v_hook) > v_cfg.hook_max_chars then return jsonb_build_object('outcome', 'hook_too_long', 'max', v_cfg.hook_max_chars); end if;
  if char_length(v_body) > v_cfg.max_chars then return jsonb_build_object('outcome', 'body_too_long', 'max', v_cfg.max_chars); end if;
  insert into public.game_preview_revisions (preview_id, hook, body, generated_by, generated_at, checked_at, sources, replaced_reason)
  select v_preview.id, v_preview.hook, v_preview.body, v_preview.generated_by, v_preview.generated_at, v_preview.checked_at,
         coalesce((select jsonb_agg(jsonb_build_object('url', s.url, 'provider', s.provider, 'title', s.title, 'published_at', s.published_at, 'retrieved_at', s.retrieved_at, 'supports', s.supports, 'excerpt', s.excerpt) order by s.position)
                   from public.game_preview_sources s where s.preview_id = v_preview.id), '[]'::jsonb),
         'MANUAL_ADMIN_REQUEST';
  update public.game_previews
     set hook = v_hook, body = v_body, generated_by = 'admin:' || p_admin_id::text, status = 'PUBLISHED', withdrawn_reason = null, refresh_count = refresh_count + 1,
         generation_meta = generation_meta || jsonb_build_object('manualEdit', true, 'editedBy', p_admin_id, 'editedAt', now())
   where id = v_preview.id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (p_admin_id, 'game_preview.edited', 'game_previews', v_preview.id, jsonb_build_object('hook', v_preview.hook, 'body', v_preview.body), jsonb_build_object('hook', v_hook, 'body', v_body, 'note', btrim(p_note)));
  return jsonb_build_object('outcome', 'edited', 'previewId', v_preview.id);
end;
$$;
revoke all on function public.admin_edit_game_preview(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_edit_game_preview(uuid, uuid, text, text, text) to service_role;
