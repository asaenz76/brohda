-- The previous migration ranked by win rate then raw correct_count, but
-- left ties with equal rate AND equal correct_count (e.g. two players both
-- 1/1) to fall out however Postgres's query plan happened to order them —
-- not a rule, just whatever the plan produced, and not guaranteed stable
-- across calls.
--
-- total_count desc is added as a real tiebreaker on the *rank number*
-- itself — same rate over a bigger sample is a stronger track record
-- (10/10 outranks 1/1 even though both are 100%). display_name asc is
-- added only to the final row order, not to rank()'s own ORDER BY: two
-- players who are genuinely identical (same wins, same losses, same
-- total) should still show the *same* rank number — that's a real tie,
-- same as Olympic scoring (1, 1, 3) — display_name just keeps their
-- relative position on screen stable across page loads instead of
-- whatever the query planner felt like that time.

drop function if exists public.get_leaderboard(text, text, uuid);

create or replace function public.get_leaderboard(p_scope text, p_range text, p_caller_id uuid)
returns table (
  user_id uuid, display_name text, username text, avatar_url text,
  correct_count bigint, total_count bigint, rank bigint
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_window_start timestamptz;
begin
  v_window_start := case p_range
    when 'weekly' then date_trunc('week', now())
    when 'monthly' then date_trunc('month', now())
    else '-infinity'::timestamptz
  end;

  return query
    with picks as (
      select
        up.id as pick_user_id,
        up.display_name as pick_display_name,
        up.username as pick_username,
        up.avatar_url as pick_avatar_url,
        case
          when p_range = 'all_time' then up.correct_predictions_count
          else (
            select count(*)::bigint
            from public.correct_prediction_log cpl
            where cpl.user_id = up.id and cpl.created_at >= v_window_start
          )
        end as pick_correct_count,
        (
          select count(*)::bigint
          from public.entries e
          where e.user_id = up.id
            and e.status in ('WON', 'LOST')
            and (p_range = 'all_time' or e.updated_at >= v_window_start)
        ) as pick_total_count
      from public.user_profiles up
      where up.is_active = true
        and up.role = 'player'
        and (
          p_scope = 'global'
          or up.id = p_caller_id
          or up.id in (select f.followee_id from public.follows f where f.follower_id = p_caller_id)
        )
    )
    select
      picks.pick_user_id,
      picks.pick_display_name,
      picks.pick_username,
      picks.pick_avatar_url,
      picks.pick_correct_count,
      picks.pick_total_count,
      rank() over (
        order by
          case when picks.pick_total_count > 0
            then picks.pick_correct_count::numeric / picks.pick_total_count
            else 0
          end desc,
          picks.pick_correct_count desc,
          picks.pick_total_count desc
      )
    from picks
    order by
      case when picks.pick_total_count > 0
        then picks.pick_correct_count::numeric / picks.pick_total_count
        else 0
      end desc,
      picks.pick_correct_count desc,
      picks.pick_total_count desc,
      picks.pick_display_name asc
    limit 100;
end;
$$;

revoke all on function public.get_leaderboard(text, text, uuid) from public;
grant execute on function public.get_leaderboard(text, text, uuid) to authenticated, service_role;
