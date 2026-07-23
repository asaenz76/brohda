-- Profile headers want the same "win rate + streak" story the leaderboard
-- already tells, but for one specific user rather than a ranked list — the
-- all-time correct_count/total_count computation here is intentionally
-- identical to get_leaderboard's p_range = 'all_time' branch (20260101000035),
-- just without the ranking/scope machinery, so the numbers can never drift
-- between "your rank" and "your profile". Granting this to any authenticated
-- caller (not just the profile owner) matches get_leaderboard's own existing
-- exposure level: the global leaderboard already broadcasts every player's
-- correct/total count, so this reveals nothing new.
create or replace function public.get_profile_stats(p_user_id uuid)
returns table (
  correct_count bigint,
  total_count bigint,
  current_streak integer,
  best_streak integer
)
language sql
security definer
set search_path = public
stable
as $$
  select
    up.correct_predictions_count::bigint,
    (
      select count(*)::bigint
      from public.entries e
      where e.user_id = up.id and e.status in ('WON', 'LOST')
    ),
    up.current_streak,
    up.best_streak
  from public.user_profiles up
  where up.id = p_user_id;
$$;

revoke all on function public.get_profile_stats(uuid) from public;
grant execute on function public.get_profile_stats(uuid) to authenticated, service_role;
