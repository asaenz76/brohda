-- Security hardening S2, stage 2 — APPLY ONLY AFTER the application that reads `public.public_platform_settings` (stage 1, migration 212 plus the app that uses it) is deployed.
--
-- `platform_settings` was readable by `anon` and `authenticated` (policy "anyone can read platform settings", USING true), exposing every operational column to anyone with the public anon
-- key. The only client-session reader in the application is lib/settings/registration.ts, which now reads the one-column view. Every other reader uses the service role, every SECURITY
-- INVOKER function that reads the table is a trigger executed by service_role, and no RLS policy or view references the table (all verified before writing this).
--
-- ORDER MATTERS: running this while the previous application is still live breaks /register, the login page's "Create an account" link and the admin settings page (they read the base
-- table as the signed-in/anonymous role). That is why this is a separate migration from stage 1.

revoke select on public.platform_settings from anon, authenticated;
drop policy if exists "anyone can read platform settings" on public.platform_settings;
comment on table public.platform_settings is
  'Operational configuration (singleton). Not readable by client roles: the server reads it with the service role; the only part a visitor or Member session may read is public.public_platform_settings.';
