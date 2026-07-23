-- Profile stat row ("Picks / Followers / Following", Instagram-style) and
-- the tappable Followers/Following lists it links to.

-- Total picks ever made — same "any status counts" semantics as
-- Instagram's post count (a settled/cancelled pick still happened).
create or replace function public.get_pick_count(p_user_id uuid)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer from public.entries where user_id = p_user_id;
$$;

revoke all on function public.get_pick_count(uuid) from public;
grant execute on function public.get_pick_count(uuid) to authenticated, service_role;

-- Both list functions read through public.follows the same way
-- get_follow_counts/is_following already do (security definer, since the
-- table itself grants nothing to authenticated) and join to user_profiles
-- filtered to is_active — same population public_profiles exposes,
-- without needing that view's own grant. p_viewer_id is explicit (not
-- auth.uid()) to match is_following's existing calling convention, and so
-- each row can report whether the viewer already follows that person —
-- lets the list render a Follow/Following button per row like Instagram's.
create or replace function public.get_followers(p_user_id uuid, p_viewer_id uuid)
returns table (
  user_id uuid,
  display_name text,
  username text,
  avatar_url text,
  is_following boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select
    up.id,
    up.display_name,
    up.username,
    up.avatar_url,
    exists (
      select 1 from public.follows f2
      where f2.follower_id = p_viewer_id and f2.followee_id = up.id
    )
  from public.follows f
  join public.user_profiles up on up.id = f.follower_id
  where f.followee_id = p_user_id
    and up.is_active = true
  order by f.created_at desc;
$$;

revoke all on function public.get_followers(uuid, uuid) from public;
grant execute on function public.get_followers(uuid, uuid) to authenticated, service_role;

create or replace function public.get_following(p_user_id uuid, p_viewer_id uuid)
returns table (
  user_id uuid,
  display_name text,
  username text,
  avatar_url text,
  is_following boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select
    up.id,
    up.display_name,
    up.username,
    up.avatar_url,
    exists (
      select 1 from public.follows f2
      where f2.follower_id = p_viewer_id and f2.followee_id = up.id
    )
  from public.follows f
  join public.user_profiles up on up.id = f.followee_id
  where f.follower_id = p_user_id
    and up.is_active = true
  order by f.created_at desc;
$$;

revoke all on function public.get_following(uuid, uuid) from public;
grant execute on function public.get_following(uuid, uuid) to authenticated, service_role;
