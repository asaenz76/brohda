-- Cleanup + policy hardening (forward-only; no existing function, row, result or ledger entry is rewritten).
--
--   1. expire_stale_challenges(): a PENDING Call BS that can no longer be accepted becomes EXPIRED instead of staying PENDING forever
--      (expiry used to be purely lazy — it only happened if someone tried to accept or decline).
--   2. close_finished_markets(): a Market whose Game is finished and whose Picks are all graded moves ACTIVE -> CLOSED (the existing
--      terminal state), instead of staying ACTIVE for ever.
--   3. legal_acceptances: a durable, append-only record of which version of the Terms / Privacy Policy a member accepted, and when.
--
-- Production audit before writing this (read-only): 5 challenges (4 RESOLVED, 1 stale PENDING on a COMPLETED game); every Market on a
-- COMPLETED game still ACTIVE; no consent records anywhere. Nothing here touches a RESOLVED/ACCEPTED/DECLINED challenge, a graded Pick, a
-- settled Position or the wallet ledger.

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 1. Call BS expiry
-- ---------------------------------------------------------------------------------------------------------------------------------
-- A PENDING challenge is no longer actionable when ANY of: the canonical Pick cutoff has passed (the same
-- scheduled_start - pick_lock_minutes_before_kickoff rule accept_call_bs / call_bs use), the Game is no longer NOT_STARTED, or the Market is no
-- longer ACTIVE. Only PENDING rows are ever touched (ACCEPTED / RESOLVED / DECLINED / EXPIRED are never modified), so reputation, the Call BS
-- record and Pick accuracy are unaffected. No notification is sent — the same behaviour as the existing displaced-challenge expiry.
--
-- Concurrency: rows are taken FOR UPDATE SKIP LOCKED, and accept_call_bs / decline_call_bs both lock the challenge row FOR UPDATE first. So
-- exactly one of {sweep, accept, decline} wins a given row, deterministically: if the sweep wins, accept sees a non-PENDING row and refuses;
-- if accept/decline holds the row, the sweep skips it (and a still-PENDING row is simply picked up by the next sweep). Idempotent: a second
-- run finds nothing PENDING to expire.
create or replace function public.expire_stale_challenges(p_limit integer default 200)
returns setof public.challenges
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_lock_minutes integer;
begin
  select coalesce(pick_lock_minutes_before_kickoff, 10) into v_lock_minutes from public.platform_settings where id = true;

  return query
  with stale as (
    select c.id
    from public.challenges c
    join public.markets m on m.id = c.market_id
    join public.fixtures f on f.id = m.fixture_id
    where c.status = 'PENDING'
      and (
        now() >= f.scheduled_start_utc - (coalesce(v_lock_minutes, 10) || ' minutes')::interval
        or f.internal_status <> 'NOT_STARTED'
        or m.status <> 'ACTIVE'
      )
    order by c.created_at
    limit greatest(coalesce(p_limit, 200), 1)
    for update of c skip locked
  )
  update public.challenges c
    set status = 'EXPIRED', updated_at = now()
    from stale
    where c.id = stale.id and c.status = 'PENDING'
    returning c.*;
end;
$$;

revoke all on function public.expire_stale_challenges(integer) from public, anon, authenticated;
grant execute on function public.expire_stale_challenges(integer) to service_role;

comment on function public.expire_stale_challenges(integer) is
  'Expires PENDING Call BS challenges that can no longer be accepted (cutoff passed, Game not NOT_STARTED, or Market not ACTIVE). Only ever touches PENDING rows; row-locked and idempotent; sends no notification.';

-- Supports the sweep's PENDING scan without a table scan as challenges grow.
create index if not exists idx_challenges_status_pending on public.challenges (created_at) where status = 'PENDING';

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 2. Market lifecycle
-- ---------------------------------------------------------------------------------------------------------------------------------
-- ACTIVE -> CLOSED, and nothing else, for a Market whose Game is terminal (COMPLETED or CANCELLED) and which has no PENDING Pick left (grading
-- done — a VOID result also counts as graded). ARCHIVED is deliberately NOT used: grading treats ARCHIVED as VOID. POSTPONED / SUSPENDED /
-- ABANDONED / AWARDED / UNKNOWN Games are not terminal and are left alone. Never reopens (CLOSED is never set back to ACTIVE here), never
-- touches INACTIVE (a superseded Total line) and never changes identity columns, results, Picks, challenges or money. Idempotent.
create or replace function public.close_finished_markets(p_limit integer default 200)
returns setof uuid
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  return query
  with finished as (
    select m.id
    from public.markets m
    join public.fixtures f on f.id = m.fixture_id
    where m.status = 'ACTIVE'
      and f.internal_status in ('COMPLETED', 'CANCELLED')
      and not exists (select 1 from public.predictions p where p.market_id = m.id and p.lifecycle_state = 'PENDING')
    order by f.scheduled_start_utc
    limit greatest(coalesce(p_limit, 200), 1)
    for update of m skip locked
  )
  update public.markets m
    set status = 'CLOSED', closed_at = coalesce(m.closed_at, now())
    from finished
    where m.id = finished.id and m.status = 'ACTIVE'
    returning m.id;
end;
$$;

revoke all on function public.close_finished_markets(integer) from public, anon, authenticated;
grant execute on function public.close_finished_markets(integer) to service_role;

