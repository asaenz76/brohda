-- Milestone R13 remediation: `wallet_reservations.user_id` was created
-- with `ON DELETE CASCADE` (20260101000155), inconsistent with the
-- explicit precedent its own migration cites — `wallet_transactions.
-- user_id` is deliberately `ON DELETE NO ACTION` (the schema default)
-- specifically so "ledger history must survive even if a profile is ever
-- hard-deleted." A hard-deleted user_profiles row would have silently
-- cascade-deleted their wallet_reservations rows too, breaking the
-- reservation<->ledger correlation (`consumed_transaction_id` pointing at
-- a permanent, non-deletable wallet_transactions row) that same
-- migration's own comment describes as a design goal.
--
-- Currently dormant: no hard-delete code path exists anywhere in this
-- codebase — close_own_account() (20260101000022, extended
-- 20260101000105) only ever soft-scrubs (is_active = false, PII nulled);
-- the user_profiles row and its id persist forever. This migration closes
-- the gap for defense-in-depth before it can ever become reachable, at
-- zero cost to any current behavior — no application code deletes a
-- user_profiles row today, so switching to NO ACTION changes nothing
-- observable, it only removes a landmine for a future admin tool or
-- manual SQL operation.
alter table public.wallet_reservations
  drop constraint wallet_reservations_user_id_fkey;

alter table public.wallet_reservations
  add constraint wallet_reservations_user_id_fkey
    foreign key (user_id) references public.user_profiles(id);

comment on column public.wallet_reservations.user_id is
  'The reserving user. Plain (NO ACTION) FK, matching wallet_transactions.user_id''s own precedent — reservation/ledger correlation history must survive even if a profile were ever hard-deleted (no code path does this today; close_own_account() only ever soft-scrubs).';
