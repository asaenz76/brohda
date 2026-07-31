-- Removes the "retype the entry fee and platform fee on every single pool"
-- friction — the pool-creation form previously hardcoded "5.00"/"5" as
-- local component state with no saved default anywhere. platform_settings
-- already has no per-column grants (the whole table is select-able by
-- anyone, service_role-only for writes), so these new columns need no
-- additional grants — they're covered by the existing table-level ones.
alter table public.platform_settings
  add column default_entry_fee_cents bigint not null default 500,
  add column default_house_fee_bps integer not null default 500;
