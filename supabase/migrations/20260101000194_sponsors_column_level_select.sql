-- Sponsors: a Sponsor's own login may read only the Sponsor-facing columns of its own organization row.
--
-- THE EXPOSURE. Migration 181 gave `authenticated` a TABLE-level SELECT on public.sponsors (with the row policy "sponsors_read": Super Admin, or a member of that Sponsor). Migration
-- 186 then added admin-only columns to the same table. A table-level grant covers every column, present and future, so a Sponsor's own signed-in Supabase client could read
-- `internal_review_note` (described in code as the Super Admin's private note — "never sent to the sponsor"), plus `reviewed_by` and `created_by` (staff identifiers) and
-- `reviewed_at`, straight from the data API. The application never showed them (it reads `sponsors` with the service-role client), so only the raw API did.
--
-- THE FIX. Replace the table-level grant with a column-level one:
--   readable by `authenticated` (the Sponsor's own row, via the unchanged row policy):
--     id, display_name, legal_name, contact_email, logo_path, status, status_reason,
--     website, country, contact_name, contact_phone, created_at, updated_at
--   NOT readable by `authenticated`:
--     internal_review_note   Super Admin's private note
--     reviewed_by            which staff member reviewed
--     reviewed_at            admin review metadata (nothing Sponsor-facing reads it; it only has meaning next to the two above)
--     created_by             which staff member created the organization, if any
-- `status_reason` stays readable on purpose: it is "the reason a Sponsor is allowed to see" (migration 186). `id` and `status` must stay readable because the RLS policy
-- sponsorship_inventory_read evaluates `exists (select 1 from sponsor_accounts sa join sponsors sp ... sp.status = 'ACTIVE')` as the querying user.
--
-- Why this is the safest shape: a column-level grant is an ALLOWLIST. A column added to `sponsors` later is unreadable by Sponsors until someone deliberately grants it, instead of
-- being exposed by default (which is how internal_review_note leaked). Nothing the application does changes: every application read of `sponsors` uses the service-role client,
-- which keeps `grant all`; Super Admin works through that same client. (A Super Admin's *own* user-scoped client is now limited to the same columns too — admin reads must stay
-- on the server, as they already do.) Side effect to know: `select *` / `sponsors(*)` through a user-scoped client now fails with "permission denied" instead of returning
-- every column; selecting the permitted columns by name works.
--
-- Forward-only and idempotent. No data, policy, function, trigger or other table is touched.

revoke all on public.sponsors from public, anon, authenticated;

grant select (
  id, display_name, legal_name, contact_email, logo_path, status, status_reason,
  website, country, contact_name, contact_phone, created_at, updated_at
) on public.sponsors to authenticated;

grant all on public.sponsors to service_role;

comment on column public.sponsors.internal_review_note is
  'Super Admin''s private note. NOT readable by the Sponsor''s own login (no column grant to authenticated); read and written only through the service role. See migration 194.';

-- Fail the migration (and roll it back) rather than leave a half-applied exposure.
do $$
declare
  c text;
begin
  foreach c in array array['internal_review_note', 'reviewed_by', 'reviewed_at', 'created_by'] loop
    if has_column_privilege('authenticated', 'public.sponsors', c, 'select') or has_column_privilege('anon', 'public.sponsors', c, 'select') then
      raise exception 'sponsors.% is still readable by a client role', c;
    end if;
  end loop;
  foreach c in array array['id', 'display_name', 'legal_name', 'contact_email', 'logo_path', 'status', 'status_reason', 'website', 'country', 'contact_name', 'contact_phone', 'created_at', 'updated_at'] loop
    if not has_column_privilege('authenticated', 'public.sponsors', c, 'select') then
      raise exception 'sponsors.% must stay readable by authenticated', c;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.sponsors', 'select') then
    raise exception 'authenticated must not hold table-level SELECT on sponsors';
  end if;
end $$;
