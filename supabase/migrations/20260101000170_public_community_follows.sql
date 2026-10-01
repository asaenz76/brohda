-- Phase G (Brohda 2.0 redesign, spec §15) — Phase F put declared Community
-- follows on a public Profile ("Communities" tab, visible to any
-- authenticated viewer), but that read path (lib/communities/profile.ts's
-- listFollowedCommunitiesForProfile) went through the service-role admin
-- client — functionally fine (every lib/communities/* query already
-- bypasses RLS this way), but it meant the "this data is public" boundary
-- was enforced only by that one TypeScript function never taking an
-- arbitrary caller-supplied filter, not by the database itself.
--
-- This view moves that boundary to where public_profiles already put the
-- equivalent one for profile fields (20260101000038): a narrow, directly
-- granted view, so a future careless admin-client query elsewhere in
-- lib/communities/* can't silently widen what's publicly exposed here.
-- `community_follows` itself keeps its existing RLS (`select_own_community_follows`,
-- 20260101000151) unchanged — this is additive, not a loosening of that
-- table's own policy. Filtered to active accounts only, the same
-- public_profiles convention (a deactivated/closed account's follow list
-- isn't meaningful to expose).
create view public.public_community_follows
with (security_invoker = false) as
select cf.user_id, cf.community_id, cf.created_at
from public.community_follows cf
join public.user_profiles up on up.id = cf.user_id
where up.is_active = true;

grant select on public.public_community_follows to authenticated;
-- Views don't inherit their underlying table's grants — community_follows'
-- own `grant ... to service_role` doesn't carry over automatically, and
-- lib/communities/profile.ts reads this view via the admin (service-role)
-- client (see that file's own comment for why), so it needs its own
-- explicit grant here too.
grant select on public.public_community_follows to service_role;
