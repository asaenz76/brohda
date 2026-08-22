-- Same "retype it every time" friction as 20260101000084, but for the
-- tiered-pool creation flow: five default entry-fee amounts, pre-filled
-- into TierFeeInputs when an admin picks "Tiered" in the pool wizard so
-- they aren't retyping "5.00"/"10.00"/"25.00"/"50.00"/"100.00" on every
-- tier group. Plain fixed-length array column, no separate table — same
-- reasoning as default_entry_fee_cents/default_house_fee_bps: one
-- singleton settings row, no per-column grants needed beyond the
-- table-level ones platform_settings already has.
alter table public.platform_settings
  add column default_tier_entry_fees_cents bigint[] not null default array[500, 1000, 2500, 5000, 10000];
