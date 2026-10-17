-- Game Previews: the editorial purpose of an opened Game Post.
--
-- FEED = PREDICT, POST = GAME PREVIEW + CONVERSATION. A Preview is a short HOOK and a short factual PREVIEW story about one Game, researched and written
-- ahead of time (never when a Member opens the Post), stored with the sources it rests on, and read by the Post. Nothing here touches Picks, Confidence,
-- Markets or Sponsors.
--
--   game_preview_config        one row of configuration (lengths, how early a Game is prepared, when a Preview is stale, the minimum gap between refreshes) — nothing is hard-coded in code
--   game_previews              the CURRENT Preview of a Game (one per fixture), its generator, when it was written and last verified, and when it was frozen (kickoff)
--   game_preview_sources       the provenance of that Preview: URL, provider, title, publication time, retrieval time — auditable, not shown to Members by default
--   game_preview_revisions     every Preview that a refresh replaced (text, sources, why it was replaced)
--
-- Writes go through ONE validated service-role function (upsert_game_preview): it refuses text over the configured limits, a Preview without sources, a Game that has started (the pregame Preview is then frozen and never
-- rewritten), and a refresh with no reason (missing / stale / new verified story / correction). No Member or anonymous role can read or write any of these tables directly; the Post reads through the server.

create table public.game_preview_config (
  id                          boolean primary key default true check (id),
  max_chars                   integer not null default 700 check (max_chars between 100 and 2000),
  hook_max_chars              integer not null default 120 check (hook_max_chars between 20 and 300),
  lead_hours                  integer not null default 48 check (lead_hours between 1 and 720),
  stale_after_hours           integer not null default 36 check (stale_after_hours between 1 and 720),
  min_refresh_interval_hours  integer not null default 6 check (min_refresh_interval_hours between 0 and 720),
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references auth.users (id) on delete set null
);
comment on table public.game_preview_config is 'One row. How long a Game Preview may be, how early a Game is prepared, when a stored Preview counts as stale and how often it may be refreshed. Changed only through admin_set_game_preview_config (Super Admin, audited).';
insert into public.game_preview_config (id) values (true);
alter table public.game_preview_config enable row level security;
revoke all on public.game_preview_config from anon, authenticated;
grant select, insert, update, delete on public.game_preview_config to service_role;

