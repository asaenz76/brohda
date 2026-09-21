-- Milestone 5.5 admin operations authorization — capability-driven from the
-- start, exactly like Milestone 5's own view_simulated_execution_diagnostics
-- (migrations 20260101000150/151). Three capabilities, matching the task's
-- own minimum-necessary instruction (STEP 31: "do not create more
-- capabilities than necessary"):
--   - view_execution_operations   (read the operations dashboard)
--   - manage_execution_controls   (create/disable kill switches, provider-health overrides)
--   - manage_execution_rollout    (create/update cohorts and membership)
--
-- Split into its own migration because Postgres does not allow a newly
-- added enum value to be used within the same transaction that added it
-- (see 20260101000158 for the seed insert).
alter type public.app_capability add value 'view_execution_operations';
alter type public.app_capability add value 'manage_execution_controls';
alter type public.app_capability add value 'manage_execution_rollout';
