-- Phase 1: roles and profiles (spec §6, §18, §19)

create type public.user_role as enum ('super_admin', 'player');

create table public.user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  username text unique,
  avatar_url text,
  role public.user_role not null default 'player',
  is_active boolean not null default true,
  invited_by uuid references public.user_profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index user_profiles_role_idx on public.user_profiles (role);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger user_profiles_set_updated_at
before update on public.user_profiles
for each row execute function public.set_updated_at();

-- SECURITY DEFINER helper so RLS policies can check role without recursing back
-- into user_profiles' own RLS (fixed search_path per spec §19).
create or replace function public.is_super_admin(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.user_profiles
    where id = uid and role = 'super_admin' and is_active = true
  );
$$;

revoke all on function public.is_super_admin(uuid) from public;
grant execute on function public.is_super_admin(uuid) to authenticated, service_role;

alter table public.user_profiles enable row level security;

create policy "select_own_profile"
on public.user_profiles for select
to authenticated
using (id = auth.uid());

create policy "select_all_profiles_as_admin"
on public.user_profiles for select
to authenticated
using (public.is_super_admin(auth.uid()));

create policy "update_own_profile"
on public.user_profiles for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create policy "admin_update_any_profile"
on public.user_profiles for update
to authenticated
using (public.is_super_admin(auth.uid()))
with check (public.is_super_admin(auth.uid()));

-- Base SELECT privilege — RLS policies above only filter rows; Postgres
-- still requires the underlying GRANT before the policies ever run.
grant select on public.user_profiles to authenticated;

-- Column-level privilege split: players may only ever change their own
-- display fields; role/is_active/invited_by changes require the service-role
-- (admin server actions), never a direct client mutation.
revoke update on public.user_profiles from authenticated;
grant update (display_name, username, avatar_url) on public.user_profiles to authenticated;

grant select, insert, update, delete on public.user_profiles to service_role;

-- Privacy-safe public view for social features (creator header, avatar stack,
-- X.5.2/X.8/X.9). Owned by the migration role (bypasses RLS) so it can expose
-- limited columns of *other* users' rows without granting broad table access.
create view public.public_profiles
with (security_invoker = false) as
select id, display_name, avatar_url
from public.user_profiles
where is_active = true;

grant select on public.public_profiles to authenticated;
