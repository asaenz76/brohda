-- FREE prediction mode — Phase 0 (schema foundation).
--
-- Purely additive: no existing row's meaning changes. `entry_mode` defaults
-- to 'PAID' and every existing pool backfills to 'PAID' by construction (not
-- inferred from entry_fee), so no ambiguity is introduced. Nothing new is
-- reachable from this migration alone — no RPC or trigger yet reads
-- `entry_mode`, `paid_pools_enabled`, or `free_pools_enabled` differently
-- than before. See FREE_MODE_ARCHITECTURE_PROPOSAL.md §4, §12 for the full
-- design and rationale; this migration implements that section's constraint
-- exactly, including the Decision 4 combined CHECK.

create type public.entry_mode as enum ('PAID', 'FREE');

alter table public.pools
  add column entry_mode public.entry_mode not null default 'PAID';

-- Decision 4 (locked): a FREE pool must be unable to retain ANY financial
-- configuration — not just entry_fee. This replaces the single-column check
-- that existed before FREE mode with one that also pins house_fee_bps and
-- tier_group_id for FREE pools, while leaving PAID's existing behavior
-- (entry_fee > 0, house_fee_bps 0-10000 range, tier_group_id whatever it
-- already was) completely unchanged.
alter table public.pools drop constraint pools_entry_fee_check;
alter table public.pools alter column entry_fee drop not null;
alter table public.pools add constraint pools_entry_mode_financial_check check (
  (entry_mode = 'PAID'
    and entry_fee is not null
    and entry_fee > 0)
  or
  (entry_mode = 'FREE'
    and entry_fee is null
    and house_fee_bps = 0
    and tier_group_id is null)
);
-- pools_house_fee_bps_check (0-10000 range) is untouched — 0 is already
-- legal under it for every pool; the constraint above adds the requirement
-- that it be *exactly* 0 specifically when entry_mode = 'FREE'.

-- entries.amount: nullable, never a $0 sentinel (§3, §4.2). NULL means "not
-- applicable" (a FREE entry never had a cost); 0 would wrongly claim a
-- zero-dollar transaction occurred. Decision 3's reject-vs-null-coerce rule
-- for a client-supplied FREE amount is enforced procedurally inside
-- create_pool_entry (a later migration), not here — a CHECK constraint
-- can't distinguish "caller supplied a value" from "server nulled it".
alter table public.entries drop constraint entries_amount_check;
alter table public.entries alter column amount drop not null;
alter table public.entries add constraint entries_amount_check check (amount is null or amount > 0);

-- Global platform control (§5.1): two independent booleans, not a two-state
-- enum, on the existing platform_settings singleton row — the same table
-- registration_enabled already lives on. Both default true so this
-- migration alone changes no observable behavior (nothing yet reads these
-- columns).
alter table public.platform_settings
  add column paid_pools_enabled boolean not null default true,
  add column free_pools_enabled boolean not null default true;

-- Sparse index: FREE pools will be a minority for the foreseeable future,
-- mirrors the existing tier_group_id partial-index idiom.
create index idx_pools_entry_mode on public.pools (entry_mode) where entry_mode = 'FREE';
