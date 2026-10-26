-- Brohda 2.1 M3 — Game Story Engine (research → verified claims → scored candidate → Admin approval → canonical Post).
--
-- WHAT THIS ADDS (all additive; nothing existing changes meaning, no row of any existing table is rewritten):
--   game_story_config          one row of configuration. Generation is OFF and auto-publish is OFF (and auto-publish is hard-locked off by a CHECK until a later, explicitly authorised migration).
--   game_story_runs            one attempt to research/write a story for a Game: status, model/prompt version, the candidate, its five rubric dimensions and the total (COMPUTED here, never trusted from the model), the decision and why.
--   game_story_evidence        the normalised evidence a run collected (source, publisher, title, dates, type, the normalised fact, a short excerpt) — metadata and paraphrase, never an article copy.
--   game_story_claims          the atomic factual claims of a candidate, each with a verdict; game_story_claim_evidence says which evidence supports which claim.
--   game_story_revisions       the versions of a Game's story copy (hook + body). Generated or Admin-edited. At most ONE revision per Game is APPROVED; older approved copy is kept as SUPERSEDED.
--   posts.story_revision_id    the Game's canonical Post points at its one approved revision. No second Post is ever created.
--
-- INVARIANTS ENFORCED IN THE DATABASE (not only in application code):
--   * hook + body must fit the configured limit (game_story_config.max_chars) — trigger on every revision insert, re-checked at approval.
--   * total score = relevance(0-30) + evidence(0-25) + debate(0-20) + originality(0-15) + freshness(0-10): a GENERATED column; the model's own total is never stored.
--   * a candidate can only be saved as ACCEPTED with at least one claim, every claim SUPPORTED, and a total at or above the configured minimum; otherwise it is REJECTED and nothing reaches a revision.
--   * only one active run per Game (partial unique index), run status transitions are legal-only, copy of a revision is immutable (an edit is a NEW revision that must be re-verified before approval).
--   * approval is the only way a story reaches the Post; it is serialised on the Post row, audited, supersedes (never deletes) the previous approved revision.
--   * nothing here can be deleted (append-only triggers); no client role can read or write any of it (RLS on, no policy, privileges revoked); every function is service-role only.
-- The migration alone starts no job and publishes nothing.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table public.game_story_config (
  id                          boolean primary key default true check (id),
  generation_enabled          boolean not null default false,
  auto_publish_enabled        boolean not null default false,
  provider                    text not null default 'anthropic' check (provider in ('anthropic')),
  model                       text not null default 'claude-haiku-5-5' check (char_length(model) between 1 and 100),
  effort                      text not null default 'medium' check (effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  web_search_tool_version     text not null default 'web_search_20250305' check (web_search_tool_version in ('web_search_20250305', 'web_search_20260209', 'web_search_20260318')),
  web_search_enabled          boolean not null default true,
  max_chars                   integer not null default 300 check (max_chars between 100 and 1000),
  min_score                   integer not null default 80 check (min_score between 0 and 100),
  research_window_hours       integer not null default 48 check (research_window_hours between 1 and 336),
  refresh_interval_minutes    integer not null default 360 check (refresh_interval_minutes between 15 and 10080),
  editorial_cutoff_minutes    integer not null default 120 check (editorial_cutoff_minutes between 0 and 1440),
  max_queries_per_game        integer not null default 6 check (max_queries_per_game between 0 and 30),
  max_sources                 integer not null default 12 check (max_sources between 1 and 40),
  max_attempts                integer not null default 2 check (max_attempts between 1 and 5),
  provider_retries            integer not null default 1 check (provider_retries between 0 and 3),
  request_timeout_seconds     integer not null default 120 check (request_timeout_seconds between 10 and 290),
  max_games_per_run           integer not null default 2 check (max_games_per_run between 1 and 20),
  max_runs_per_game           integer not null default 3 check (max_runs_per_game between 1 and 20),
  status_max_age_hours        integer not null default 48 check (status_max_age_hours between 1 and 720),
  current_fact_max_age_hours  integer not null default 168 check (current_fact_max_age_hours between 1 and 8760),
  supported_sports            text[] not null default array['american_football', 'basketball', 'hockey']
                              check (supported_sports <@ array['american_football', 'basketball', 'hockey', 'baseball']::text[] and array_position(supported_sports, null) is null),
  preferred_domains           text[] not null default '{}' check (array_position(preferred_domains, null) is null),
  blocked_domains             text[] not null default '{}' check (array_position(blocked_domains, null) is null),
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references public.user_profiles (id),
  -- M3 does not authorise automatic publishing. The flag exists so the policy is explicit and auditable; this CHECK keeps it false until a later migration deliberately relaxes it.
  constraint game_story_auto_publish_locked check (auto_publish_enabled = false)
);
comment on table public.game_story_config is 'One row. Game story engine limits and switches. Changed only through admin_set_game_story_config (Super Admin, audited). generation_enabled and auto_publish_enabled default to false; auto_publish_enabled is locked false by a CHECK in M3.';
insert into public.game_story_config (id) values (true);

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table public.game_story_runs (
  id                   uuid primary key default gen_random_uuid(),
  fixture_id           uuid not null references public.fixtures (id),
  trigger_kind         text not null check (trigger_kind in ('SCHEDULED', 'ADMIN', 'REGENERATE')),
  requested_by         uuid references public.user_profiles (id),
  status               text not null default 'PENDING'
                       check (status in ('PENDING', 'RESEARCHING', 'CANDIDATE_GENERATED', 'REJECTED', 'REVIEW_REQUIRED', 'APPROVED', 'SUPERSEDED', 'FAILED')),
  provider             text,
  model                text,
  effort               text,
  prompt_version       text,
  research_version     text,
  config_snapshot      jsonb not null default '{}'::jsonb,
  started_at           timestamptz not null default now(),
  heartbeat_at         timestamptz not null default now(),
  completed_at         timestamptz,
  decision             text check (decision in ('ACCEPTED', 'REJECTED', 'NO_STORY')),
  rejection_code       text check (rejection_code is null or char_length(rejection_code) <= 60),
  rejection_detail     text check (rejection_detail is null or char_length(rejection_detail) <= 1000),
  candidate_hook       text check (candidate_hook is null or char_length(candidate_hook) <= 400),
  candidate_body       text check (candidate_body is null or char_length(candidate_body) <= 2000),
  dim_relevance        smallint check (dim_relevance between 0 and 30),
  dim_evidence         smallint check (dim_evidence between 0 and 25),
  dim_debate           smallint check (dim_debate between 0 and 20),
  dim_originality      smallint check (dim_originality between 0 and 15),
  dim_freshness        smallint check (dim_freshness between 0 and 10),
  -- Brohda's arithmetic, not the model's: NULL until all five dimensions exist.
  total_score          smallint generated always as (dim_relevance + dim_evidence + dim_debate + dim_originality + dim_freshness) stored,
  min_score_applied    smallint,
  queries_used         integer not null default 0 check (queries_used >= 0),
  sources_kept         integer not null default 0 check (sources_kept >= 0),
  model_calls          integer not null default 0 check (model_calls >= 0),
  search_calls         integer not null default 0 check (search_calls >= 0),
  input_tokens         bigint not null default 0 check (input_tokens >= 0),
  output_tokens        bigint not null default 0 check (output_tokens >= 0),
  elapsed_ms           integer,
  error_category       text check (error_category is null or char_length(error_category) <= 60),
  details              jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now()
);
create index game_story_runs_fixture_idx on public.game_story_runs (fixture_id, started_at desc);
create index game_story_runs_status_idx on public.game_story_runs (status, started_at desc);
-- Concurrency: at most one active run per Game, enforced by the database.
create unique index game_story_runs_one_active on public.game_story_runs (fixture_id) where status in ('PENDING', 'RESEARCHING', 'CANDIDATE_GENERATED');

create or replace function public.game_story_runs_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.fixture_id is distinct from old.fixture_id or new.trigger_kind is distinct from old.trigger_kind then
      raise exception 'game_story_run_identity_immutable';
    end if;
    if new.status is distinct from old.status and not (
         (old.status = 'PENDING'             and new.status in ('RESEARCHING', 'FAILED'))
      or (old.status = 'RESEARCHING'         and new.status in ('CANDIDATE_GENERATED', 'REJECTED', 'REVIEW_REQUIRED', 'FAILED'))
      or (old.status = 'CANDIDATE_GENERATED' and new.status in ('REJECTED', 'REVIEW_REQUIRED', 'FAILED'))
      or (old.status = 'REVIEW_REQUIRED'     and new.status in ('APPROVED', 'REJECTED', 'SUPERSEDED'))
      or (old.status = 'APPROVED'            and new.status = 'SUPERSEDED')) then
      raise exception 'illegal_game_story_run_transition: % -> %', old.status, new.status;
    end if;
    -- a finished run's candidate and score never change afterwards
    if old.status in ('REJECTED', 'REVIEW_REQUIRED', 'APPROVED', 'SUPERSEDED', 'FAILED')
       and (new.candidate_hook is distinct from old.candidate_hook or new.candidate_body is distinct from old.candidate_body
            or new.dim_relevance is distinct from old.dim_relevance or new.dim_evidence is distinct from old.dim_evidence or new.dim_debate is distinct from old.dim_debate
            or new.dim_originality is distinct from old.dim_originality or new.dim_freshness is distinct from old.dim_freshness) then
      raise exception 'game_story_run_result_immutable';
    end if;
  end if;
  return new;
end;
$$;
create trigger game_story_runs_guard_trg before update on public.game_story_runs for each row execute function public.game_story_runs_guard();

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Evidence, claims, revisions
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table public.game_story_evidence (
  id              uuid primary key,
  run_id          uuid not null references public.game_story_runs (id),
  fixture_id      uuid not null references public.fixtures (id),
  position        smallint not null default 0,
  source_kind     text not null check (source_kind in ('STRUCTURED_DATA', 'OFFICIAL_LEAGUE', 'OFFICIAL_TEAM', 'MAJOR_JOURNALISM', 'LOCAL_JOURNALISM', 'OTHER_REPORTING')),
  authority       smallint not null check (authority between 0 and 100),
  canonical_id    text not null check (char_length(canonical_id) between 1 and 600),
  url             text check (url is null or char_length(url) <= 600),
  publisher       text not null check (char_length(publisher) between 1 and 200),
  title           text check (title is null or char_length(title) <= 400),
  published_at    timestamptz,
  retrieved_at    timestamptz not null default now(),
  evidence_type   text not null check (evidence_type in ('STRUCTURED', 'ARTICLE', 'OFFICIAL_STATEMENT')),
  fact_key        text check (fact_key is null or char_length(fact_key) <= 200),
  fact_value      text check (fact_value is null or char_length(fact_value) <= 100),
  subject_team    text not null default 'NEITHER' check (subject_team in ('HOME', 'AWAY', 'BOTH', 'NEITHER')),
  fact_text       text not null check (char_length(fact_text) between 1 and 600),
  excerpt         text check (excerpt is null or char_length(excerpt) <= 400),
  as_of           timestamptz,
  status          text not null default 'USABLE' check (status in ('USABLE', 'SUPERSEDED', 'CONFLICTED', 'SUSPICIOUS', 'DROPPED')),
  status_reason   text check (status_reason is null or char_length(status_reason) <= 300)
);
create index game_story_evidence_run_idx on public.game_story_evidence (run_id, position);
create unique index game_story_evidence_unique_fact on public.game_story_evidence (run_id, canonical_id, md5(fact_text));

create table public.game_story_revisions (
  id                     uuid primary key default gen_random_uuid(),
  fixture_id             uuid not null references public.fixtures (id),
  post_id                uuid references public.posts (id),
  run_id                 uuid references public.game_story_runs (id),
  parent_revision_id     uuid references public.game_story_revisions (id),
  source                 text not null check (source in ('GENERATED', 'ADMIN_EDIT')),
  status                 text not null default 'REVIEW_REQUIRED' check (status in ('REVIEW_REQUIRED', 'APPROVED', 'SUPERSEDED', 'REJECTED', 'WITHDRAWN')),
  hook                   text not null check (char_length(btrim(hook)) between 5 and 200),
  body                   text not null check (char_length(btrim(body)) between 20 and 800),
  char_count             integer generated always as (char_length(hook) + char_length(body)) stored,
  total_score            smallint check (total_score between 0 and 100),
  requires_verification  boolean not null default false,
  created_by             uuid references public.user_profiles (id),
  created_at             timestamptz not null default now(),
  approved_by            uuid references public.user_profiles (id),
  approved_at            timestamptz,
  rejected_by            uuid references public.user_profiles (id),
  rejected_at            timestamptz,
  rejection_reason       text check (rejection_reason is null or char_length(rejection_reason) <= 1000),
  withdrawn_by           uuid references public.user_profiles (id),
  withdrawn_at           timestamptz,
  withdrawn_reason       text check (withdrawn_reason is null or char_length(withdrawn_reason) <= 1000),
  constraint game_story_revisions_approval_audited check (status <> 'APPROVED' or (approved_by is not null and approved_at is not null))
);
create index game_story_revisions_fixture_idx on public.game_story_revisions (fixture_id, created_at desc);
create index game_story_revisions_status_idx on public.game_story_revisions (status, created_at desc);
-- THE invariant: one current approved story per Game.
create unique index game_story_revisions_one_approved on public.game_story_revisions (fixture_id) where status = 'APPROVED';

alter table public.posts add column story_revision_id uuid references public.game_story_revisions (id);
comment on column public.posts.story_revision_id is 'The Game''s one currently approved story revision (game_story_revisions). Written only by approve_game_story_revision / withdraw_game_story. NULL = no M3 story; the Post renders exactly as before.';

create table public.game_story_claims (
  id                  uuid primary key,
  run_id              uuid not null references public.game_story_runs (id),
  revision_id         uuid references public.game_story_revisions (id),
  position            smallint not null default 0,
  claim_text          text not null check (char_length(claim_text) between 1 and 400),
  claim_type          text not null check (claim_type in ('STAT', 'STREAK', 'HISTORY', 'AVAILABILITY', 'QUOTE', 'TRANSACTION', 'RESULT', 'CONTEXT')),
  subject_team        text check (subject_team is null or subject_team in ('HOME', 'AWAY', 'BOTH', 'NEITHER')),
  availability_status text check (availability_status is null or char_length(availability_status) <= 30),
  quote_text          text check (quote_text is null or char_length(quote_text) <= 400),
  verdict             text not null default 'PENDING' check (verdict in ('PENDING', 'SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED', 'STALE', 'AMBIGUOUS')),
  deterministic_ok    boolean,
  model_verdict       text check (model_verdict is null or char_length(model_verdict) <= 30),
  verification_note   text check (verification_note is null or char_length(verification_note) <= 500)
);
create index game_story_claims_run_idx on public.game_story_claims (run_id, position);
create index game_story_claims_revision_idx on public.game_story_claims (revision_id);

create table public.game_story_claim_evidence (
  claim_id     uuid not null references public.game_story_claims (id),
  evidence_id  uuid not null references public.game_story_evidence (id),
  primary key (claim_id, evidence_id)
);

-- Copy limits and append-only behaviour (enforced here so no writer can bypass them).
create or replace function public.game_story_revisions_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_max integer;
begin
  if tg_op = 'INSERT' then
    select max_chars into v_max from public.game_story_config where id = true;
    if char_length(new.hook) + char_length(new.body) > v_max then
      raise exception 'game_story_over_length: % characters, limit %', char_length(new.hook) + char_length(new.body), v_max;
    end if;
  else
    if new.hook is distinct from old.hook or new.body is distinct from old.body or new.fixture_id is distinct from old.fixture_id
       or new.run_id is distinct from old.run_id or new.parent_revision_id is distinct from old.parent_revision_id or new.source is distinct from old.source then
      raise exception 'game_story_revision_text_immutable: edit by creating a new revision';
    end if;
    if new.status is distinct from old.status and not (
         (old.status = 'REVIEW_REQUIRED' and new.status in ('APPROVED', 'REJECTED', 'SUPERSEDED'))
      or (old.status = 'APPROVED'        and new.status in ('SUPERSEDED', 'WITHDRAWN'))) then
      raise exception 'illegal_game_story_revision_transition: % -> %', old.status, new.status;
    end if;
  end if;
  return new;
end;
$$;
create trigger game_story_revisions_guard_trg before insert or update on public.game_story_revisions for each row execute function public.game_story_revisions_guard();

create or replace function public.game_story_forbid_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception '% rows are append-only and are never deleted', tg_table_name;
end;
$$;
create trigger game_story_runs_no_delete before delete on public.game_story_runs for each row execute function public.game_story_forbid_delete();
create trigger game_story_evidence_no_delete before delete on public.game_story_evidence for each row execute function public.game_story_forbid_delete();
create trigger game_story_claims_no_delete before delete on public.game_story_claims for each row execute function public.game_story_forbid_delete();
create trigger game_story_claim_evidence_no_delete before delete on public.game_story_claim_evidence for each row execute function public.game_story_forbid_delete();
create trigger game_story_revisions_no_delete before delete on public.game_story_revisions for each row execute function public.game_story_forbid_delete();

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Privileges: internal research evidence is never client-readable. RLS on, no policy; privileges revoked from every client role.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.game_story_config enable row level security;
alter table public.game_story_runs enable row level security;
alter table public.game_story_evidence enable row level security;
alter table public.game_story_claims enable row level security;
alter table public.game_story_claim_evidence enable row level security;
alter table public.game_story_revisions enable row level security;
revoke all on public.game_story_config, public.game_story_runs, public.game_story_evidence, public.game_story_claims, public.game_story_claim_evidence, public.game_story_revisions from public, anon, authenticated;
grant select, insert, update on public.game_story_config, public.game_story_runs, public.game_story_evidence, public.game_story_claims, public.game_story_claim_evidence, public.game_story_revisions to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Super Admin: configuration (audited). auto_publish_enabled cannot be turned on in M3.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_set_game_story_config(p_admin_id uuid, p_config jsonb)
returns public.game_story_config
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.game_story_config;
  v_after  public.game_story_config;
  v_allowed constant text[] := array['generation_enabled', 'provider', 'model', 'effort', 'web_search_tool_version', 'web_search_enabled', 'max_chars', 'min_score', 'research_window_hours',
    'refresh_interval_minutes', 'editorial_cutoff_minutes', 'max_queries_per_game', 'max_sources', 'max_attempts', 'provider_retries', 'request_timeout_seconds', 'max_games_per_run',
    'max_runs_per_game', 'status_max_age_hours', 'current_fact_max_age_hours', 'supported_sports', 'preferred_domains', 'blocked_domains'];
  v_key text;
begin
  perform public.require_super_admin(p_admin_id);
  if p_config is null or jsonb_typeof(p_config) <> 'object' then raise exception 'invalid_config'; end if;
  if p_config ? 'auto_publish_enabled' and (p_config ->> 'auto_publish_enabled')::boolean is true then raise exception 'auto_publish_locked'; end if;
  for v_key in select jsonb_object_keys(p_config) loop
    if v_key <> 'auto_publish_enabled' and not (v_key = any (v_allowed)) then raise exception 'unknown_setting: %', v_key; end if;
  end loop;
  select * into v_before from public.game_story_config where id = true for update;
  update public.game_story_config set
    generation_enabled = coalesce((p_config ->> 'generation_enabled')::boolean, generation_enabled),
    provider = coalesce(p_config ->> 'provider', provider),
    model = coalesce(p_config ->> 'model', model),
    effort = coalesce(p_config ->> 'effort', effort),
    web_search_tool_version = coalesce(p_config ->> 'web_search_tool_version', web_search_tool_version),
    web_search_enabled = coalesce((p_config ->> 'web_search_enabled')::boolean, web_search_enabled),
    max_chars = coalesce((p_config ->> 'max_chars')::integer, max_chars),
    min_score = coalesce((p_config ->> 'min_score')::integer, min_score),
    research_window_hours = coalesce((p_config ->> 'research_window_hours')::integer, research_window_hours),
    refresh_interval_minutes = coalesce((p_config ->> 'refresh_interval_minutes')::integer, refresh_interval_minutes),
    editorial_cutoff_minutes = coalesce((p_config ->> 'editorial_cutoff_minutes')::integer, editorial_cutoff_minutes),
    max_queries_per_game = coalesce((p_config ->> 'max_queries_per_game')::integer, max_queries_per_game),
    max_sources = coalesce((p_config ->> 'max_sources')::integer, max_sources),
    max_attempts = coalesce((p_config ->> 'max_attempts')::integer, max_attempts),
    provider_retries = coalesce((p_config ->> 'provider_retries')::integer, provider_retries),
    request_timeout_seconds = coalesce((p_config ->> 'request_timeout_seconds')::integer, request_timeout_seconds),
    max_games_per_run = coalesce((p_config ->> 'max_games_per_run')::integer, max_games_per_run),
    max_runs_per_game = coalesce((p_config ->> 'max_runs_per_game')::integer, max_runs_per_game),
    status_max_age_hours = coalesce((p_config ->> 'status_max_age_hours')::integer, status_max_age_hours),
    current_fact_max_age_hours = coalesce((p_config ->> 'current_fact_max_age_hours')::integer, current_fact_max_age_hours),
    supported_sports = coalesce(case when p_config ? 'supported_sports' then array(select jsonb_array_elements_text(p_config -> 'supported_sports')) end, supported_sports),
    preferred_domains = coalesce(case when p_config ? 'preferred_domains' then array(select jsonb_array_elements_text(p_config -> 'preferred_domains')) end, preferred_domains),
    blocked_domains = coalesce(case when p_config ? 'blocked_domains' then array(select jsonb_array_elements_text(p_config -> 'blocked_domains')) end, blocked_domains),
    updated_at = now(), updated_by = p_admin_id
  where id = true
  returning * into v_after;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
    values (p_admin_id, 'game_story.config_updated', 'game_story_config', null, to_jsonb(v_before) - 'updated_at' - 'updated_by', to_jsonb(v_after) - 'updated_at' - 'updated_by');
  return v_after;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Candidates and run start (the idempotency and bounded-cost core)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Games a scheduled run may research now: supported sport, not started, inside the research window and before the editorial cutoff, with a published canonical Post,
-- not researched within the refresh interval, below the per-Game run limit, no active run. Games without an approved story come first, then by kickoff.
create or replace function public.game_story_candidates(p_limit integer)
returns table (fixture_id uuid, sport text, scheduled_start_utc timestamptz, has_story boolean)
language sql
stable
set search_path = public
as $$
  select f.id, f.sport, f.scheduled_start_utc, (p.story_revision_id is not null)
  from public.game_story_config c
  join public.fixtures f on f.sport = any (c.supported_sports)
  join public.posts p on p.fixture_id = f.id and p.published_at is not null
  where c.id = true
    and c.generation_enabled
    and f.internal_status = 'NOT_STARTED'
    and f.scheduled_start_utc > now() + make_interval(mins => c.editorial_cutoff_minutes)
    and f.scheduled_start_utc <= now() + make_interval(hours => c.research_window_hours)
    and not exists (select 1 from public.game_story_runs r where r.fixture_id = f.id and r.status in ('PENDING', 'RESEARCHING', 'CANDIDATE_GENERATED'))
    and not exists (select 1 from public.game_story_runs r where r.fixture_id = f.id and r.started_at > now() - make_interval(mins => c.refresh_interval_minutes))
    and (select count(*) from public.game_story_runs r where r.fixture_id = f.id and r.trigger_kind = 'SCHEDULED') < c.max_runs_per_game
  order by (p.story_revision_id is not null), f.scheduled_start_utc
  limit greatest(p_limit, 0);
$$;

create or replace function public.start_game_story_run(p_fixture_id uuid, p_trigger text, p_admin_id uuid default null, p_stale_after_seconds integer default 900)
returns table (run_id uuid, outcome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.game_story_config;
  v_fx  public.fixtures;
  v_id  uuid;
begin
  if p_trigger not in ('SCHEDULED', 'ADMIN', 'REGENERATE') then raise exception 'invalid_trigger'; end if;
  if p_trigger <> 'SCHEDULED' and (p_admin_id is null or not public.is_admin_or_above(p_admin_id)) then raise exception 'not_authorized'; end if;
  perform pg_advisory_xact_lock(hashtextextended('game_story:' || p_fixture_id::text, 0));
  select * into v_cfg from public.game_story_config where id = true;
  if not v_cfg.generation_enabled then return query select null::uuid, 'disabled'::text; return; end if;
  select * into v_fx from public.fixtures where id = p_fixture_id;
  if not found or v_fx.internal_status <> 'NOT_STARTED' or not (v_fx.sport = any (v_cfg.supported_sports))
     or not exists (select 1 from public.posts where fixture_id = p_fixture_id) then
    return query select null::uuid, 'not_eligible'::text; return;
  end if;
  if v_fx.scheduled_start_utc <= now() + make_interval(mins => v_cfg.editorial_cutoff_minutes) then return query select null::uuid, 'past_cutoff'::text; return; end if;
  -- a run that stopped heartbeating is failed so it cannot block the Game forever
  update public.game_story_runs set status = 'FAILED', completed_at = now(), error_category = 'stale_run', rejection_detail = 'The run stopped reporting progress and was closed.'
    where fixture_id = p_fixture_id and status in ('PENDING', 'RESEARCHING', 'CANDIDATE_GENERATED') and heartbeat_at < now() - make_interval(secs => p_stale_after_seconds);
  if exists (select 1 from public.game_story_runs where fixture_id = p_fixture_id and status in ('PENDING', 'RESEARCHING', 'CANDIDATE_GENERATED')) then
    return query select null::uuid, 'active_run_exists'::text; return;
  end if;
  if p_trigger = 'SCHEDULED' then
    if exists (select 1 from public.game_story_runs where fixture_id = p_fixture_id and started_at > now() - make_interval(mins => v_cfg.refresh_interval_minutes)) then
      return query select null::uuid, 'recently_researched'::text; return;
    end if;
    if (select count(*) from public.game_story_runs where fixture_id = p_fixture_id and trigger_kind = 'SCHEDULED') >= v_cfg.max_runs_per_game then
      return query select null::uuid, 'run_limit_reached'::text; return;
    end if;
  end if;
  insert into public.game_story_runs (fixture_id, trigger_kind, requested_by, provider, model, effort, config_snapshot)
    values (p_fixture_id, p_trigger, p_admin_id, v_cfg.provider, v_cfg.model, v_cfg.effort,
            jsonb_build_object('max_chars', v_cfg.max_chars, 'min_score', v_cfg.min_score, 'max_queries_per_game', v_cfg.max_queries_per_game, 'max_sources', v_cfg.max_sources,
              'max_attempts', v_cfg.max_attempts, 'web_search_enabled', v_cfg.web_search_enabled))
    returning id into v_id;
  return query select v_id, 'started'::text;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Saving a run's result atomically (evidence + claims + candidate, or the rejection with its reason)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- p_payload: { decision, rejection_code, rejection_detail, candidate_hook, candidate_body, dims:{relevance,evidence,debate,originality,freshness}|null, counters:{...}, elapsed_ms, prompt_version,
--              research_version, details:{...}, evidence:[{id,...}], claims:[{id,position,text,type,subject_team,availability_status,quote_text,verdict,deterministic_ok,model_verdict,note,evidence_ids:[...]}],
--              revision:{hook,body}|null }
create or replace function public.save_game_story_run_result(p_run_id uuid, p_payload jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run     public.game_story_runs;
  v_cfg     public.game_story_config;
  v_decision text := p_payload ->> 'decision';
  -- a JSON null is NOT a SQL null: treat it as "missing" so an accepted candidate can never slip through without scores
  v_dims    jsonb := nullif(p_payload -> 'dims', 'null'::jsonb);
  v_total   integer;
  v_rev_id  uuid;
  v_post_id uuid;
  v_claim   jsonb;
  v_ev      text;
begin
  if v_decision not in ('ACCEPTED', 'REJECTED', 'NO_STORY') then raise exception 'invalid_decision'; end if;
  select * into v_run from public.game_story_runs where id = p_run_id for update;
  if not found then raise exception 'run_not_found'; end if;
  if v_run.status not in ('PENDING', 'RESEARCHING', 'CANDIDATE_GENERATED') then raise exception 'run_not_active'; end if;
  if v_run.status = 'PENDING' then update public.game_story_runs set status = 'RESEARCHING' where id = p_run_id; end if;
  select * into v_cfg from public.game_story_config where id = true;

  insert into public.game_story_evidence (id, run_id, fixture_id, position, source_kind, authority, canonical_id, url, publisher, title, published_at, retrieved_at, evidence_type, fact_key, fact_value,
                                          subject_team, fact_text, excerpt, as_of, status, status_reason)
    select e.id, p_run_id, v_run.fixture_id, coalesce(e.position, 0), e.source_kind, e.authority, e.canonical_id, e.url, e.publisher, e.title, e.published_at, coalesce(e.retrieved_at, now()), e.evidence_type,
           e.fact_key, e.fact_value, coalesce(e.subject_team, 'NEITHER'), e.fact_text, e.excerpt, e.as_of, coalesce(e.status, 'USABLE'), e.status_reason
    from jsonb_to_recordset(coalesce(p_payload -> 'evidence', '[]'::jsonb)) as e(id uuid, position smallint, source_kind text, authority smallint, canonical_id text, url text, publisher text, title text,
         published_at timestamptz, retrieved_at timestamptz, evidence_type text, fact_key text, fact_value text, subject_team text, fact_text text, excerpt text, as_of timestamptz, status text, status_reason text);

  if v_decision = 'ACCEPTED' then
    if v_dims is null then raise exception 'accepted_requires_scores'; end if;
    v_total := (v_dims ->> 'relevance')::int + (v_dims ->> 'evidence')::int + (v_dims ->> 'debate')::int + (v_dims ->> 'originality')::int + (v_dims ->> 'freshness')::int;
    if v_total is null or v_total < v_cfg.min_score then raise exception 'accepted_below_minimum_score: % < %', v_total, v_cfg.min_score; end if;
    if jsonb_array_length(coalesce(p_payload -> 'claims', '[]'::jsonb)) = 0 then raise exception 'accepted_requires_claims'; end if;
    if exists (select 1 from jsonb_array_elements(p_payload -> 'claims') c where c ->> 'verdict' is distinct from 'SUPPORTED') then raise exception 'accepted_with_unsupported_claim'; end if;
    if nullif(p_payload -> 'revision', 'null'::jsonb) is null then raise exception 'accepted_requires_revision'; end if;
    select id into v_post_id from public.posts where fixture_id = v_run.fixture_id;
    insert into public.game_story_revisions (fixture_id, post_id, run_id, source, status, hook, body, total_score)
      values (v_run.fixture_id, v_post_id, p_run_id, 'GENERATED', 'REVIEW_REQUIRED', p_payload -> 'revision' ->> 'hook', p_payload -> 'revision' ->> 'body', v_total)
      returning id into v_rev_id;
  end if;

  for v_claim in select * from jsonb_array_elements(coalesce(p_payload -> 'claims', '[]'::jsonb)) loop
    insert into public.game_story_claims (id, run_id, revision_id, position, claim_text, claim_type, subject_team, availability_status, quote_text, verdict, deterministic_ok, model_verdict, verification_note)
      values ((v_claim ->> 'id')::uuid, p_run_id, v_rev_id, coalesce((v_claim ->> 'position')::smallint, 0), v_claim ->> 'text', v_claim ->> 'type', v_claim ->> 'subject_team',
              v_claim ->> 'availability_status', v_claim ->> 'quote_text', coalesce(v_claim ->> 'verdict', 'PENDING'), (v_claim ->> 'deterministic_ok')::boolean, v_claim ->> 'model_verdict', v_claim ->> 'note');
    for v_ev in select jsonb_array_elements_text(coalesce(v_claim -> 'evidence_ids', '[]'::jsonb)) loop
      insert into public.game_story_claim_evidence (claim_id, evidence_id) values ((v_claim ->> 'id')::uuid, v_ev::uuid);
    end loop;
  end loop;

  update public.game_story_runs set
    status = case when v_decision = 'ACCEPTED' then 'REVIEW_REQUIRED' else 'REJECTED' end,
    decision = v_decision,
    rejection_code = case when v_decision = 'ACCEPTED' then null else left(p_payload ->> 'rejection_code', 60) end,
    rejection_detail = case when v_decision = 'ACCEPTED' then null else left(p_payload ->> 'rejection_detail', 1000) end,
    candidate_hook = left(p_payload ->> 'candidate_hook', 400),
    candidate_body = left(p_payload ->> 'candidate_body', 2000),
    dim_relevance = (v_dims ->> 'relevance')::smallint, dim_evidence = (v_dims ->> 'evidence')::smallint, dim_debate = (v_dims ->> 'debate')::smallint,
    dim_originality = (v_dims ->> 'originality')::smallint, dim_freshness = (v_dims ->> 'freshness')::smallint,
    min_score_applied = v_cfg.min_score,
    queries_used = coalesce((p_payload -> 'counters' ->> 'queries')::int, 0),
    sources_kept = (select count(*) from public.game_story_evidence where run_id = p_run_id and status = 'USABLE'),
    model_calls = coalesce((p_payload -> 'counters' ->> 'model_calls')::int, 0),
    search_calls = coalesce((p_payload -> 'counters' ->> 'search_calls')::int, 0),
    input_tokens = coalesce((p_payload -> 'counters' ->> 'input_tokens')::bigint, 0),
    output_tokens = coalesce((p_payload -> 'counters' ->> 'output_tokens')::bigint, 0),
    elapsed_ms = (p_payload ->> 'elapsed_ms')::int,
    prompt_version = coalesce(p_payload ->> 'prompt_version', prompt_version),
    research_version = coalesce(p_payload ->> 'research_version', research_version),
    details = coalesce(p_payload -> 'details', '{}'::jsonb),
    completed_at = now(), heartbeat_at = now()
  where id = p_run_id;
  return case when v_decision = 'ACCEPTED' then 'review_required' else 'rejected' end;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Admin review: approve / reject / edit / withdraw (audited, serialised on the Game's canonical Post)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.approve_game_story_revision(p_admin_id uuid, p_revision_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixture uuid;
  v_rev     public.game_story_revisions;
  v_post_id uuid;
  v_old_id  uuid;
  v_old_run uuid;
  v_cfg     public.game_story_config;
begin
  if p_admin_id is null or not public.is_admin_or_above(p_admin_id) then raise exception 'not_authorized'; end if;
  select fixture_id into v_fixture from public.game_story_revisions where id = p_revision_id;
  if not found then raise exception 'revision_not_found'; end if;
  -- serialise every approval/withdrawal for this Game on its canonical Post row
  select id, story_revision_id into v_post_id, v_old_id from public.posts where fixture_id = v_fixture for update;
  if not found then raise exception 'post_not_found'; end if;
  select * into v_rev from public.game_story_revisions where id = p_revision_id for update;
  if v_rev.status = 'APPROVED' then return 'already_approved'; end if;
  if v_rev.status <> 'REVIEW_REQUIRED' then raise exception 'revision_not_reviewable'; end if;
  -- pregame copy is never published, replaced or rewritten once the Game has started (withdrawing remains possible)
  if exists (select 1 from public.fixtures f where f.id = v_fixture and (f.internal_status <> 'NOT_STARTED' or f.scheduled_start_utc <= now())) then raise exception 'game_already_started'; end if;
  if v_rev.requires_verification then raise exception 'verification_required'; end if;
  if not exists (select 1 from public.game_story_claims where revision_id = p_revision_id) then raise exception 'no_claims'; end if;
  if exists (select 1 from public.game_story_claims where revision_id = p_revision_id and verdict <> 'SUPPORTED') then raise exception 'unsupported_claims'; end if;
  select * into v_cfg from public.game_story_config where id = true;
  if v_rev.char_count > v_cfg.max_chars then raise exception 'game_story_over_length: % characters, limit %', v_rev.char_count, v_cfg.max_chars; end if;

  if v_old_id is not null and v_old_id <> p_revision_id then
    update public.game_story_revisions set status = 'SUPERSEDED' where id = v_old_id and status = 'APPROVED';
    select run_id into v_old_run from public.game_story_revisions where id = v_old_id;
    if v_old_run is not null and v_old_run is distinct from v_rev.run_id then
      update public.game_story_runs set status = 'SUPERSEDED' where id = v_old_run and status = 'APPROVED';
    end if;
  end if;
  update public.game_story_revisions set status = 'APPROVED', approved_by = p_admin_id, approved_at = now(), post_id = v_post_id where id = p_revision_id;
  update public.game_story_runs set status = 'APPROVED' where id = v_rev.run_id and status = 'REVIEW_REQUIRED';
  update public.posts set story_revision_id = p_revision_id where id = v_post_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
    values (p_admin_id, 'game_story.approved', 'game_story_revision', p_revision_id::text,
            jsonb_build_object('previous_revision_id', v_old_id),
            jsonb_build_object('revision_id', p_revision_id, 'run_id', v_rev.run_id, 'fixture_id', v_fixture, 'post_id', v_post_id, 'char_count', v_rev.char_count, 'total_score', v_rev.total_score, 'source', v_rev.source));
  return 'approved';
end;
$$;

create or replace function public.reject_game_story_revision(p_admin_id uuid, p_revision_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rev public.game_story_revisions;
begin
  if p_admin_id is null or not public.is_admin_or_above(p_admin_id) then raise exception 'not_authorized'; end if;
  select * into v_rev from public.game_story_revisions where id = p_revision_id for update;
  if not found then raise exception 'revision_not_found'; end if;
  if v_rev.status = 'REJECTED' then return 'already_rejected'; end if;
  if v_rev.status <> 'REVIEW_REQUIRED' then raise exception 'revision_not_reviewable'; end if;
  update public.game_story_revisions set status = 'REJECTED', rejected_by = p_admin_id, rejected_at = now(), rejection_reason = left(nullif(btrim(p_reason), ''), 1000) where id = p_revision_id;
  update public.game_story_runs set status = 'REJECTED', rejection_code = 'ADMIN_REJECTED', rejection_detail = left(nullif(btrim(p_reason), ''), 1000) where id = v_rev.run_id and status = 'REVIEW_REQUIRED';
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after, reason)
    values (p_admin_id, 'game_story.rejected', 'game_story_revision', p_revision_id::text, jsonb_build_object('status', 'REVIEW_REQUIRED'), jsonb_build_object('status', 'REJECTED'), left(nullif(btrim(p_reason), ''), 1000));
  return 'rejected';
end;
$$;

create or replace function public.withdraw_game_story(p_admin_id uuid, p_fixture_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post_id uuid;
  v_rev_id  uuid;
  v_run_id  uuid;
begin
  if p_admin_id is null or not public.is_admin_or_above(p_admin_id) then raise exception 'not_authorized'; end if;
  select id, story_revision_id into v_post_id, v_rev_id from public.posts where fixture_id = p_fixture_id for update;
  if not found then raise exception 'post_not_found'; end if;
  if v_rev_id is null then return 'nothing_to_withdraw'; end if;
  select run_id into v_run_id from public.game_story_revisions where id = v_rev_id;
  update public.game_story_revisions set status = 'WITHDRAWN', withdrawn_by = p_admin_id, withdrawn_at = now(), withdrawn_reason = left(nullif(btrim(p_reason), ''), 1000) where id = v_rev_id and status = 'APPROVED';
  update public.game_story_runs set status = 'SUPERSEDED' where id = v_run_id and status = 'APPROVED';
  update public.posts set story_revision_id = null where id = v_post_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after, reason)
    values (p_admin_id, 'game_story.withdrawn', 'game_story_revision', v_rev_id::text, jsonb_build_object('status', 'APPROVED'), jsonb_build_object('status', 'WITHDRAWN'), left(nullif(btrim(p_reason), ''), 1000));
  return 'withdrawn';
end;
$$;

-- An Admin's change to the words is a NEW revision that has to be re-verified before it can be approved: the AI evidence never silently "proves" a human edit.
create or replace function public.admin_edit_game_story_revision(p_admin_id uuid, p_revision_id uuid, p_hook text, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base public.game_story_revisions;
  v_new  uuid;
begin
  if p_admin_id is null or not public.is_admin_or_above(p_admin_id) then raise exception 'not_authorized'; end if;
  select * into v_base from public.game_story_revisions where id = p_revision_id for update;
  if not found then raise exception 'revision_not_found'; end if;
  if v_base.status not in ('REVIEW_REQUIRED', 'APPROVED') then raise exception 'revision_not_editable'; end if;
  if v_base.status = 'REVIEW_REQUIRED' then update public.game_story_revisions set status = 'SUPERSEDED' where id = p_revision_id; end if;
  insert into public.game_story_revisions (fixture_id, post_id, run_id, parent_revision_id, source, status, hook, body, total_score, requires_verification, created_by)
    values (v_base.fixture_id, v_base.post_id, v_base.run_id, p_revision_id, 'ADMIN_EDIT', 'REVIEW_REQUIRED', btrim(p_hook), btrim(p_body), v_base.total_score, true, p_admin_id)
    returning id into v_new;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
    values (p_admin_id, 'game_story.edited', 'game_story_revision', v_new::text, jsonb_build_object('revision_id', p_revision_id, 'hook', v_base.hook, 'body', v_base.body),
            jsonb_build_object('revision_id', v_new, 'hook', btrim(p_hook), 'body', btrim(p_body), 'requires_verification', true));
  return v_new;
end;
$$;

-- Records the outcome of re-verifying an edited revision (claims extracted from the NEW words and checked against the run's stored evidence).
create or replace function public.complete_game_story_reverification(p_revision_id uuid, p_claims jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rev   public.game_story_revisions;
  v_claim jsonb;
  v_ev    text;
begin
  select * into v_rev from public.game_story_revisions where id = p_revision_id for update;
  if not found then raise exception 'revision_not_found'; end if;
  if v_rev.status <> 'REVIEW_REQUIRED' or not v_rev.requires_verification then raise exception 'revision_not_awaiting_verification'; end if;
  if v_rev.run_id is null then raise exception 'revision_has_no_run'; end if;
  for v_claim in select * from jsonb_array_elements(coalesce(p_claims, '[]'::jsonb)) loop
    insert into public.game_story_claims (id, run_id, revision_id, position, claim_text, claim_type, subject_team, availability_status, quote_text, verdict, deterministic_ok, model_verdict, verification_note)
      values ((v_claim ->> 'id')::uuid, v_rev.run_id, p_revision_id, coalesce((v_claim ->> 'position')::smallint, 0), v_claim ->> 'text', v_claim ->> 'type', v_claim ->> 'subject_team',
              v_claim ->> 'availability_status', v_claim ->> 'quote_text', coalesce(v_claim ->> 'verdict', 'PENDING'), (v_claim ->> 'deterministic_ok')::boolean, v_claim ->> 'model_verdict', v_claim ->> 'note');
    for v_ev in select jsonb_array_elements_text(coalesce(v_claim -> 'evidence_ids', '[]'::jsonb)) loop
      insert into public.game_story_claim_evidence (claim_id, evidence_id) values ((v_claim ->> 'id')::uuid, v_ev::uuid);
    end loop;
  end loop;
  if jsonb_array_length(coalesce(p_claims, '[]'::jsonb)) > 0 and not exists (select 1 from jsonb_array_elements(p_claims) c where c ->> 'verdict' is distinct from 'SUPPORTED') then
    update public.game_story_revisions set requires_verification = false where id = p_revision_id;
    return 'verified';
  end if;
  return 'verification_failed';
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Metrics (internal, small)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.game_story_metrics(p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'runs', count(*),
    'games_researched', count(distinct fixture_id),
    'failed', count(*) filter (where status = 'FAILED'),
    'candidates', count(*) filter (where candidate_hook is not null),
    'accepted', count(*) filter (where decision = 'ACCEPTED'),
    'rejected', count(*) filter (where decision = 'REJECTED'),
    'no_story', count(*) filter (where decision = 'NO_STORY'),
    'rejected_unsupported', count(*) filter (where rejection_code in ('UNSUPPORTED_CLAIM', 'CONTRADICTED_CLAIM', 'UNCLAIMED_FACT', 'UNVERIFIED_QUOTE', 'STALE_EVIDENCE', 'IDENTITY_MISMATCH')),
    'rejected_low_score', count(*) filter (where rejection_code = 'LOW_SCORE'),
    'avg_score', round(avg(total_score)::numeric, 1),
    'avg_sources', round(avg(sources_kept)::numeric, 1),
    'avg_elapsed_ms', round(avg(elapsed_ms)::numeric, 0),
    'max_elapsed_ms', max(elapsed_ms),
    'input_tokens', coalesce(sum(input_tokens), 0),
    'output_tokens', coalesce(sum(output_tokens), 0),
    'search_calls', coalesce(sum(search_calls), 0),
    'model_calls', coalesce(sum(model_calls), 0)
  ) from public.game_story_runs where started_at >= p_since;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Function privileges: service role only, never a client role.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
revoke all on function public.admin_set_game_story_config(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.game_story_candidates(integer) from public, anon, authenticated;
revoke all on function public.start_game_story_run(uuid, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.save_game_story_run_result(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.approve_game_story_revision(uuid, uuid) from public, anon, authenticated;
revoke all on function public.reject_game_story_revision(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.withdraw_game_story(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_edit_game_story_revision(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.complete_game_story_reverification(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.game_story_metrics(timestamptz) from public, anon, authenticated;
revoke all on function public.game_story_runs_guard() from public, anon, authenticated;
revoke all on function public.game_story_revisions_guard() from public, anon, authenticated;
revoke all on function public.game_story_forbid_delete() from public, anon, authenticated;
grant execute on function public.admin_set_game_story_config(uuid, jsonb) to service_role;
grant execute on function public.game_story_candidates(integer) to service_role;
grant execute on function public.start_game_story_run(uuid, text, uuid, integer) to service_role;
grant execute on function public.save_game_story_run_result(uuid, jsonb) to service_role;
grant execute on function public.approve_game_story_revision(uuid, uuid) to service_role;
grant execute on function public.reject_game_story_revision(uuid, uuid, text) to service_role;
grant execute on function public.withdraw_game_story(uuid, uuid, text) to service_role;
grant execute on function public.admin_edit_game_story_revision(uuid, uuid, text, text) to service_role;
grant execute on function public.complete_game_story_reverification(uuid, jsonb) to service_role;
grant execute on function public.game_story_metrics(timestamptz) to service_role;
