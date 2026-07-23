-- correct_prediction_log was created service-role-only (20260101000018:
-- "No grants to authenticated at all") but never had RLS itself enabled,
-- unlike every other service-role-only table in this codebase (e.g.
-- pool_options, 20260101000009). No policies needed here, matching that
-- precedent exactly: service_role bypasses RLS regardless, and anon/
-- authenticated have no select/insert/update/delete grant on this table at
-- all (confirmed: they only carry the default references/trigger/truncate
-- privileges Postgres grants to PUBLIC on every table), so this is a
-- defense-in-depth backstop, not a behavior change for any real caller.
alter table public.correct_prediction_log enable row level security;
