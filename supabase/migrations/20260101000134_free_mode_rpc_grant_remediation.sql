-- FREE prediction mode — grant remediation (production release verification).
--
-- confirm_pool_grading_only and void_pool_no_refund are the only two
-- genuinely new functions this feature introduced (every other touched
-- function — create_pool_entry, advance_or_cancel_locked_pool, the four
-- analytics functions — was a same-signature `create or replace` on an
-- already-existing function, which Postgres leaves at its prior ACL).
-- Production verification after 20260101000129 applied found EXECUTE
-- granted to anon and authenticated on both brand-new functions, despite
-- each migration's own `revoke all ... from public; grant execute ... to
-- service_role;` statements.
--
-- Root cause, confirmed by comparing against the functions that were
-- NOT affected: this project has a default-privileges mechanism that
-- grants EXECUTE to anon/authenticated directly (not via the PUBLIC
-- pseudo-role) at the moment a function is first created — the same
-- class of mechanism SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md already
-- documented for this project ("Root Cause 2: a separate, production-only
-- widening... most plausibly a GRANT EXECUTE ON ALL FUNCTIONS ... TO anon,
-- authenticated statement", and "Root Cause 1" for the signature-change
-- case). `REVOKE ALL ... FROM PUBLIC` only revokes the PUBLIC pseudo-
-- role's own grant — it does nothing to a grant already made directly to
-- a named role, which is exactly what a first-time CREATE FUNCTION under
-- this mechanism produces. Revoking from anon/authenticated by name,
-- explicitly, closes that gap.
--
-- Neither function ever calls apply_wallet_transaction — no financial
-- transaction could have moved through this misconfiguration regardless —
-- but confirm_pool_grading_only could have let any API caller grade an
-- arbitrary FREE pool's arbitrary option as the winner (p_admin_id is
-- nullable, by design, for the legitimate system-triggered path — a null
-- value skips the is_super_admin check entirely), and void_pool_no_refund
-- could similarly void/cancel an arbitrary FREE pool. A pool_grading_
-- evidence row is written by the caller before this RPC runs, not by this
-- RPC itself, so no forged evidence trail could result — only entries.
-- status/user_profiles streak corruption and pools.status changes on FREE
-- pools. No production FREE pool existed at any point this gap was open
-- (confirmed: this migration is applied within minutes of
-- 20260101000129, before any FREE pool had been created in production).
--
-- enforce_pool_capability (the new trigger function from
-- 20260101000131) shows the identical broad grant for the same root
-- cause, but is not independently exploitable via the API — it RETURNS
-- trigger, and PostgREST categorically excludes trigger-return functions
-- from RPC exposure, matching this project's own existing precedent for
-- every other trigger function (enforce_pool_fee_immutability, etc.),
-- documented in the same incident report. Revoked here anyway, for
-- defense-in-depth and to leave nothing inconsistent with the other
-- money-adjacent functions' grants.

revoke all on function public.confirm_pool_grading_only(uuid, uuid, integer, text, uuid) from anon, authenticated, public;
grant execute on function public.confirm_pool_grading_only(uuid, uuid, integer, text, uuid) to service_role;

revoke all on function public.void_pool_no_refund(uuid, public.pool_void_reason, text, uuid, integer) from anon, authenticated, public;
grant execute on function public.void_pool_no_refund(uuid, public.pool_void_reason, text, uuid, integer) to service_role;

revoke all on function public.enforce_pool_capability() from anon, authenticated, public;
