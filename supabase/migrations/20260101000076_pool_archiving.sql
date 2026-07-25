-- Lets super_admin archive settled/voided/cancelled pools out of the main
-- admin pools list without deleting their history (unlike delete_terminal_pool,
-- this is fully reversible). No grant needed: pools already has a blanket
-- `grant select on public.pools to authenticated` (20260101000009) and every
-- write to this column goes through the admin (service_role) client, same as
-- every other pool-lifecycle mutation in lib/actions/pool-lifecycle.ts.
alter table public.pools
  add column archived_at timestamptz;
