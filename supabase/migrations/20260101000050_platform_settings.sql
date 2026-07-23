-- Singleton settings table for a small number of platform-wide toggles an
-- admin can flip without a deploy. First (and only) flag: whether the
-- self-service /register page actually creates accounts, or just shows a
-- "closed" message — kept off by default until a super admin turns it on.
create table public.platform_settings (
  -- A boolean primary key can only ever hold true or false, and the check
  -- below rules out false — so this table can never hold more than the one
  -- row it's seeded with below. Cheaper than a fixed-uuid singleton-row
  -- convention for a table that will only ever have exactly one row.
  id boolean primary key default true,
  registration_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.user_profiles (id),
  constraint platform_settings_singleton check (id)
);

alter table public.platform_settings enable row level security;

grant select on public.platform_settings to anon, authenticated;
grant select, update on public.platform_settings to service_role;

-- Readable by anyone, including signed-out visitors — the login page and
-- the (pre-auth) /register page both need to know whether registration is
-- open before any session exists. There is no client-facing write policy:
-- the only mutation path is setRegistrationEnabledAction, which uses the
-- service-role admin client (bypasses RLS entirely).
create policy "anyone can read platform settings"
  on public.platform_settings for select
  to anon, authenticated
  using (true);

insert into public.platform_settings (id, registration_enabled) values (true, false);
