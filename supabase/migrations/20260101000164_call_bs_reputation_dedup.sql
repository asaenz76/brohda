-- Milestone R13.5 — resolves R13's own "PRODUCT / ABUSE DECISION
-- REQUIRED — CALL BS REPUTATION FARMING" finding with the locked product
-- rule:
--
--   One Pick can contribute at most one Call BS reputation result
--   against the same opponent.
--
-- Reputation event identity = (the user's own Pick id, the opposing
-- user's id) — NOT the Challenge id, and NOT the opponent's specific
-- Pick id. R7 (20260101000154) deliberately allows the exact same Pick
-- pair to be challenged, accepted, and resolved more than once over time
-- (a locked Pick only blocks further *editing* via set_pick(), never
-- blocks being referenced by another accepted Challenge — see that
-- function's own §56/§57 comment) — this is why "5 resolved Challenges
-- between the same two people" was possible at all, and why it was worth
-- capping at the reputation layer rather than the Challenge-creation
-- layer (§9): raw Challenge history is real social history and stays
-- intact; only the *counted* reputation result collapses to one per
-- (my Pick, opponent) pair.
--
-- Contradictory-results audit (§8): can two resolved Challenges sharing
-- the same (my Pick, opponent) pair disagree about who won? No —
-- structurally impossible by construction. A Challenge's result is
-- derived entirely from decideChallengeResolution() (lib/challenges/
-- resolution.ts), which compares the two Predictions' own `result`
-- columns. My Pick's `result` is fixed once GRADED (and immutable
-- thereafter as of R13's forbid_graded_prediction_mutation trigger).
-- Every valid opposing Pick on the same Market is graded against the
-- exact same deterministic Market outcome, so it is always the logical
-- inverse of my Pick's own result (or VOID, uniformly, if the Market
-- itself voids) — regardless of which specific opposing Prediction row
-- is used. So for a fixed "my Pick", every resolved Challenge referencing
-- it must produce the same WON/LOST/VOID outcome relative to me, no
-- matter which opponent-Pick or how many times it's re-challenged.
-- Verified empirically with zero contradictions against live local data,
-- and covered by a permanent regression test
-- (tests/integration/reputation-leaderboards.test.ts).
--
-- Prediction reputation (get_user_prediction_record,
-- get_prediction_leaderboard) is completely untouched by this migration
-- — this is a Call-BS-only change. Money is not touched or referenced.
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
  with my_events as (
    select
      case when c.challenger_user_id = p_user_id then c.challenger_prediction_id else c.recipient_prediction_id end as my_pick_id,
      case when c.challenger_user_id = p_user_id then c.recipient_user_id else c.challenger_user_id end as opponent_user_id,
      case
        when c.result = 'VOID' then 'VOID'
        when (c.challenger_user_id = p_user_id and c.result = 'CHALLENGER_WON')
          or (c.recipient_user_id = p_user_id and c.result = 'RECIPIENT_WON') then 'WON'
        else 'LOST'
      end as outcome
    from public.challenges c
    where c.status = 'RESOLVED' and (c.challenger_user_id = p_user_id or c.recipient_user_id = p_user_id)
  ),
  -- One reputation event per (my Pick, opponent) pair — DISTINCT ON
  -- collapses any repeat resolved Challenges between the same pair to a
  -- single counted row. The ORDER BY tiebreak (outcome) is inert in
  -- practice per the structural-consistency proof above — every row
  -- within a group already shares the same outcome — but is included so
  -- the query has a well-defined, deterministic result regardless.
  deduped as (
    select distinct on (my_pick_id, opponent_user_id) my_pick_id, opponent_user_id, outcome
    from my_events
    order by my_pick_id, opponent_user_id, outcome
  )
  select
    count(*) filter (where outcome = 'WON')::integer,
    count(*) filter (where outcome = 'LOST')::integer,
    count(*) filter (where outcome = 'VOID')::integer
  from deduped;
end;
$$;

revoke all on function public.get_call_bs_record(uuid) from public, anon;
grant execute on function public.get_call_bs_record(uuid) to authenticated, service_role;
