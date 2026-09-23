-- Milestone R11 (docs/BROHDA_2_0_MILESTONE_MAP.md, Reputation +
-- Leaderboards). Additive only. Turns Brohda's existing immutable
-- `predictions`/`challenges` history into visible social reputation —
-- never money. See docs/architecture/reputation-leaderboards.md for the
-- full rationale.
--
-- Repository-truth-gather confirmed: a legacy pool leaderboard already
-- exists (`get_leaderboard()`, `/leaderboard` route, built entirely on
-- `entries`/`user_profiles.correct_predictions_count`/
-- `correct_prediction_log`) — untouched here, and deliberately never
-- reused, per this milestone's own explicit "do not mix Prediction
-- Network reputation with legacy pool standings" instruction. `predictions`
-- RLS is own-row-only with no public-read policy, so — exactly like the
-- legacy `get_leaderboard()`/`get_profile_stats()`/`get_pick_count()`
-- already do for their own tables — the three functions below are
-- SECURITY DEFINER, deliberately bypassing that RLS to expose only safe,
-- aggregate, already-public-by-Pick-nature fields. No new table, no
-- materialized/cache state: this milestone is 100% query-derived from
-- `predictions`/`challenges`, per its own explicit "smallest correct
-- architecture" guidance — nothing stored here to ever drift or need
-- reconciliation.

-- =====================================================================
-- The one genuinely configurable product policy this milestone needs
-- (§9): a minimum decided-Pick sample for leaderboard eligibility, so a
-- 1-0 (100%) record doesn't outrank a 40-10 (80%) one. No existing
-- founder-sourced number exists for this — 5 is a clearly-flagged,
-- technically-required safe default (a NOT NULL column needs one),
-- reported explicitly rather than silently invented, exactly like R9's
-- own "Option B" precedent for min/max stake.
-- =====================================================================
alter table public.platform_settings
  add column leaderboard_min_decided_picks integer not null default 5 check (leaderboard_min_decided_picks >= 0);

comment on column public.platform_settings.leaderboard_min_decided_picks is
  'Minimum decided (correct+incorrect) graded Picks a user must have before appearing in the Prediction Network leaderboard (docs/architecture/reputation-leaderboards.md) — never affects whether their record itself is visible on their own Profile, only leaderboard ranking eligibility. Read live on every leaderboard/profile-record call; changing it takes effect immediately, no deployment required. Default of 5 is a safe placeholder, not a founder-sourced number — flagged explicitly in R11''s own completion report as a genuinely open product decision.';

