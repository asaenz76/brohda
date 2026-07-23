-- New pool type: a "combo" bet — a fixed Yes/No pair whose winner is
-- derived from N independent conditions ("legs") the admin grades
-- individually after lock (see 20260101000042_combo_pools.sql for
-- everything that uses this value). Must commit in its own transaction
-- before anything can reference it — same enum-then-use ordering
-- constraint hit for CUSTOM/admin_role earlier.
alter type public.pool_type add value 'COMBO';
