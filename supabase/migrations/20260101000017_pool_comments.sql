-- Phase 6 (Instagram-style redesign): flat comment list per pool, v1 scope
-- (count + list in a bottom sheet, no nested replies/threads).

create table public.pool_comments (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools (id) on delete cascade,
  user_id uuid not null references public.user_profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);

create index pool_comments_pool_idx on public.pool_comments (pool_id, created_at);

-- Denormalized counter mirroring pool_likes.like_count's precedent.
alter table public.pools add column comment_count integer not null default 0;

alter table public.pool_comments enable row level security;

-- Comments inherit their pool's own access gate — status != 'DRAFT', the
-- same thing pools' own "members_can_read_published_pools" policy checks —
-- NOT pool.visibility. HIDDEN is purely a Feed-listing filter, never an
-- RLS distinction: a HIDDEN pool's detail page is still directly readable
-- by any member (Decision 7, see app/(app)/pool/[id]/page.tsx). Gating
-- comments on visibility would make them less accessible than the pool
-- itself, which is an inconsistency, not a privacy win.
create policy "read_comments_on_readable_pools"
on public.pool_comments for select
to authenticated
using (
  exists (
    select 1 from public.pools p
    where p.id = pool_comments.pool_id
      and (p.status != 'DRAFT' or public.is_super_admin(auth.uid()))
  )
);

-- No INSERT/DELETE grant to authenticated — every write goes through the
-- functions below via the service role (lib/actions/comments.ts), same as
-- every other "caller acts as themselves" table in this codebase.
grant select on public.pool_comments to authenticated;
grant select, insert, delete on public.pool_comments to service_role;

create or replace function public.add_pool_comment(p_pool_id uuid, p_user_id uuid, p_body text)
returns public.pool_comments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.pool_comments;
begin
  insert into public.pool_comments (pool_id, user_id, body)
  values (p_pool_id, p_user_id, p_body)
  returning * into v_result;

  update public.pools set comment_count = comment_count + 1 where id = p_pool_id;

  return v_result;
end;
$$;

revoke all on function public.add_pool_comment(uuid, uuid, text) from public;
grant execute on function public.add_pool_comment(uuid, uuid, text) to service_role;

-- Caller must own the comment or be a super admin — checked here rather
-- than left to the RLS layer, since there's no DELETE grant to
-- authenticated at all for this table.
create or replace function public.delete_pool_comment(p_comment_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_comment public.pool_comments;
begin
  select * into v_comment from public.pool_comments where id = p_comment_id;
  if not found then
    return;
  end if;

  if v_comment.user_id != p_user_id and not public.is_super_admin(p_user_id) then
    raise exception 'not_authorized';
  end if;

  delete from public.pool_comments where id = p_comment_id;
  update public.pools set comment_count = greatest(comment_count - 1, 0) where id = v_comment.pool_id;
end;
$$;

revoke all on function public.delete_pool_comment(uuid, uuid) from public;
grant execute on function public.delete_pool_comment(uuid, uuid) to service_role;