comment on function public.close_finished_markets(integer) is
  'ACTIVE -> CLOSED for Markets whose Game is COMPLETED/CANCELLED and whose Picks are all graded. Never reopens, never uses ARCHIVED (which grading treats as VOID), never touches INACTIVE, results, Picks, challenges or money. Idempotent.';

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 3. Legal acceptance record
-- ---------------------------------------------------------------------------------------------------------------------------------
-- One row = one member accepted one version of one document at one time, from one place. Append-only: it is a legal record, so UPDATE and
-- DELETE are refused for everyone. Existing members have no row (their registration-time acceptance was never recorded) and none is invented.
create table if not exists public.legal_acceptances (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.user_profiles(id) on delete restrict,
  document     text not null check (document in ('terms', 'privacy')),
  version      text not null check (char_length(version) between 1 and 64),
  accepted_at  timestamptz not null default now(),
  source       text not null check (source in ('register', 'invitation', 'reconsent')),
  constraint legal_acceptances_unique_version unique (user_id, document, version)
);

create index if not exists idx_legal_acceptances_user on public.legal_acceptances (user_id, document, accepted_at desc);

create or replace function public.forbid_legal_acceptance_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'legal_acceptances is append-only: a recorded acceptance can never be updated or deleted';
end;
$$;

create trigger legal_acceptances_append_only
before update or delete on public.legal_acceptances
for each row execute function public.forbid_legal_acceptance_mutation();

alter table public.legal_acceptances enable row level security;

-- A member may read their own acceptances; nobody writes through the client (the app records them with the service role).
create policy legal_acceptances_select_own on public.legal_acceptances for select to authenticated using (user_id = auth.uid());

revoke all on public.legal_acceptances from public, anon, authenticated;
grant select on public.legal_acceptances to authenticated;
grant select, insert on public.legal_acceptances to service_role;

comment on table public.legal_acceptances is
  'Append-only record of which version of the Terms / Privacy Policy a member accepted, when, and from where (register | invitation | reconsent). No backfill: members who registered before this table have no row.';

-- Re-consent switch. Lists which documents currently require every signed-in member to accept the CURRENT version before continuing
-- (the version identifiers live next to the published text, in lib/legal/documents.ts). Empty by default — copy edits never force re-consent;
-- an owner turns it on deliberately, for a material change, by setting this row. Nothing reads it for any other purpose.
alter table public.platform_settings
  add column if not exists legal_reconsent_required text[] not null default '{}'
  check (legal_reconsent_required <@ array['terms', 'privacy']::text[]);

comment on column public.platform_settings.legal_reconsent_required is
  'Documents (terms | privacy) whose CURRENT version every signed-in member must accept before continuing. Default empty: re-consent is a deliberate decision for a material change, never automatic.';

-- ---------------------------------------------------------------------------------------------------------------------------------
-- 4. Admin Predictions search
-- ---------------------------------------------------------------------------------------------------------------------------------
-- Read-only lookup for the admin Predictions table: returns the ids of the most recent Predictions matching a free-text query (member
-- username / display name, member id, Prediction id, Market id, Game team names, Market question — substring, case-insensitive; ids match
-- by prefix so the short ids shown in the table work) and optional state / result / date-range filters. One bounded query with real joins
-- (PostgREST can neither cast ids to text nor OR across joined tables); the application then loads the rows with its existing batched reads.
-- The query text is escaped, so % and _ are matched literally. Service-role only; changes nothing.
create or replace function public.admin_search_predictions(
  p_query text default null,
  p_state text default null,
  p_result text default null,
  p_from date default null,
  p_to date default null,
  p_limit integer default 200
)
returns setof uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
  v_like text;
  v_prefix text;
begin
  if v_q is not null then
    v_q := left(v_q, 100);
    -- escape LIKE metacharacters so the search is literal
    v_like := '%' || regexp_replace(v_q, '([\\%_])', '\\\1', 'g') || '%';
    v_prefix := regexp_replace(v_q, '([\\%_])', '\\\1', 'g') || '%';
  end if;

  return query
  select p.id
  from public.predictions p
  join public.user_profiles u on u.id = p.user_id
  join public.markets m on m.id = p.market_id
  left join public.fixtures f on f.id = m.fixture_id
  where (p_state is null or p.lifecycle_state = p_state)
    and (p_result is null or (p_result = 'NONE' and p.result is null) or p.result = p_result)
    and (p_from is null or p.created_at >= p_from::timestamptz)
    and (p_to is null or p.created_at < (p_to + 1)::timestamptz)
    and (
      v_q is null
      or u.username ilike v_like
      or u.display_name ilike v_like
      or p.user_id::text ilike v_prefix
      or p.id::text ilike v_prefix
      or p.market_id::text ilike v_prefix
      or m.question ilike v_like
      or f.home_team_name ilike v_like
      or f.away_team_name ilike v_like
    )
  order by p.created_at desc
  limit greatest(least(coalesce(p_limit, 200), 500), 1);
end;
$$;

revoke all on function public.admin_search_predictions(text, text, text, date, date, integer) from public, anon, authenticated;
grant execute on function public.admin_search_predictions(text, text, text, date, date, integer) to service_role;

comment on function public.admin_search_predictions(text, text, text, date, date, integer) is
  'Read-only: ids of the most recent Predictions matching a literal substring/prefix query and optional state/result/date filters, for the admin Predictions table. Service-role only.';

