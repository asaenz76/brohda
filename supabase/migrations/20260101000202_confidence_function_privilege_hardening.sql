-- r83 — Confidence function EXECUTE hardening (forward-only; behaviour unchanged).
--
-- A database function should be callable only by the roles that actually need to call it. Migration 201 closed every Confidence mutation/aggregate function to anon and authenticated but left PostgreSQL's
-- default execute-for-everyone on the five trigger functions and the pure validation helper. None of that was exploitable (a trigger function cannot be called directly, the helper is a pure validator),
-- but it is exposure with no purpose, so it is closed here.
--
-- Trigger functions: PostgreSQL checks EXECUTE on a trigger function when the trigger is CREATED, never when it fires, so no application role needs a grant and every trigger keeps working.
revoke all on function public.confidence_accounts_guard() from public, anon, authenticated, service_role;
revoke all on function public.confidence_apply_ledger_entry() from public, anon, authenticated, service_role;
revoke all on function public.confidence_bootstrap_new_profile() from public, anon, authenticated, service_role;
revoke all on function public.confidence_ledger_immutable() from public, anon, authenticated, service_role;
revoke all on function public.confidence_stamp_ledger_entry() from public, anon, authenticated, service_role;

-- The pure stake-ladder validator is used only by the platform_settings CHECK constraint, which is evaluated as the role that writes the setting (the service role, or the owner inside
-- admin_set_confidence_config). No application role calls it directly, so only the service role keeps EXECUTE.
revoke all on function public.confidence_stakes_valid(integer[]) from public, anon, authenticated;
grant execute on function public.confidence_stakes_valid(integer[]) to service_role;
