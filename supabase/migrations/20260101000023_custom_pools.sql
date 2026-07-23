-- Custom (from-scratch) pools: a super_admin writes a free-text question
-- and N free-text options with no linked fixture at all. The enum value
-- must commit in its own transaction before anything can reference it —
-- the Supabase CLI's migration runner wraps each file in one transaction,
-- so this stays split from 20260101000024_custom_pools_grading.sql (same
-- constraint hit and solved for the 'admin' role earlier).
alter type public.pool_type add value 'CUSTOM';
