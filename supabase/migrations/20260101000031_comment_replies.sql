-- One level of nesting for pool comments: a top-level comment can have
-- replies, but a reply can't itself be replied to (enforced in
-- add_pool_comment below, not just by convention).

alter table public.pool_comments
  add column parent_comment_id uuid references public.pool_comments (id) on delete cascade;

create index pool_comments_parent_idx on public.pool_comments (parent_comment_id);

-- Replacing the 3-arg signature with a 4-arg one (new optional param) is a
-- distinct overload as far as Postgres is concerned — drop the old one
-- first so there's no ambiguity over which one a 3-arg RPC call resolves
-- to.
drop function if exists public.add_pool_comment(uuid, uuid, text);

create or replace function public.add_pool_comment(
  p_pool_id uuid,
  p_user_id uuid,
  p_body text,
  p_parent_comment_id uuid default null
)
returns public.pool_comments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.pool_comments;
  v_parent public.pool_comments;
begin
  if p_parent_comment_id is not null then
    select * into v_parent from public.pool_comments where id = p_parent_comment_id;
    if not found or v_parent.pool_id != p_pool_id then
      raise exception 'parent_not_found';
    end if;
    if v_parent.parent_comment_id is not null then
      raise exception 'nesting_too_deep';
    end if;
  end if;

  insert into public.pool_comments (pool_id, user_id, body, parent_comment_id)
  values (p_pool_id, p_user_id, p_body, p_parent_comment_id)
  returning * into v_result;

  update public.pools set comment_count = comment_count + 1 where id = p_pool_id;

  return v_result;
end;
$$;

revoke all on function public.add_pool_comment(uuid, uuid, text, uuid) from public;
grant execute on function public.add_pool_comment(uuid, uuid, text, uuid) to service_role;

-- Deleting a top-level comment cascades (via the FK above) to its replies —
-- comment_count has to drop by the whole thread's size, not just one row,
-- or it'll drift out of sync with the actual remaining row count.
create or replace function public.delete_pool_comment(p_comment_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_comment public.pool_comments;
  v_deleted_count integer;
begin
  select * into v_comment from public.pool_comments where id = p_comment_id;
  if not found then
    return;
  end if;

  if v_comment.user_id != p_user_id and not public.is_admin_or_above(p_user_id) then
    raise exception 'not_authorized';
  end if;

  select count(*) into v_deleted_count
  from public.pool_comments
  where id = p_comment_id or parent_comment_id = p_comment_id;

  delete from public.pool_comments where id = p_comment_id;
  update public.pools set comment_count = greatest(comment_count - v_deleted_count, 0) where id = v_comment.pool_id;
end;
$$;

revoke all on function public.delete_pool_comment(uuid, uuid) from public;
grant execute on function public.delete_pool_comment(uuid, uuid) to service_role;
