-- Phase 5 (Instagram-style redesign): single heart/like per pool per user.

create table public.pool_likes (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools (id) on delete cascade,
  user_id uuid not null references public.user_profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Naturally idempotent (toggle like/unlike) — a unique index on the
-- natural key, not a stored idempotency-key column.
create unique index unique_pool_like on public.pool_likes (pool_id, user_id);
create index pool_likes_user_idx on public.pool_likes (user_id);

-- Denormalized counter mirroring pool_options.entry_count's precedent —
-- avoids a count(*) over pool_likes on every card render. Maintained only
-- by toggle_pool_like() below, never touched directly by a client.
alter table public.pools add column like_count integer not null default 0;

alter table public.pool_likes enable row level security;

-- No public "who liked this" list is part of the spec (only the count +
-- "did I like this" boolean are) — own-rows-only is enough, no broad grant
-- needed. pools.like_count is already publicly readable via pools' own
-- existing SELECT policy/grant.
create policy "select_own_pool_likes"
on public.pool_likes for select
to authenticated
using (user_id = auth.uid());

grant select on public.pool_likes to authenticated;
grant select, insert, delete on public.pool_likes to service_role;

-- Transactional insert-or-delete + counter update in one round trip,
-- returning the new liked state so the caller doesn't need a follow-up
-- read. service_role-only — even the toggle itself goes through
-- lib/actions/likes.ts via the service role, not a direct RLS write.
create or replace function public.toggle_pool_like(p_pool_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted boolean;
begin
  delete from public.pool_likes
  where pool_id = p_pool_id and user_id = p_user_id
  returning true into v_deleted;

  if v_deleted then
    update public.pools set like_count = like_count - 1 where id = p_pool_id;
    return false;
  end if;

  insert into public.pool_likes (pool_id, user_id) values (p_pool_id, p_user_id);
  update public.pools set like_count = like_count + 1 where id = p_pool_id;
  return true;
end;
$$;

revoke all on function public.toggle_pool_like(uuid, uuid) from public;
grant execute on function public.toggle_pool_like(uuid, uuid) to service_role;
