-- Brohda 2.1 M5 — Retention & competitive identity: two READ-ONLY functions that turn the canonical prediction and Call BS history into a Member's record. Nothing is stored.
--
-- No table, column, counter, trigger, setting or policy is added or changed; no existing function is replaced. Both functions only read rows that already exist (predictions, markets, fixtures,
-- confidence_prediction_stakes, challenges), are SECURITY DEFINER with a fixed search_path, and are executable by the service role only (the server decides who may see what). Nothing here can be
-- written to by a Member, so a Member cannot submit their own accuracy, streak or record. Rollback = drop the two functions (nothing depends on them but the M5 profile card).
--
-- Numbered 218: production is at 217 (215 -> 217), staging additionally holds the abandoned 216; 218 is unambiguous on both and on a fresh database.
--
-- Semantics (the same words the product uses):
--   * A pick COUNTS once it is GRADED. correct / incorrect are the decided picks; VOID is counted separately and is never in a denominator or a sequence.
--   * Order of picks (form, streaks) = the order the GAMES were played (fixtures.scheduled_start_utc; graded_at, then created_at, only for a pick whose Game row is gone), never the order the grading job
--     happened to process them. VOID and pending picks are IGNORED by form and streaks: they neither extend nor break a run.
--   * "This week" = the same platform week the leaderboard uses (date_trunc('week') in America/Costa_Rica, the constant get_prediction_leaderboard() uses), on graded_at.
--   * Call BS follows get_call_bs_record(): only RESOLVED challenges, one counted result per (my pick, opponent) pair.

create or replace function public.member_record_summary(p_user_id uuid, p_form integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_week_start timestamptz := date_trunc('week', now() at time zone 'America/Costa_Rica') at time zone 'America/Costa_Rica';
  v_form integer := least(greatest(coalesce(p_form, 10), 1), 50);
  v_result jsonb;
begin
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
    'this_week', (select jsonb_build_object('correct', count(*) filter (where result = 'CORRECT'), 'incorrect', count(*) filter (where result = 'INCORRECT')) from picks where graded_at >= v_week_start),
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

comment on function public.member_record_summary(uuid, integer) is
  'M5: a Member''s record derived from GRADED predictions only: totals, recent form, current and best streak, this week, Confidence-backed picks, sport and sport-season breakdown. VOID and pending are ignored by form and streaks. Read-only; service role only.';

-- The Members this Member has settled the most Call BS with: deterministic (most matchups, then most recent, then id). Same dedup as get_call_bs_record (one result per my pick and opponent).
create or replace function public.member_call_bs_opponents(p_user_id uuid, p_limit integer default 3)
returns table (opponent_id uuid, wins integer, losses integer, voids integer, matchups integer, last_resolved_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with my_events as (
    select
      case when c.challenger_user_id = p_user_id then c.challenger_prediction_id else c.recipient_prediction_id end as my_pick_id,
      case when c.challenger_user_id = p_user_id then c.recipient_user_id else c.challenger_user_id end as opponent_user_id,
      case
        when c.result = 'VOID' then 'VOID'
        when (c.challenger_user_id = p_user_id and c.result = 'CHALLENGER_WON') or (c.recipient_user_id = p_user_id and c.result = 'RECIPIENT_WON') then 'WON'
        else 'LOST'
      end as outcome,
      c.resolved_at
    from public.challenges c
    where c.status = 'RESOLVED' and (c.challenger_user_id = p_user_id or c.recipient_user_id = p_user_id)
  ),
  deduped as (
    select distinct on (my_pick_id, opponent_user_id) my_pick_id, opponent_user_id, outcome, resolved_at
    from my_events
    order by my_pick_id, opponent_user_id, outcome, resolved_at desc nulls last
  )
  select opponent_user_id,
         (count(*) filter (where outcome = 'WON'))::integer,
         (count(*) filter (where outcome = 'LOST'))::integer,
         (count(*) filter (where outcome = 'VOID'))::integer,
         (count(*))::integer,
         max(resolved_at)
  from deduped
  group by opponent_user_id
  order by count(*) desc, max(resolved_at) desc nulls last, opponent_user_id
  limit least(greatest(coalesce(p_limit, 3), 1), 20);
$$;

revoke all on function public.member_call_bs_opponents(uuid, integer) from public, anon, authenticated;
grant execute on function public.member_call_bs_opponents(uuid, integer) to service_role;

comment on function public.member_call_bs_opponents(uuid, integer) is
  'M5: the opponents a Member has settled the most Call BS with (RESOLVED only, one result per pick and opponent), with the Member''s record against each. Read-only; service role only.';
