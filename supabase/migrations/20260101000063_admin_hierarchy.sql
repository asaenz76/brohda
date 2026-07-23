-- Analytics Phase 0: admin/agent hierarchy, built as schema-only
-- infrastructure ahead of the admin-tier analytics work (Phase 3). Nothing
-- reads parent_admin_id yet — no existing page/query/RLS policy changes
-- behavior because of this migration.
--
-- Hierarchy is orthogonal to role, not a new role value: "admin" and
-- "agent" are always talked about as one tier at different tree depths,
-- never as different permission levels, so user_role stays the existing
-- 3-value enum (super_admin/admin/player). Instead every user_profiles row
-- gets a self-referential parent_admin_id: for a player, "which admin/
-- agent's branch do they belong to"; for an admin, their upline (the admin
-- who owns their sub-branch) — this makes the tree arbitrarily deep.
alter table public.user_profiles
  add column parent_admin_id uuid references public.user_profiles (id);

create index user_profiles_parent_admin_idx on public.user_profiles (parent_admin_id);

-- Bootstrap: seed parent_admin_id from the existing invited_by column,
-- since that's the one relationship this app already tracks today (an
-- admin inviting a user). This is a best-effort starting point, not a
-- guarantee every user ends up correctly branched — a super_admin
-- reassignment tool (added when Phase 3 ships the admin UI) is how branch
-- membership gets corrected/maintained going forward.
update public.user_profiles set parent_admin_id = invited_by where invited_by is not null;

-- The single hierarchy resolver: every future admin-tier query (analytics
-- or otherwise) must call this rather than re-deriving the tree, per the
-- "use the same authorization resolver everywhere" requirement. Returns
-- every id reachable by walking parent_admin_id down from the root
-- (descendant admins and players), including the root itself. security
-- definer + stable, mirroring is_admin_or_above's shape; recursion depth
-- is bounded by the depth of the actual admin tree, which is expected to
-- stay small.
create or replace function public.get_branch_member_ids(p_root_admin_id uuid)
returns setof uuid
language sql
security definer
set search_path = public
stable
as $$
  with recursive branch as (
    select id from public.user_profiles where id = p_root_admin_id
    union all
    select up.id
    from public.user_profiles up
    join branch b on up.parent_admin_id = b.id
  )
  select id from branch;
$$;

revoke all on function public.get_branch_member_ids(uuid) from public;
grant execute on function public.get_branch_member_ids(uuid) to authenticated, service_role;
