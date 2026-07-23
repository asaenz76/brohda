-- New void reason for a super_admin cancelling a pool outright (not tied to
-- a fixture anomaly or the below-minimum-entries auto-cancel path). Must
-- commit in its own migration/transaction before use (same enum-then-use
-- ordering constraint hit for admin_role and pool_type earlier this session).
alter type public.pool_void_reason add value 'ADMIN_MANUAL_CANCEL';
