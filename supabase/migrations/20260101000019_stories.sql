-- Phase 8 (Instagram-style redesign): stories row — a bubble for any
-- followed user with new activity since the viewer's last visit.

-- Single per-viewer timestamp, not a per-(viewer, followee) pair — kept
-- cheap per the plan's explicit call-out. Null means "never visited",
-- treated as "everything currently counts as new" by the app layer
-- (passes epoch as p_since), not "show nothing".
alter table public.user_profiles add column stories_last_seen_at timestamptz;

-- "New activity" (v1, deliberately narrow — refine later rather than
-- over-designing now): a followed user created a new ACTIVE entry, or
-- (if they're a super_admin) published a new pool. Entries aren't broadly
-- readable via RLS (same reasoning as get_pool_participants), so this
-- goes through a security-definer function like every other piece of
-- "who did something" social-proof data in this codebase — never exposes
-- *what* anyone picked, only that they picked.
create or replace function public.get_stories_row(p_viewer_id uuid, p_since timestamptz)
returns table (user_id uuid, display_name text, username text, avatar_url text)
language sql
security definer
set search_path = public
stable
as $$
  select distinct up.id, up.display_name, up.username, up.avatar_url
  from public.user_profiles up
  where up.is_active = true
    and up.id in (select f.followee_id from public.follows f where f.follower_id = p_viewer_id)
    and (
      exists (
        select 1 from public.entries e
        where e.user_id = up.id and e.status = 'ACTIVE' and e.created_at > p_since
      )
      or (
        up.role = 'super_admin'
        and exists (
          select 1 from public.pools p
          where p.created_by = up.id and p.status != 'DRAFT' and p.created_at > p_since
        )
      )
    );
$$;

revoke all on function public.get_stories_row(uuid, timestamptz) from public;
grant execute on function public.get_stories_row(uuid, timestamptz) to authenticated, service_role;
