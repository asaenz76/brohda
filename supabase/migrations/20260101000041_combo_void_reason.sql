-- New void reason for a COMBO pool where the graded-correct side (Yes or
-- No, determined by leg grading) has zero entries — "nobody picked the
-- winning outcome", same as NO_WINNING_ENTRIES, except the coordinator fee
-- is deliberately retained instead of refunded (see
-- 20260101000042_combo_pools.sql's confirm_combo_refund_fee_retained).
-- Must commit in its own transaction before use.
alter type public.pool_void_reason add value 'NO_WINNING_ENTRIES_FEE_RETAINED';