-- =====================================================================
-- Two partial indexes, each justified by an actual R11 query shape
-- (§66) — no speculative index explosion. Both scope to GRADED rows only
-- (the vast majority of leaderboard/profile-record reads never care about
-- PENDING Picks at all), mirroring predictions_lifecycle_state_idx's own
-- existing partial-index convention (which instead scopes to PENDING, for
-- the grading job's own opposite need).
-- =====================================================================
create index idx_predictions_graded_user_result on public.predictions (user_id, result) where lifecycle_state = 'GRADED';
create index idx_predictions_graded_at on public.predictions (graded_at) where lifecycle_state = 'GRADED';

comment on index public.idx_predictions_graded_user_result is
  'Serves get_user_prediction_record()''s own per-user aggregate directly, and narrows get_prediction_leaderboard()''s full GROUP BY scan to GRADED rows only (never touching PENDING Picks) for the ALL_TIME period.';
comment on index public.idx_predictions_graded_at is
  'Lets get_prediction_leaderboard() range-scan just the current WEEK/MONTH window''s GRADED rows rather than scanning every graded Pick ever, for the two time-scoped periods.';

-- =====================================================================
-- get_user_prediction_record(): the canonical per-user prediction record
-- (§5-8, §26-28). VOID is counted but never enters the accuracy
-- denominator (§8); a user with zero decided Picks gets a null accuracy,
-- never a fabricated 0% (§5) — this is a TRUE INVARIANT, enforced here
-- unconditionally regardless of how `leaderboard_min_decided_picks` is
-- configured (a config value of 0 must never make a genuinely
-- undefined accuracy rank as if it were 0%).
-- =====================================================================
create or replace function public.get_user_prediction_record(p_user_id uuid)
returns table (
  correct integer,
  incorrect integer,
  void integer,
  decided integer,
  accuracy numeric,
  min_decided_for_leaderboard integer,
  eligible_for_leaderboard boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_min_decided integer;
  v_correct integer;
  v_incorrect integer;
  v_void integer;
  v_decided integer;
begin
  select coalesce(leaderboard_min_decided_picks, 5) into v_min_decided from public.platform_settings where id = true;

  select
    count(*) filter (where p.result = 'CORRECT'),
    count(*) filter (where p.result = 'INCORRECT'),
    count(*) filter (where p.result = 'VOID')
    into v_correct, v_incorrect, v_void
  from public.predictions p
  where p.user_id = p_user_id and p.lifecycle_state = 'GRADED';

  v_decided := v_correct + v_incorrect;

  return query select
    v_correct,
    v_incorrect,
    v_void,
    v_decided,
    case when v_decided > 0 then round(v_correct::numeric / v_decided, 4) else null end,
    v_min_decided,
    (v_decided > 0 and v_decided >= v_min_decided);
end;
$$;

revoke all on function public.get_user_prediction_record(uuid) from public, anon;
grant execute on function public.get_user_prediction_record(uuid) to authenticated, service_role;

-- =====================================================================
-- get_call_bs_record(): the separate head-to-head record (§20-23). Only
-- RESOLVED Challenges count (excludes PENDING/DECLINED/EXPIRED by
-- construction — those never reach 'RESOLVED'). A user may be the
-- challenger OR the recipient of any given Challenge, so wins/losses are
-- computed relative to whichever side p_user_id was on. Multiple accepted
-- Challenges on the same Pick each count independently (§22-23) — this
-- function counts Challenge ROWS, never touches `predictions` at all, so
-- it cannot inflate or interact with prediction-accuracy counting.
-- =====================================================================
create or replace function public.get_call_bs_record(p_user_id uuid)
returns table (
  wins integer,
  losses integer,
  void integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    count(*) filter (where
      (c.challenger_user_id = p_user_id and c.result = 'CHALLENGER_WON')
      or (c.recipient_user_id = p_user_id and c.result = 'RECIPIENT_WON')
    )::integer,
    count(*) filter (where
      (c.challenger_user_id = p_user_id and c.result = 'RECIPIENT_WON')
      or (c.recipient_user_id = p_user_id and c.result = 'CHALLENGER_WON')
    )::integer,
    count(*) filter (where c.result = 'VOID')::integer
  from public.challenges c
  where c.status = 'RESOLVED' and (c.challenger_user_id = p_user_id or c.recipient_user_id = p_user_id);
end;
$$;

revoke all on function public.get_call_bs_record(uuid) from public, anon;
grant execute on function public.get_call_bs_record(uuid) to authenticated, service_role;

-- =====================================================================
-- get_prediction_leaderboard(): the ranked, paginated, period-scoped
-- leaderboard (§9-14, §29-33, §49-50). 100% query-derived, no
-- materialized state. Period boundaries evaluate in the platform's own
-- existing analytics-timezone convention (lib/analytics/timezone.ts's
-- DEFAULT_ANALYTICS_TIMEZONE = 'America/Costa_Rica', already the
-- established platform-wide default used for admin/platform-scoped
-- aggregates such as get_platform_monthly_activity — a leaderboard is
-- exactly that kind of shared, non-per-viewer aggregate, so this reuses
-- that existing decision rather than inventing a new one or silently
-- defaulting to server/UTC wall-clock time the way the legacy pool
-- get_leaderboard() does today).
--
-- Ranking (§11, §49-50): eligible users (role='player', is_active=true —
-- reusing get_leaderboard()'s own exact existing exclusion filter;
-- decided >= configured minimum AND decided > 0, the latter a TRUE
-- INVARIANT independent of configuration) ordered by accuracy DESC
-- (exact NUMERIC comparison, never floating point), decided DESC, correct
-- DESC, user id ASC — sequential ROW_NUMBER(), never RANK()/DENSE_RANK():
-- ties are broken all the way down to a stable identity, so no two users
-- ever share a displayed rank, a deliberate divergence from the legacy
-- pool leaderboard's own RANK()-with-shared-ties convention (a different
-- domain's own product choice, not binding here — see this milestone's
-- own completion report).
-- =====================================================================
create or replace function public.get_prediction_leaderboard(
  p_period text,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  user_id uuid,
  display_name text,
  username text,
  avatar_url text,
  correct integer,
  incorrect integer,
  void integer,
  decided integer,
  accuracy numeric,
  rank bigint,
  total_eligible bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_min_decided integer;
  v_period_start timestamptz;
  v_timezone constant text := 'America/Costa_Rica';
begin
  if p_period not in ('ALL_TIME', 'WEEK', 'MONTH') then
    raise exception 'invalid_period';
  end if;
  if p_limit is null or p_limit <= 0 or p_limit > 200 then
    p_limit := 50;
  end if;
  if p_offset is null or p_offset < 0 then
    p_offset := 0;
  end if;

  select coalesce(leaderboard_min_decided_picks, 5) into v_min_decided from public.platform_settings where id = true;

  if p_period = 'WEEK' then
    v_period_start := date_trunc('week', now() at time zone v_timezone) at time zone v_timezone;
  elsif p_period = 'MONTH' then
    v_period_start := date_trunc('month', now() at time zone v_timezone) at time zone v_timezone;
  else
    v_period_start := null;
  end if;

  return query
  with agg as (
    select
      p.user_id as uid,
      count(*) filter (where p.result = 'CORRECT') as correct_c,
      count(*) filter (where p.result = 'INCORRECT') as incorrect_c,
      count(*) filter (where p.result = 'VOID') as void_c
    from public.predictions p
    where p.lifecycle_state = 'GRADED'
      and (v_period_start is null or p.graded_at >= v_period_start)
    group by p.user_id
  ),
  eligible as (
    select
      a.uid,
      a.correct_c,
      a.incorrect_c,
      a.void_c,
      (a.correct_c + a.incorrect_c) as decided_c,
      (a.correct_c::numeric / (a.correct_c + a.incorrect_c)) as acc
    from agg a
    join public.user_profiles up on up.id = a.uid
    where up.role = 'player'
      and up.is_active = true
      and (a.correct_c + a.incorrect_c) > 0
      and (a.correct_c + a.incorrect_c) >= v_min_decided
  ),
  ranked as (
    select
      e.*,
      row_number() over (order by e.acc desc, e.decided_c desc, e.correct_c desc, e.uid asc) as rn,
      count(*) over () as total_c
    from eligible e
  )
  select
    r.uid,
    up.display_name,
    up.username,
    up.avatar_url,
    r.correct_c::integer,
    r.incorrect_c::integer,
    r.void_c::integer,
    r.decided_c::integer,
    round(r.acc, 4),
    r.rn,
    r.total_c
  from ranked r
  join public.user_profiles up on up.id = r.uid
  order by r.rn
  limit p_limit offset p_offset;
end;
$$;

revoke all on function public.get_prediction_leaderboard(text, integer, integer) from public, anon;
grant execute on function public.get_prediction_leaderboard(text, integer, integer) to authenticated, service_role;
