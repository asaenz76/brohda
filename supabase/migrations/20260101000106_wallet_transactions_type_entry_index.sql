-- wallet_transactions (20260101000007) only indexes (user_id, created_at) —
-- the 8+ analytics RPCs added since (get_user_category_performance,
-- get_user_monthly_activity, get_user_cumulative_pnl, etc.) consistently
-- filter/join on `entry_id = ... and type = '...'` (e.g.
-- 20260101000067/20260101000071's refund/payout lateral joins), with none
-- of those columns indexed. Query plans degrade as the ledger grows.
create index if not exists wallet_transactions_type_entry_idx
  on public.wallet_transactions (type, entry_id);
