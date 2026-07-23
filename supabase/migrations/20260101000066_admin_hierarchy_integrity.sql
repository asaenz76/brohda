-- Hierarchy integrity — the original 20260101000063 migration added
-- parent_admin_id as a bare FK with no validation at all. This closes
-- that gap: no self-parent, no player-as-parent, no super_admin-with-a-
-- parent, and no cycles, enforced at write time (not just hoped for).

-- Defensive correction first, in case any existing row already violates
-- what we're about to enforce (expected to be a no-op today — invited_by,
-- the sole source of the original backfill, is only ever set by
-- requireAdminOrAbove()-gated code — but that's an application invariant,
-- not a database guarantee, so we check rather than assume).
update public.user_profiles
set parent_admin_id = null
where role = 'super_admin' and parent_admin_id is not null;

update public.user_profiles up
set parent_admin_id = null
where up.parent_admin_id is not null
  and not exists (
    select 1 from public.user_profiles parent
    where parent.id = up.parent_admin_id
      and parent.role in ('admin', 'super_admin')
  );

alter table public.user_profiles
  add constraint user_profiles_parent_not_self check (parent_admin_id is distinct from id);

-- Validates every future insert/update of parent_admin_id (or a role
-- change that could retroactively make an existing parent assignment
-- invalid, e.g. promoting a row with children to... no, demoting one
-- *to* player while it's still someone's parent — covered by re-checking
-- on role changes too): parent must be admin-or-above, never
-- super_admin-with-a-parent, and never a cycle. Depth-capped at 50 so a
-- runaway chain fails fast with a clear error instead of a stack-depth
-- crash.
create or replace function public.validate_admin_hierarchy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent_role public.user_role;
  v_cursor uuid;
  v_depth integer := 0;
begin
  if new.parent_admin_id is null then
    return new;
  end if;

  if new.role = 'super_admin' then
    raise exception 'super_admin rows may not have a parent_admin_id (user %)', new.id;
  end if;

  select role into v_parent_role from public.user_profiles where id = new.parent_admin_id;
  if v_parent_role is null then
    raise exception 'parent_admin_id % does not reference an existing user', new.parent_admin_id;
  end if;
  if v_parent_role = 'player' then
    raise exception 'parent_admin_id must reference an admin or super_admin, not a player (%)', new.parent_admin_id;
  end if;

  -- Walk up the proposed parent's own chain; if we ever reach this row's
  -- own id, assigning this parent would close a cycle.
  v_cursor := new.parent_admin_id;
  while v_cursor is not null loop
    if v_cursor = new.id then
      raise exception 'assigning parent_admin_id % to % would create a cycle', new.parent_admin_id, new.id;
    end if;
    v_depth := v_depth + 1;
    if v_depth > 50 then
      raise exception 'admin hierarchy exceeds maximum depth (50) while validating parent_admin_id % for %', new.parent_admin_id, new.id;
    end if;
    select parent_admin_id into v_cursor from public.user_profiles where id = v_cursor;
  end loop;

  return new;
end;
$$;

drop trigger if exists user_profiles_validate_hierarchy on public.user_profiles;
create trigger user_profiles_validate_hierarchy
  before insert or update of parent_admin_id, role on public.user_profiles
  for each row execute function public.validate_admin_hierarchy();

-- Depth-capped defense-in-depth for get_branch_member_ids itself — the
-- trigger above should make a real cycle impossible going forward, but a
-- capped recursive CTE degrades to "wrong/incomplete answer" instead of
-- "crash the connection" if that guarantee is ever violated some other
-- way (e.g. a direct service-role write that bypasses the trigger).
create or replace function public.get_branch_member_ids(p_root_admin_id uuid)
returns setof uuid
language sql
security definer
set search_path = public
stable
as $$
  with recursive branch as (
    select id, 0 as depth from public.user_profiles where id = p_root_admin_id
    union all
    select up.id, b.depth + 1
    from public.user_profiles up
    join branch b on up.parent_admin_id = b.id
    where b.depth < 50
  )
  select id from branch;
$$;
