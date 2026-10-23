-- Security hardening (S1 + S2, stage 1). Additive and backward compatible with the application that is running today.
--
-- S1 — unnecessary base-table WRITE privileges for the client roles.
--   FINDING (re-verified against production on 2026-10-23, read-only catalog queries): 35 relations in `public` still grant INSERT, UPDATE and DELETE to BOTH `anon` and
--   `authenticated` (migration 136 closed TRUNCATE/REFERENCES/TRIGGER/MAINTAIN but left these). Row Level Security makes them inert today — there are exactly three non-SELECT policies
--   for these roles (invitations: admins, ALL; user_profiles: own row and admin, UPDATE) — but RLS should be the SECOND boundary, not the only one, and the schema default would hand the
--   same write privileges to every table created in future.
--   LEGITIMATE client-session writes (verified in the code: the only writes made through a user-scoped Supabase client are lib/actions/invitations.ts -> `invitations` insert/update, and
--   lib/actions/profile.ts -> `user_profiles` update of nine profile columns). Everything else is written by service_role or by SECURITY DEFINER functions.
--   So: revoke INSERT/UPDATE/DELETE (and the already-revoked TRUNCATE/REFERENCES/TRIGGER, belt and braces) from anon and authenticated on every relation, EXCEPT
--     * invitations: authenticated keeps SELECT, INSERT, UPDATE (the admin policy applies; DELETE was never used and is revoked); anon keeps nothing but what it has for SELECT;
--     * user_profiles: authenticated keeps its COLUMN-level UPDATE grants on the nine profile columns (untouched); table-level INSERT/DELETE are revoked.
--   RLS is not touched. service_role is not touched.
--   FUTURE tables: the default privileges of role postgres (the owner of every Brohda table) no longer hand INSERT/UPDATE/DELETE to anon/authenticated, so a table needs an explicit GRANT to
--   be writable by a client role. SELECT is still granted by default (RLS is the gate for reads) — a deliberate, documented remainder.
--
-- S2 — `platform_settings` is readable by anyone (policy "anyone can read platform settings", TO anon, authenticated, USING true), exposing every operational column.
--   FINDING: the only client-session (RLS) reader in the whole application is lib/settings/registration.ts, which needs ONE column, registration_enabled. Every other reader uses the
--   service-role client, and every SECURITY INVOKER function that reads the table is a trigger run by service_role. STAGE 1 (this migration) adds the narrow public surface and leaves
--   the base-table read in place, so the application that is running today keeps working; STAGE 2 (migration 213) removes the direct read once the new application is deployed.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- S1: existing relations
-- ---------------------------------------------------------------------------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass as rel, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    if r.relname = 'user_profiles' then
      -- keep the column-level UPDATE grants authenticated holds for the nine profile columns; revoke only what was never needed
      execute format('revoke insert, delete, truncate, references, trigger on %s from anon, authenticated', r.rel);
      execute format('revoke update on %s from anon', r.rel);
    elsif r.relname = 'invitations' then
      execute format('revoke insert, update, delete, truncate, references, trigger on %s from anon', r.rel);
      execute format('revoke delete, truncate, references, trigger on %s from authenticated', r.rel);
    else
      execute format('revoke insert, update, delete, truncate, references, trigger on %s from anon, authenticated', r.rel);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- S1: future relations (same mechanism as migration 136: the schema-level default of role postgres, which owns every Brohda table)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;

-- Tables created by supabase_admin (dashboard / extensions) are not Brohda's, but close the same default where the platform allows it; never fail the migration over it.
do $$
begin
  execute 'alter default privileges for role supabase_admin in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated';
exception when others then
  raise notice 'could not adjust supabase_admin default privileges (%): left as is', sqlerrm;
end
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- S2 stage 1: the narrow public surface
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- A view owned by postgres reads the base table with the owner's rights, so it keeps working after the clients lose direct access (stage 2). It exposes ONLY what a visitor must know before
-- signing in: whether self-service registration is open. Add a column here only when a public/client page genuinely needs it.
create view public.public_platform_settings as
  select registration_enabled from public.platform_settings where id = true;
comment on view public.public_platform_settings is
  'The only part of platform_settings a visitor or Member session may read: whether self-service registration is open. Everything else is operational configuration, read by the server with the service role.';
revoke all on public.public_platform_settings from public, anon, authenticated;
grant select on public.public_platform_settings to anon, authenticated;
