-- Phase I (V1 backend + test-data decommission), step 1 of 3 — wallet
-- clean-slate reset.
--
-- Business fact (confirmed by the product owner, and independently verified
-- here against the actual data): every row in wallet_transactions and
-- wallet_requests predates the Brohda 2.0 pivot. wallet_transactions'
-- latest row is 2026-09-02; the first real Brohda 2.0 activity (posts,
-- communities, predictions) begins 2026-09-24 and continues to present.
-- Zero wallet mutation ever happened during or after the pivot, and P2P
-- (monetary_positions, monetary_proposals, challenges) has zero rows at
-- every point in this history. There is no current/post-pivot wallet state
-- to preserve, and no per-user balance reconciliation is required.
--
-- Correction from this migration's first (rejected) revision: it is not
-- possible to delete wallet_transactions rows at all, under any role —
-- wallet_transactions_no_delete (forbid_audit_log_mutation(), the same
-- append-only guard protecting audit_logs) rejects every DELETE
-- unconditionally. This was never exercised against a real `supabase db
-- reset` (an empty table fires zero per-row triggers), only surfaced on
-- the real `supabase db push --linked` attempt against production's
-- actual 639 rows. The 639 pre-pivot rows therefore stay in place
-- permanently, by design — this is a real, deliberate ledger-immutability
-- guarantee, not a gap to route around. lib/wallet/ledger.ts's live
-- /wallet history query now excludes the pre-pivot transaction types
-- instead, so no user sees these stale, now-unreconciled-against-their-
-- zeroed-balance entries — the rows remain queryable in the database,
-- just not surfaced in the product.
--
-- What this migration does NOT touch: the wallet_balances and
-- wallet_transactions TABLES themselves, wallet_reservations, the
-- apply_wallet_transaction RPC, or any P2P/monetary infrastructure — all
-- of that is shared infrastructure Brohda 2.0 needs going forward. Only
-- the disposable test DATA that can actually be removed is removed, and
-- only the two FK columns whose sole purpose (unlocking a Pool entry from
-- a wallet top-up) has no Brohda 2.0 role are dropped.

-- 1. Reset every wallet balance to zero — a flat reset of current state,
--    independent of whatever the (permanently immutable) ledger rows say;
--    every existing balance was built entirely from disposable pre-pivot
--    activity.
update public.wallet_balances set balance = 0;

-- 2. Purge wallet_requests history (2 rows, both pre-pivot, both already
--    "approved" with no pending state, both already carrying a null
--    intended_pool_id/intended_option_id — this was never a live
--    quick-top-up-into-a-pool request). Unlike wallet_transactions,
--    wallet_requests carries no append-only guard — confirmed directly
--    against the live schema.
delete from public.wallet_requests;

-- 3. The "quick top-up unlocks a specific Pool entry" columns have no
--    Brohda 2.0 role (verified: the only app code that ever read/wrote
--    them, lib/actions/wallet-requests.ts's completeQuickTopUpEntry, has
--    been removed — no current UI sets these fields, and the general
--    wallet-request submit/approve flow never touches them). This also
--    resolves the one hard FK blocker the pre-destructive audit found
--    (wallet_requests_intended_pool_id_fkey / _intended_option_id_fkey),
--    clearing the way for pools/pool_options to be dropped in step 3.
alter table public.wallet_requests
  drop column if exists intended_pool_id,
  drop column if exists intended_option_id;
