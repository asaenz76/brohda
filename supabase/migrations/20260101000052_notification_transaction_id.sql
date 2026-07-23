-- resolveNotificationHref (lib/notifications/links.ts) currently correlates
-- a money notification to its ledger row purely via pool_id. But
-- delete_terminal_pool deliberately nulls notifications.pool_id when a
-- pool is hard-deleted (so the FK doesn't block the delete) — even a
-- SETTLED pool with real payout history is deletable, so this silently and
-- permanently orphans that notification's clickability, even though the
-- wallet_transaction itself is never deleted (wallet_transactions_no_delete
-- trigger, 20260101000007_wallet.sql). A real FK here is safe specifically
-- because wallet_transactions rows are truly immutable/undeletable.
alter table public.notifications
  add column transaction_id uuid references public.wallet_transactions (id);
