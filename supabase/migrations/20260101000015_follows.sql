-- Phase 4 (Instagram-style redesign): one-directional follow graph, plus
-- exposing username via public_profiles so /profile/[username] can route.

create table public.follows (
  id uuid primary key default gen_random_uuid(),
  follower_id uuid not null references public.user_profiles (id) on delete cascade,
  followee_id uuid not null references public.user_profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  check (follower_id <> followee_id)
);

-- Naturally idempotent (toggle follow/unfollow) — a unique index on the
-- natural key, not a stored idempotency-key column (that's reserved for
-- money-movement actions elsewhere in this codebase).
create unique index unique_follow on public.follows (follower_id, followee_id);
create index follows_follower_idx on public.follows (follower_id);
create index follows_followee_idx on public.follows (followee_id);

alter table public.follows enable row level security;

create policy "select_own_follow_edges"
on public.follows for select
to authenticated
using (follower_id = auth.uid() or followee_id = auth.uid());

-- No grant at all to authenticated, not even SELECT: the follow graph is
-- read only through get_follow_counts/is_following below, never by
-- querying the table directly (sidesteps "is the whole graph public").
-- Writes go through lib/actions/follows.ts via the service role, same as
-- every other "caller acts as themselves" table in this codebase.
grant select, insert, delete on public.follows to service_role;

create or replace function public.is_following(p_follower_id uuid, p_followee_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.follows
    where follower_id = p_follower_id and followee_id = p_followee_id
  );
$$;

revoke all on function public.is_following(uuid, uuid) from public;
grant execute on function public.is_following(uuid, uuid) to authenticated, service_role;

create or replace function public.get_follow_counts(p_user_id uuid)
returns table (follower_count integer, following_count integer)
language sql
security definer
set search_path = public
stable
as $$
  select
    (select count(*) from public.follows where followee_id = p_user_id)::integer,
    (select count(*) from public.follows where follower_id = p_user_id)::integer;
$$;

revoke all on function public.get_follow_counts(uuid) from public;
grant execute on function public.get_follow_counts(uuid) to authenticated, service_role;

-- username was already unique on user_profiles but never exposed here —
-- needed to route /profile/[username]. CREATE OR REPLACE VIEW keeps the
-- view's OID (and therefore its existing grant to authenticated) intact,
-- but only allows appending columns at the end, not reordering — username
-- goes after avatar_url, not next to display_name.
create or replace view public.public_profiles
with (security_invoker = false) as
select id, display_name, avatar_url, username
from public.user_profiles
where is_active = true;
