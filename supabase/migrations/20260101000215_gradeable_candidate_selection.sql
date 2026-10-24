-- Grading starvation fix: choose the batch from the Picks (and accepted Call BS challenges) that can actually be processed NOW.
--
-- THE BUG. The grading job took the oldest `grading_batch_size` (default 200) PENDING Picks and only afterwards looked at each Pick's Market and Game
-- (lib/predictions/grading.ts). Picks on Games that have not finished therefore filled the whole batch, and Picks on finished Games behind them were
-- never reached (reproduced on staging: 200 examined, 0 graded). The Call BS resolver had the same shape: the oldest 200 ACCEPTED challenges, whether or
-- not their Picks were graded. Raising the batch size only moves the cliff; the fix is the order of operations: FILTER to what is processable, THEN order, THEN limit.
--
-- WHAT THESE FUNCTIONS DO. They are pure candidate selection. Nothing here grades, settles, resolves, writes or changes any semantics.
--   * The Game-state model stays in application code (lib/predictions/sports-resolution.ts, which decides MONEYLINE / SPREAD / TOTAL results): the caller passes the
--     fixture status that grades from the score, the one that voids, and the sports whose finished games cannot end level. No second status model lives in SQL.
--   * A Pick is processable when it is PENDING and either its Market is ARCHIVED (graded VOID whatever the Game did) or its Game is in one of the two terminal
--     statuses the grader acts on. Scheduled, live, postponed, suspended, abandoned, awarded Games are not candidates.
--   * Order (deterministic): ordinary candidates first, then "unsafe final" ones — a Game recorded as finished with no score, or level in a sport that cannot end level.
--     The grader deliberately does NOT grade those (it reports them once per Game); sorting them last keeps a few unsafe Games from re-occupying the batch forever,
--     while they are still selected, and so still reported, whenever there is spare capacity. Then oldest Game first, then oldest Pick, then id.
--   * LIMIT is applied after all of that, so a batch of 1 selects one processable Pick, not one arbitrary pending Pick.
-- Indexes already cover this: predictions_lifecycle_state_idx (partial, PENDING), idx_markets_fixture_id, the fixtures primary key and idx_fixtures_internal_status.
-- Additive and backward compatible: no table, column, constraint, grant or existing function changes. Execution is for the service role only.

create or replace function public.list_gradeable_pending_predictions(
  p_limit integer,
  p_resolvable_status text,
  p_void_status text,
  p_level_final_sports text[] default '{}'
)
returns setof public.predictions
language sql
stable
set search_path = public
as $$
  select p.*
  from public.predictions p
  join public.markets m on m.id = p.market_id
  join public.fixtures f on f.id = m.fixture_id
  where p.lifecycle_state = 'PENDING'
    and (m.status = 'ARCHIVED' or f.internal_status::text in (p_resolvable_status, p_void_status))
  order by
    case
      when m.status <> 'ARCHIVED'
       and f.internal_status::text = p_resolvable_status
       and (f.home_score is null or f.away_score is null or (f.home_score = f.away_score and f.sport = any (p_level_final_sports)))
      then 1 else 0
    end,
    f.scheduled_start_utc,
    p.created_at,
    p.id
  limit greatest(p_limit, 0);
$$;
revoke all on function public.list_gradeable_pending_predictions(integer, text, text, text[]) from public, anon, authenticated;
grant execute on function public.list_gradeable_pending_predictions(integer, text, text, text[]) to service_role;

-- ACCEPTED Call BS challenges whose two Picks are both GRADED: exactly the ones the resolver can resolve (decideChallengeResolution returns "still-pending" otherwise).
-- Same rule: filter, order, then limit. Oldest acceptance first, then id.
create or replace function public.list_resolvable_accepted_challenges(p_limit integer)
returns setof public.challenges
language sql
stable
set search_path = public
as $$
  select c.*
  from public.challenges c
  join public.predictions a on a.id = c.challenger_prediction_id
  join public.predictions b on b.id = c.recipient_prediction_id
  where c.status = 'ACCEPTED'
    and a.lifecycle_state = 'GRADED'
    and b.lifecycle_state = 'GRADED'
  order by c.accepted_at, c.id
  limit greatest(p_limit, 0);
$$;
revoke all on function public.list_resolvable_accepted_challenges(integer) from public, anon, authenticated;
grant execute on function public.list_resolvable_accepted_challenges(integer) to service_role;
