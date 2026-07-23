-- Extracts the trigger's inline ancestor-walk into a standalone,
-- independently-testable function. get_branch_member_ids (descendant
-- walk, opposite direction) is untouched — it already single-purpose and
-- depth-capped. This is purely a refactor: same checks, same depth cap,
-- same exceptions, just callable on its own (e.g. by a future admin UI
-- wanting to pre-check "would this reassignment create a cycle" before
-- submitting a form).
create function public.would_create_hierarchy_cycle(p_subject_id uuid, p_parent_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_cursor uuid;
  v_depth integer := 0;
begin
  v_cursor := p_parent_id;
  while v_cursor is not null loop
    if v_cursor = p_subject_id then
      return true;
    end if;
    v_depth := v_depth + 1;
    if v_depth > 50 then
      raise exception 'admin hierarchy exceeds maximum depth (50) while checking parent_admin_id % for %', p_parent_id, p_subject_id;
    end if;
    select parent_admin_id into v_cursor from public.user_profiles where id = v_cursor;
  end loop;
  return false;
end;
$$;

revoke all on function public.would_create_hierarchy_cycle(uuid, uuid) from public;
grant execute on function public.would_create_hierarchy_cycle(uuid, uuid) to authenticated, service_role;

create or replace function public.validate_admin_hierarchy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent_role public.user_role;
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

  if public.would_create_hierarchy_cycle(new.id, new.parent_admin_id) then
    raise exception 'assigning parent_admin_id % to % would create a cycle', new.parent_admin_id, new.id;
  end if;

  return new;
end;
$$;
