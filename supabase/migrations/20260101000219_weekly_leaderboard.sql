-- Brohda 2.1 M6 — Weekly competition & leaderboard: the policy, one canonical week, one read-only ranking function. Nothing is stored.
--
-- The leaderboard is arithmetic over rows that already exist (predictions -> markets -> fixtures). No table, no counter, no snapshot and no job is added; a new week is just a new time window, and last
-- week's picks stay exactly where they were. What this migration adds:
--   1. three settings on platform_settings, all with safe defaults, so applying this migration or deploying the code exposes NOTHING:
--        leaderboard_enabled                     boolean, default FALSE (the whole feature is invisible until a Super Admin turns it on);
--        leaderboard_weekly_min_decided_picks    integer, default 5   (decided picks THIS WEEK needed to be ranked; independent of leaderboard_min_decided_picks, which keeps meaning
--                                                 "decided picks before a PERCENTAGE is shown" on profiles and is left exactly as it is);
--        leaderboard_top_n                       integer, default 20  (how many Members the page lists).
--   2. platform_week_bounds(): the ONE definition of "the week" (Monday 00:00 -> next Monday 00:00, America/Costa_Rica) that the leaderboard and a profile's "This week" now both read.
--   3. get_weekly_leaderboard(): the ranked top N, the viewer's own position (even outside the top N) and their progress toward qualifying; service role only.
--   4. admin_set_leaderboard_policy(): the audited Super-Admin switch for the three settings.
--   5. member_record_summary() (M5) is re-created with ONE change: "This week" now counts a pick in the week its GAME was played, the same rule as the leaderboard, so a Member's profile and the
--      leaderboard can never disagree about the same week. Everything else in that function is identical to migration 218.
--
-- Numbering: 219 (production 218, staging 218 + the abandoned 216): unambiguous on both and on a fresh database. No down migration: turning leaderboard_enabled off is the whole rollback, and nothing
-- written by this migration depends on anything else.
--
-- THE WEEKLY RULES (the same words the product uses):
--   * A pick belongs to the week in which its GAME was scheduled to start (fixtures.scheduled_start_utc), not to whenever the grading job happened to run. Only a pick whose Game row is gone falls back
--     to graded_at, then created_at (the same fallback as M5's form and streaks). Grading takes ~3 hours (max 7.3 h observed in production), so late Sunday Games are graded after Monday 00:00 in Costa Rica:
--     attributing by graded_at would move them into the next week's competition.
--   * Only GRADED picks that are CORRECT or INCORRECT count. Pending and void picks never count toward the record, accuracy or the minimum.
--   * Ranked = decided picks this week >= leaderboard_weekly_min_decided_picks (never fewer than 1). Role 'player' and is_active only (the existing leaderboard exclusion: staff and deactivated or closed
--     accounts are never ranked). Blocks are NOT applied, as everywhere else on global surfaces.
--   * Order: accuracy (exact, correct / decided), then more correct picks, then fewer incorrect picks. For accuracy above 0% "more correct" already decides everything; "fewer incorrect" only separates
--     0% records (0-3 above 0-5), because volume must not be rewarded at zero. Members whose records are identical share a rank (standard competition ranking: 1, 1, 3); within a shared rank the order is
--     the Member id, so two requests always list the same people in the same order.
--   * No odds, no difficulty, no Confidence, no Call BS and no comments enter the ranking.

alter table public.platform_settings
  add column leaderboard_enabled boolean not null default false,
  add column leaderboard_weekly_min_decided_picks integer not null default 5 check (leaderboard_weekly_min_decided_picks between 1 and 50),
  add column leaderboard_top_n integer not null default 20 check (leaderboard_top_n between 3 and 100);

comment on column public.platform_settings.leaderboard_enabled is
  'M6: when true, the weekly leaderboard page and its navigation entry exist. Default false = the feature is invisible and nothing is computed. Edited only through admin_set_leaderboard_policy().';
comment on column public.platform_settings.leaderboard_weekly_min_decided_picks is
  'M6: decided (correct + incorrect) picks a Member needs in the current week to be ranked. Independent of leaderboard_min_decided_picks (the profile percentage minimum). Edited only through admin_set_leaderboard_policy().';
comment on column public.platform_settings.leaderboard_top_n is
  'M6: how many ranked Members the weekly leaderboard lists (the viewer''s own position is always shown as well). Edited only through admin_set_leaderboard_policy().';
comment on column public.platform_settings.leaderboard_min_decided_picks is
  'Decided (correct + incorrect) picks a Member needs before a PERCENTAGE is shown next to their record (M5), and the legacy get_prediction_leaderboard() minimum. It does NOT control the M6 weekly leaderboard, which has its own leaderboard_weekly_min_decided_picks. The raw record is always shown.';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The one week. America/Costa_Rica has no daylight-saving time, but the calculation is timezone-aware anyway. Stable, reads nothing, callable by the service role only.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.platform_week_bounds(p_at timestamptz default now())
returns table (week_start timestamptz, week_end timestamptz)
language sql
stable
set search_path = public
as $$
  select date_trunc('week', p_at at time zone 'America/Costa_Rica') at time zone 'America/Costa_Rica',
         (date_trunc('week', p_at at time zone 'America/Costa_Rica') + interval '7 days') at time zone 'America/Costa_Rica';
$$;

revoke all on function public.platform_week_bounds(timestamptz) from public, anon, authenticated;
grant execute on function public.platform_week_bounds(timestamptz) to service_role;

comment on function public.platform_week_bounds(timestamptz) is
  'M6: the platform week containing p_at: Monday 00:00 to the next Monday 00:00 in America/Costa_Rica. The single definition read by get_weekly_leaderboard() and member_record_summary().';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The weekly leaderboard. p_viewer_id (optional) adds that Member's own position; p_limit NULL = the configured top N; p_at lets tests and audits ask about any week (the app never passes it).
-- Returns one jsonb object so the application parses a single, fail-closed shape.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.get_weekly_leaderboard(
  p_viewer_id uuid default null,
  p_limit integer default null,
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_min integer;
  v_top integer;
  v_start timestamptz;
  v_end timestamptz;
  v_total bigint;
  v_entries jsonb;
  v_me jsonb;
begin
  select greatest(coalesce(leaderboard_weekly_min_decided_picks, 5), 1), coalesce(leaderboard_top_n, 20)
    into v_min, v_top from public.platform_settings where id = true;
  v_min := coalesce(v_min, 5);
  v_top := least(greatest(coalesce(p_limit, v_top, 20), 1), 100);
  select b.week_start, b.week_end into v_start, v_end from public.platform_week_bounds(p_at) b;

  with picks as (
    -- A pick on a Game scheduled inside the week ...
    select p.user_id, p.result
    from public.fixtures f
    join public.markets m on m.fixture_id = f.id
    join public.predictions p on p.market_id = m.id
    where f.scheduled_start_utc >= v_start and f.scheduled_start_utc < v_end
      and p.lifecycle_state = 'GRADED' and p.result in ('CORRECT', 'INCORRECT')
    union all
    -- ... or, only when its Game row is gone, the week it was graded (the same fallback as M5's form and streaks).
    select p.user_id, p.result
    from public.predictions p
    left join public.markets m on m.id = p.market_id
    left join public.fixtures f on f.id = m.fixture_id
    where f.id is null
      and p.lifecycle_state = 'GRADED' and p.result in ('CORRECT', 'INCORRECT')
      and coalesce(p.graded_at, p.created_at) >= v_start and coalesce(p.graded_at, p.created_at) < v_end
  ),
  agg as (
    select pk.user_id as uid,
           (count(*) filter (where pk.result = 'CORRECT'))::integer as c,
           (count(*) filter (where pk.result = 'INCORRECT'))::integer as i
    from picks pk
    group by pk.user_id
  ),
  eligible as (
    select a.uid, a.c, a.i, (a.c + a.i) as d, (a.c::numeric / (a.c + a.i)) as acc
    from agg a
    join public.user_profiles up on up.id = a.uid
    where up.role = 'player' and up.is_active = true and up.account_closed_at is null
  ),
  ranked as (
    select e.*,
           rank() over (order by e.acc desc, e.c desc, e.i asc) as rnk,
           row_number() over (order by e.acc desc, e.c desc, e.i asc, e.uid asc) as pos,
           count(*) over (partition by e.acc, e.c, e.i) as same_record
    from eligible e
    where e.d >= v_min
  )
  select (select count(*) from ranked),
         (select coalesce(jsonb_agg(jsonb_build_object(
                   'rank', r.rnk, 'tied', r.same_record > 1, 'user_id', r.uid, 'display_name', up.display_name, 'username', up.username, 'avatar_url', up.avatar_url,
                   'correct', r.c, 'incorrect', r.i, 'decided', r.d, 'accuracy', round(r.acc, 4)) order by r.pos), '[]'::jsonb)
          from ranked r join public.user_profiles up on up.id = r.uid where r.pos <= v_top),
         -- The viewer's own standing, from the same rows: their record (zero when they have no decided pick yet), whether they are ranked, how many more decided picks they need, and their position
         -- (1 + the ranked Members strictly ahead of their record, the same shared-rank rule as the list). A staff or deactivated account is never ranked and is told so.
         (case
            when p_viewer_id is null then null
            when v.id is null then jsonb_build_object('ranked', false, 'eligible', false, 'reason', 'unknown')
            when v.role <> 'player' or v.is_active is not true or v.account_closed_at is not null then jsonb_build_object('ranked', false, 'eligible', false, 'reason', 'not_ranked_account')
            else jsonb_build_object(
              'eligible', true, 'correct', coalesce(m.c, 0), 'incorrect', coalesce(m.i, 0), 'decided', coalesce(m.c, 0) + coalesce(m.i, 0),
              'accuracy', case when coalesce(m.c, 0) + coalesce(m.i, 0) > 0 then round(m.c::numeric / (m.c + m.i), 4) else null end,
              'ranked', coalesce(m.c, 0) + coalesce(m.i, 0) >= v_min,
              'needed', greatest(v_min - (coalesce(m.c, 0) + coalesce(m.i, 0)), 0),
              'rank', case when coalesce(m.c, 0) + coalesce(m.i, 0) >= v_min then 1 + (
                        select count(*) from ranked r
                        where r.acc > (m.c::numeric / (m.c + m.i))
                           or (r.acc = (m.c::numeric / (m.c + m.i)) and (r.c > m.c or (r.c = m.c and r.i < m.i)))) else null end)
          end)
    into v_total, v_entries, v_me
    from (select 1) one
    left join public.user_profiles v on v.id = p_viewer_id
    left join agg m on m.uid = p_viewer_id;

  return jsonb_build_object(
    'week_start', v_start, 'week_end', v_end, 'min_decided', v_min, 'top_n', v_top,
    'total_ranked', v_total, 'entries', v_entries, 'me', v_me);
end;
$$;

revoke all on function public.get_weekly_leaderboard(uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.get_weekly_leaderboard(uuid, integer, timestamptz) to service_role;

comment on function public.get_weekly_leaderboard(uuid, integer, timestamptz) is
  'M6: the weekly leaderboard derived at read time from GRADED correct/incorrect picks on Games scheduled in the platform week: ranked top N, the viewer''s own position and progress, week bounds and the minimum. Read-only; service role only. Aggregates only (no pick, market, balance or email).';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The audited switch. Super Admin only (service role + require_super_admin). Every argument is optional: NULL = leave that setting as it is. Idempotent: a call that changes nothing writes nothing.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_set_leaderboard_policy(
  p_admin_id uuid,
  p_enabled boolean default null,
  p_weekly_min integer default null,
  p_top_n integer default null
)
returns public.platform_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.platform_settings;
  v_after public.platform_settings;
begin
  perform public.require_super_admin(p_admin_id);
  if p_weekly_min is not null and (p_weekly_min < 1 or p_weekly_min > 50) then raise exception 'invalid_policy'; end if;
  if p_top_n is not null and (p_top_n < 3 or p_top_n > 100) then raise exception 'invalid_policy'; end if;

  select * into v_before from public.platform_settings where id = true for update;
  if (p_enabled is null or p_enabled = v_before.leaderboard_enabled)
     and (p_weekly_min is null or p_weekly_min = v_before.leaderboard_weekly_min_decided_picks)
     and (p_top_n is null or p_top_n = v_before.leaderboard_top_n) then
    return v_before;
  end if;

  update public.platform_settings set
    leaderboard_enabled = coalesce(p_enabled, leaderboard_enabled),
    leaderboard_weekly_min_decided_picks = coalesce(p_weekly_min, leaderboard_weekly_min_decided_picks),
    leaderboard_top_n = coalesce(p_top_n, leaderboard_top_n),
    updated_at = now(), updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
    values (p_admin_id, 'settings.leaderboard_policy_updated', 'platform_settings', null,
      jsonb_build_object('leaderboard_enabled', v_before.leaderboard_enabled, 'leaderboard_weekly_min_decided_picks', v_before.leaderboard_weekly_min_decided_picks, 'leaderboard_top_n', v_before.leaderboard_top_n),
      jsonb_build_object('leaderboard_enabled', v_after.leaderboard_enabled, 'leaderboard_weekly_min_decided_picks', v_after.leaderboard_weekly_min_decided_picks, 'leaderboard_top_n', v_after.leaderboard_top_n));
  return v_after;
end;
$$;

revoke all on function public.admin_set_leaderboard_policy(uuid, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_set_leaderboard_policy(uuid, boolean, integer, integer) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- M5's record, re-created with exactly one change (marked below): "This week" follows the Game, not the grading job. Everything else is byte-for-byte the migration 218 body.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.member_record_summary(p_user_id uuid, p_form integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_week_start timestamptz;
  v_week_end timestamptz;
  v_form integer := least(greatest(coalesce(p_form, 10), 1), 50);
  v_result jsonb;
begin
  select b.week_start, b.week_end into v_week_start, v_week_end from public.platform_week_bounds(now()) b;
  with picks as (
    select p.id, p.result, p.graded_at, f.sport, f.season,
           coalesce(f.scheduled_start_utc, p.graded_at, p.created_at) as at,
           (s.id is not null) as has_confidence
    from public.predictions p
    left join public.markets m on m.id = p.market_id
    left join public.fixtures f on f.id = m.fixture_id
    left join public.confidence_prediction_stakes s on s.prediction_id = p.id
    where p.user_id = p_user_id and p.lifecycle_state = 'GRADED' and p.result in ('CORRECT', 'INCORRECT', 'VOID')
  ),
  decided as (
    select picks.*,
           row_number() over (order by at desc, id desc) as rn_desc,
           row_number() over (order by at asc, id asc) as rn_asc
    from picks where result in ('CORRECT', 'INCORRECT')
  ),
  runs as (
    select result, rn_asc - row_number() over (partition by result order by rn_asc) as grp from decided
  ),
  streak as (
    select (select result from decided where rn_desc = 1) as kind,
           coalesce((select min(rn_desc) - 1 from decided where result <> (select result from decided where rn_desc = 1)), (select count(*) from decided)) as len
  )
  select jsonb_build_object(
    'correct',   (select count(*) from picks where result = 'CORRECT'),
    'incorrect', (select count(*) from picks where result = 'INCORRECT'),
    'void',      (select count(*) from picks where result = 'VOID'),
    'form',      (select coalesce(jsonb_agg(case when result = 'CORRECT' then 'W' else 'L' end order by rn_desc), '[]'::jsonb) from decided where rn_desc <= v_form),
    'current_streak', (select case when kind is null then null else jsonb_build_object('kind', kind, 'length', len) end from streak),
    'best_correct_streak', (select coalesce(max(c), 0) from (select count(*) as c from runs where result = 'CORRECT' group by grp) r),
    -- M6: the week is the one the GAME was played in (the same rule as the weekly leaderboard), not the week the grading job ran.
    'this_week', (select jsonb_build_object('correct', count(*) filter (where result = 'CORRECT'), 'incorrect', count(*) filter (where result = 'INCORRECT')) from picks where at >= v_week_start and at < v_week_end),
    'confidence', (select jsonb_build_object('picks', count(*), 'correct', count(*) filter (where result = 'CORRECT'), 'incorrect', count(*) filter (where result = 'INCORRECT')) from picks where has_confidence),
    'by_sport', (select coalesce(jsonb_agg(jsonb_build_object('sport', sport, 'correct', c, 'incorrect', i, 'void', v) order by (c + i) desc, sport), '[]'::jsonb)
                 from (select coalesce(sport, 'unknown') as sport, count(*) filter (where result = 'CORRECT') c, count(*) filter (where result = 'INCORRECT') i, count(*) filter (where result = 'VOID') v from picks group by 1) s),
    'by_season', (select coalesce(jsonb_agg(jsonb_build_object('sport', sport, 'season', season, 'correct', c, 'incorrect', i) order by season desc, (c + i) desc, sport), '[]'::jsonb)
                  from (select sport, season, count(*) filter (where result = 'CORRECT') c, count(*) filter (where result = 'INCORRECT') i from picks where sport is not null and season is not null group by 1, 2 having count(*) filter (where result in ('CORRECT', 'INCORRECT')) > 0) s)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.member_record_summary(uuid, integer) from public, anon, authenticated;
grant execute on function public.member_record_summary(uuid, integer) to service_role;
