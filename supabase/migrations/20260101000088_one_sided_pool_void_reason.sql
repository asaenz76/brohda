-- New value only in this file (see 20260101000086's comment for why).
--
-- A binary pool where every valid entry landed on the same side (all YES
-- or all NO) is economically identical to below-minimum-entries — there's
-- no genuine two-sided market, so it's cancelled with a full refund and no
-- fee, exactly like MINIMUM_ENTRIES_NOT_REACHED (see confirm_pool_refund's
-- v_new_status case expression). Checked at LOCK time now
-- (advance_or_cancel_locked_pool), not left until settlement.
alter type public.pool_void_reason add value 'ONE_SIDED_POOL';
