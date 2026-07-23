-- Phase 7: security hardening (spec §19/§23's "security review, RLS
-- verification"). No schema/behavior changes — just closing a defense-in-
-- depth gap found during the Phase 7 audit.

-- create_wallet_for_new_profile() was the only SECURITY DEFINER function
-- without an explicit `revoke all from public` — it's trigger-only (fired
-- by user_profiles_create_wallet, never called directly), so this was low
-- risk, but every other definer function in the codebase does this and it
-- costs nothing to match.
revoke all on function public.create_wallet_for_new_profile() from public;