create table public.game_previews (
  id             uuid primary key default gen_random_uuid(),
  fixture_id     uuid not null unique references public.fixtures (id) on delete cascade,
  hook           text not null check (char_length(btrim(hook)) > 0),
  body           text not null check (char_length(btrim(body)) > 0),
  status         text not null default 'PUBLISHED' check (status in ('PUBLISHED', 'WITHDRAWN')),
  generated_by   text not null check (char_length(btrim(generated_by)) > 0),
  generated_at   timestamptz not null default now(),
  checked_at     timestamptz not null default now(),
  refresh_count  integer not null default 0 check (refresh_count >= 0),
  frozen_at      timestamptz,
  withdrawn_reason text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create trigger game_previews_set_updated_at before update on public.game_previews for each row execute function public.set_updated_at();
alter table public.game_previews enable row level security;
revoke all on public.game_previews from anon, authenticated;
grant select, insert, update, delete on public.game_previews to service_role;

create table public.game_preview_sources (
  id            uuid primary key default gen_random_uuid(),
  preview_id    uuid not null references public.game_previews (id) on delete cascade,
  position      integer not null check (position >= 0),
  url           text not null check (url ~* '^https?://[^[:space:]]+$'),
  provider      text not null check (char_length(btrim(provider)) between 1 and 300),
  title         text not null check (char_length(btrim(title)) between 1 and 500),
  published_at  timestamptz,
  retrieved_at  timestamptz not null,
  supports      text check (supports is null or char_length(supports) <= 500),
  unique (preview_id, position)
);
alter table public.game_preview_sources enable row level security;
revoke all on public.game_preview_sources from anon, authenticated;
grant select, insert, update, delete on public.game_preview_sources to service_role;

create table public.game_preview_revisions (
  id               uuid primary key default gen_random_uuid(),
  preview_id       uuid not null references public.game_previews (id) on delete cascade,
  hook             text not null,
  body             text not null,
  generated_by     text not null,
  generated_at     timestamptz not null,
  checked_at       timestamptz not null,
  sources          jsonb not null,
  replaced_reason  text not null,
  replaced_at      timestamptz not null default now()
);
alter table public.game_preview_revisions enable row level security;
revoke all on public.game_preview_revisions from anon, authenticated;
grant select, insert, update, delete on public.game_preview_revisions to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Writing a Preview: validated, race-safe, never after kickoff.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.upsert_game_preview(p_fixture_id uuid, p_hook text, p_body text, p_generated_by text, p_reason text, p_sources jsonb)
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

  -- The pregame Preview is frozen once the Game starts: nothing writes it after kickoff.
  if v_fixture.internal_status <> 'NOT_STARTED' or v_fixture.scheduled_start_utc <= now() then return jsonb_build_object('outcome', 'game_started'); end if;
  if p_reason is null or p_reason not in ('MISSING', 'STALE', 'NEW_STORY', 'CORRECTION') then return jsonb_build_object('outcome', 'invalid_reason'); end if;
  if v_hook = '' or v_body = '' then return jsonb_build_object('outcome', 'invalid_text'); end if;
  if char_length(v_hook) > v_cfg.hook_max_chars then return jsonb_build_object('outcome', 'hook_too_long', 'max', v_cfg.hook_max_chars); end if;
  if char_length(v_body) > v_cfg.max_chars then return jsonb_build_object('outcome', 'body_too_long', 'max', v_cfg.max_chars); end if;
  if p_generated_by is null or btrim(p_generated_by) = '' then return jsonb_build_object('outcome', 'invalid_generator'); end if;

  -- Provenance is required, and every source must be complete (URL, provider, title, retrieval time).
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
       or v_retrieved is null or v_retrieved > now() + interval '5 minutes' then
      return jsonb_build_object('outcome', 'invalid_sources');
    end if;
  end loop;

  select * into v_existing from public.game_previews where fixture_id = p_fixture_id for update;

  if v_existing.id is null then
    if p_reason <> 'MISSING' then return jsonb_build_object('outcome', 'no_existing_preview'); end if;
    insert into public.game_previews (fixture_id, hook, body, generated_by) values (p_fixture_id, v_hook, v_body, btrim(p_generated_by)) returning id into v_preview_id;
    v_outcome := 'created';
  else
    if v_existing.frozen_at is not null then return jsonb_build_object('outcome', 'frozen'); end if;
    if v_existing.status = 'WITHDRAWN' then
      if p_reason <> 'MISSING' then return jsonb_build_object('outcome', 'no_existing_preview'); end if;
    elsif p_reason = 'MISSING' then
      return jsonb_build_object('outcome', 'already_exists');
    elsif p_reason = 'STALE' and v_existing.checked_at > now() - make_interval(hours => v_cfg.stale_after_hours) then
      return jsonb_build_object('outcome', 'not_stale');
    elsif p_reason = 'NEW_STORY' and v_existing.generated_at > now() - make_interval(hours => v_cfg.min_refresh_interval_hours) then
      return jsonb_build_object('outcome', 'too_soon');
    end if;
    -- Keep what is being replaced.
    insert into public.game_preview_revisions (preview_id, hook, body, generated_by, generated_at, checked_at, sources, replaced_reason)
    select v_existing.id, v_existing.hook, v_existing.body, v_existing.generated_by, v_existing.generated_at, v_existing.checked_at,
           coalesce((select jsonb_agg(jsonb_build_object('url', s.url, 'provider', s.provider, 'title', s.title, 'published_at', s.published_at, 'retrieved_at', s.retrieved_at, 'supports', s.supports) order by s.position)
                     from public.game_preview_sources s where s.preview_id = v_existing.id), '[]'::jsonb),
           p_reason;
    delete from public.game_preview_sources where preview_id = v_existing.id;
    update public.game_previews
       set hook = v_hook, body = v_body, generated_by = btrim(p_generated_by), generated_at = now(), checked_at = now(), status = 'PUBLISHED', withdrawn_reason = null,
           refresh_count = refresh_count + 1
     where id = v_existing.id;
    v_preview_id := v_existing.id;
    v_outcome := 'refreshed';
  end if;

  for v_source in select * from jsonb_array_elements(p_sources) loop
    insert into public.game_preview_sources (preview_id, position, url, provider, title, published_at, retrieved_at, supports)
    values (v_preview_id, v_n, v_source ->> 'url', btrim(v_source ->> 'provider'), btrim(v_source ->> 'title'), nullif(v_source ->> 'published_at', '')::timestamptz, (v_source ->> 'retrieved_at')::timestamptz, nullif(btrim(coalesce(v_source ->> 'supports', '')), ''));
    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('outcome', v_outcome, 'previewId', v_preview_id);
end;
$$;
revoke all on function public.upsert_game_preview(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_game_preview(uuid, text, text, text, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Freezing: once a Game has started its pregame Preview is final (the Post keeps showing it; nothing rewrites it).
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.freeze_started_game_previews()
returns integer
language sql
security definer
set search_path = public
as $$
  with frozen as (
    update public.game_previews p set frozen_at = now()
      from public.fixtures f
     where f.id = p.fixture_id and p.frozen_at is null and (f.internal_status <> 'NOT_STARTED' or f.scheduled_start_utc <= now())
    returning p.id
  )
  select count(*)::integer from frozen;
$$;
revoke all on function public.freeze_started_game_previews() from public, anon, authenticated;
grant execute on function public.freeze_started_game_previews() to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- What needs a Preview: published Posts whose Game has not started and starts within the configured lead time, with no Preview (or a withdrawn one), or one whose last verification is older than the stale window.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.game_preview_candidates()
returns table (fixture_id uuid, post_id uuid, home_team_name text, away_team_name text, competition_name text, scheduled_start_utc timestamptz, reason text, last_checked_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, po.id, f.home_team_name, f.away_team_name, f.competition_name, f.scheduled_start_utc,
         case when gp.id is null or gp.status = 'WITHDRAWN' then 'MISSING' else 'STALE' end,
         gp.checked_at
    from public.posts po
    join public.fixtures f on f.id = po.fixture_id
    cross join public.game_preview_config c
    left join public.game_previews gp on gp.fixture_id = f.id
   where po.published_at is not null
     and f.internal_status = 'NOT_STARTED'
     and f.scheduled_start_utc > now()
     and f.scheduled_start_utc <= now() + make_interval(hours => c.lead_hours)
     and (gp.id is null or gp.status = 'WITHDRAWN' or (gp.frozen_at is null and gp.checked_at <= now() - make_interval(hours => c.stale_after_hours)))
   order by f.scheduled_start_utc;
$$;
revoke all on function public.game_preview_candidates() from public, anon, authenticated;
grant execute on function public.game_preview_candidates() to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Operator actions (Super Admin, audited): change the configuration, withdraw a Preview that turned out to be wrong.
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
  v_allowed text[] := array['max_chars', 'hook_max_chars', 'lead_hours', 'stale_after_hours', 'min_refresh_interval_hours'];
begin
  perform public.require_super_admin(p_admin_id);
  if p_config is null or jsonb_typeof(p_config) <> 'object' then raise exception 'invalid_config'; end if;
  for v_key in select jsonb_object_keys(p_config) loop
    if not (v_key = any (v_allowed)) then raise exception 'unknown_setting_%', v_key; end if;
  end loop;
  select * into v_before from public.game_preview_config where id = true for update;
  update public.game_preview_config set
    max_chars = coalesce((p_config ->> 'max_chars')::integer, max_chars),
    hook_max_chars = coalesce((p_config ->> 'hook_max_chars')::integer, hook_max_chars),
    lead_hours = coalesce((p_config ->> 'lead_hours')::integer, lead_hours),
    stale_after_hours = coalesce((p_config ->> 'stale_after_hours')::integer, stale_after_hours),
    min_refresh_interval_hours = coalesce((p_config ->> 'min_refresh_interval_hours')::integer, min_refresh_interval_hours),
    updated_by = p_admin_id, updated_at = now()
  where id = true returning * into v_after;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after) values (p_admin_id, 'settings.game_preview_updated', 'game_preview_config', null, to_jsonb(v_before), to_jsonb(v_after));
  return v_after;
end;
$$;
revoke all on function public.admin_set_game_preview_config(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_set_game_preview_config(uuid, jsonb) to service_role;

create or replace function public.admin_withdraw_game_preview(p_admin_id uuid, p_fixture_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_preview public.game_previews;
begin
  perform public.require_super_admin(p_admin_id);
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason_required'; end if;
  select * into v_preview from public.game_previews where fixture_id = p_fixture_id for update;
  if v_preview.id is null then return jsonb_build_object('outcome', 'not_found'); end if;
  update public.game_previews set status = 'WITHDRAWN', withdrawn_reason = btrim(p_reason) where id = v_preview.id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (p_admin_id, 'game_preview.withdrawn', 'game_previews', v_preview.id, jsonb_build_object('status', v_preview.status, 'hook', v_preview.hook), jsonb_build_object('status', 'WITHDRAWN', 'reason', btrim(p_reason)));
  return jsonb_build_object('outcome', 'withdrawn', 'previewId', v_preview.id);
end;
$$;
revoke all on function public.admin_withdraw_game_preview(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_withdraw_game_preview(uuid, uuid, text) to service_role;
