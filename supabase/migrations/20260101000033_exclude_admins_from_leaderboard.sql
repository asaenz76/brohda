-- Admins/super_admins coordinate pools, they aren't ranked players — exclude
-- them from the leaderboard entirely (both scopes, all ranges), even from
-- their own "following"/self view. Same role check as create_pool_entry's
-- admin_cannot_enter_pool guard: admin accounts sit outside the player
-- competition altogether.

create or replace function public.get_leaderboard(p_scope text, p_range text, p_caller_id uuid)
returns table (
  user_id uuid, display_name text, username text, avatar_url text, correct_count bigint, rank bigint
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if p_range = 'all_time' then
    return query
      select
        up.id,
        up.display_name,
        up.username,
        up.avatar_url,
        up.correct_predictions_count,
        rank() over (order by up.correct_predictions_count desc)
      from public.user_profiles up
      where up.is_active = true
        and up.role = 'player'
        and (
          p_scope = 'global'
          or up.id = p_caller_id
          or up.id in (select f.followee_id from public.follows f where f.follower_id = p_caller_id)
        )
      order by up.correct_predictions_count desc
      limit 100;
  else
    return query
      select
        up.id,
        up.display_name,
        up.username,
        up.avatar_url,
        coalesce(counts.cnt, 0),
        rank() over (order by coalesce(counts.cnt, 0) desc)
      from public.user_profiles up
      left join (
        select cpl.user_id, count(*) as cnt
        from public.correct_prediction_log cpl
        where cpl.created_at >= case p_range
          when 'weekly' then date_trunc('week', now())
          when 'monthly' then date_trunc('month', now())
          else '-infinity'::timestamptz
        end
        group by cpl.user_id
      ) counts on counts.user_id = up.id
      where up.is_active = true
        and up.role = 'player'
        and (
          p_scope = 'global'
          or up.id = p_caller_id
          or up.id in (select f.followee_id from public.follows f where f.follower_id = p_caller_id)
        )
      order by coalesce(counts.cnt, 0) desc
      limit 100;
  end if;
end;
$$;
