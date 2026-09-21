-- Milestone 5.5 grant corrections, found during test verification:
--
-- 1. execution_cohort_members: lib/execution/cohorts.ts's addCohortMember
--    uses an upsert (ON CONFLICT DO UPDATE) to make adding an
--    already-existing member idempotent — Postgres requires UPDATE
--    privilege for the ON CONFLICT DO UPDATE clause even when no conflict
--    actually occurs, so service_role needs it granted alongside
--    select/insert/delete.
-- 2. execution_provider_health: unlike kill switches (deliberately
--    soft-disabled, never deleted, to preserve incident history per STEP
--    29), a provider-health row is pure derived/observed state with no
--    history requirement — an operator resetting accumulated
--    failure-count history for a recovered provider is a legitimate
--    operation, so DELETE is granted alongside select/insert/update.
grant update on public.execution_cohort_members to service_role;
grant delete on public.execution_provider_health to service_role;
