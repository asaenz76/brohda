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
-- to preserve, and no per-user balance reconciliation is required — this
-- is a full reset of disposable pre-pivot test data, not a partial-delete
-- requiring replay.
--
-- What this migration does NOT touch: the wallet_balances and
-- wallet_transactions TABLES themselves, wallet_reservations, the
-- apply_wallet_transaction RPC, or any P2P/monetary infrastructure — all
-- of that is shared infrastructure Brohda 2.0 needs going forward. Only
-- the disposable test DATA is removed, and only the two FK columns whose
-- sole purpose (unlocking a Pool entry from a wallet top-up) has no
-- Brohda 2.0 role are dropped.

-- 1. Purge all wallet transaction history (639 rows, 100% pre-pivot test
--    data — pool_entry_debit, pool_refund_credit, pool_payout_credit,
--    house_fee_credit, rounding_remainder_credit, manual_deposit,
--    manual_withdrawal).
delete from public.wallet_transactions;

-- 2. Reset every wallet balance to zero — the house account's entire
--    balance was itself 100% derived from the Pool house-fee/rounding
--    credits just deleted above; every user balance was built from the
--    same disposable pre-pivot activity.
update public.wallet_balances set balance = 0;

-- 3. Purge wallet_requests history (2 rows, both pre-pivot, both already
--    "approved" with no pending state, both already carrying a null
--    intended_pool_id/intended_option_id — this was never a live
--    quick-top-up-into-a-pool request).
delete from public.wallet_requests;

-- 4. The "quick top-up unlocks a specific Pool entry" columns have no
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
