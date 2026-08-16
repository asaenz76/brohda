-- Phase 4.1 stabilization: closes the same class of gap already found and
-- fixed three times before in this codebase (provider_request_log
-- 20260101000099, fixture_odds_cache 20260101000100, team_players
-- 20260101000119) — hosted Supabase projects grant broader default table
-- privileges than a migration ever explicitly declares, for whichever
-- role owns/creates the table. That's normally harmless *because* RLS is
-- the real enforcement layer (Supabase's documented model: broad base
-- GRANTs, RLS policies narrow what's actually visible/mutable per row).
-- These three cases were found via a live production query
-- (information_schema.table_privileges) during Phase 4.1's integration-
-- test investigation, each confirmed against the specific gap it closes:
--
-- 1. public.fixtures — `authenticated`/`anon` hold INSERT/UPDATE/DELETE/
--    TRUNCATE/REFERENCES/TRIGGER in production; the original migration
--    (20260101000008) only ever declared SELECT. RLS already has zero
--    UPDATE/DELETE policies on this table (confirmed live via pg_policy —
--    exactly one policy, command 'r'/SELECT), so no actual row mutation
--    was ever possible through this — Postgres's own documented
--    RLS-enabled-with-no-matching-policy behavior is "affects zero rows,"
--    not "throws." This revoke is defense-in-depth, not a fix for a live
--    exploit: relying on RLS alone here was already safe, but a narrower
--    base GRANT means a future RLS policy mistake (e.g. an accidentally
--    permissive one) has one fewer way to become exploitable.
-- 2. public.follows — `authenticated`/`anon` hold full CRUD in
--    production; the original migration (20260101000015) explicitly
--    documents "No grant at all to authenticated, not even SELECT" as
--    the intended design (all access meant to go through the follow/
--    unfollow RPCs). The leftover `select_own_follow_edges` policy
--    correctly scopes any SELECT to the caller's own edges, so the
--    practical exposure was narrow (a user could read their own follow
--    relationship directly instead of through the RPC) — but it's a real
--    deviation from documented intent, closed here.
-- 3. public.nfl_game_results — `service_role` holds DELETE in production;
--    the original migration (20260101000109) explicitly grants only
--    select/insert/update and documents the append-only design as
--    relying on that grant-level block, with the `forbid_nfl_game_results
--    _delete` trigger as defense-in-depth *behind* it. The trigger was
--    still firing correctly (confirmed via a live integration test), so
--    deletes were never actually possible — this restores the grant-level
--    block as the documented first line of defense, matching the exact
--    fix already applied to team_players (20260101000119) for the same
--    hosted-default-drift reason.
revoke insert, update, delete, truncate, references, trigger
  on public.fixtures
  from authenticated, anon;

revoke all
  on public.follows
  from authenticated, anon;

revoke delete
  on public.nfl_game_results
  from service_role;
