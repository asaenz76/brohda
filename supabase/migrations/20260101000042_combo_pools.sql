-- COMBO pools (continuation of 20260101000040/41): a fixed Yes/No pair
-- whose winner is derived from N independent conditions ("legs") an admin
-- grades individually after lock — "Yes" wins only if every leg is met,
-- otherwise "No" wins. Also adds `pools.title` (a short context line
-- alongside `question`, e.g. "2026 World Cup Semifinal France – England"
-- vs. the question "Will Mbappé, Bellingham, Dembélé score at least 1 goal
-- each?") — usable by CUSTOM pools too, not just COMBO.

alter table public.pools
  add column title text check (char_length(title) <= 200);

-- Re-created (not just extended) since plpgsql functions are replaced
-- wholesale — same body as 20260101000009_pools.sql plus a title check.
create or replace function public.enforce_pool_fee_immutability()
returns trigger
language plpgsql
as $$
begin
  if old.first_entry_at is not null then
    if new.entry_fee <> old.entry_fee
      or new.house_fee_bps <> old.house_fee_bps
      or new.question <> old.question
      or new.pool_type <> old.pool_type
      or coalesce(new.title, '') <> coalesce(old.title, '')
    then
      raise exception 'pool fields are frozen after the first entry';
    end if;

    if new.locks_at > old.locks_at then
      raise exception 'lock time may only move earlier after the first entry';
    end if;
  end if;

  return new;
end;
$$;

-- One row per leg/condition. is_met stays null until the admin grades it;
-- "Yes" only wins once every leg for the pool is true. Immutable via the
-- app layer by omission (no edit UI, same as pool_options.label) — only
-- is_met is ever written after creation, by the grading action.
create table public.pool_combo_legs (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools (id),
  label text not null check (char_length(label) <= 150),
  sort_order integer not null default 0,
  is_met boolean,
  created_at timestamptz not null default now()
);

create index idx_pool_combo_legs_pool on public.pool_combo_legs (pool_id);

alter table public.pool_combo_legs enable row level security;

-- Legs are just descriptive terms of the bet (like pool_options.label) —
-- no distribution-style privacy concern, safe to read alongside the pool
-- itself. Mirrors settlements_visible_with_pool's exact shape.
create policy "combo_legs_visible_with_pool"
on public.pool_combo_legs for select
to authenticated
using (
  exists (
    select 1 from public.pools p
    where p.id = pool_combo_legs.pool_id
      and (p.status != 'DRAFT' or public.is_super_admin(auth.uid()))
  )
);

grant select on public.pool_combo_legs to authenticated;
grant select, insert, update, delete on public.pool_combo_legs to service_role;

-- New settlements.outcome value for the case below — everything else about
-- this constraint is unchanged.
alter table public.settlements drop constraint settlements_outcome_check;
alter table public.settlements add constraint settlements_outcome_check
  check (outcome in (
    'NORMAL', 'NO_WINNING_ENTRIES_REFUND', 'ALL_ENTRIES_WINNING_REFUND',
    'NO_WINNING_ENTRIES_FEE_RETAINED'
  ));

-- ---------------------------------------------------------------------
-- confirm_combo_refund_fee_retained: the one genuinely new settlement
-- path. Reached only when a COMBO pool's leg-graded winning option (Yes
-- or No) has zero entries — nobody picked the actually-correct side, so
-- there's no one to pay out, but unlike every other refund reason
-- (confirm_pool_refund: full amount, no fee — this pool never even
-- computes a house_fee_amount for those cases), the coordinator fee is
-- still earned here, as if the pool had settled normally. Computed
-- per-entry (not once on the pool-level gross) so
-- sum(net refund) + sum(fee collected) == gross_pool exactly, with no
-- separate rounding-remainder bucket needed.
-- ---------------------------------------------------------------------

create or replace function public.confirm_combo_refund_fee_retained(
  p_pool_id uuid,
  p_admin_id uuid,
  p_grading_version integer,
  p_idempotency_key text,
  p_winning_option_id uuid
)
returns public.pools
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
  v_settlement public.settlements;
  v_entry record;
  v_entry_fee bigint;
  v_entry_net bigint;
  v_total_fee bigint := 0;
  v_gross_pool bigint;
begin
  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  if v_pool.status in (
    'SETTLED', 'VOIDED', 'CANCELLED', 'SETTLEMENT_REVERSED', 'REVERSAL_FAILED_MANUAL_REVIEW'
  ) then
    return v_pool; -- already terminal — idempotent no-op, mirrors confirm_pool_refund
  end if;

  if v_pool.snapshot_version <> p_grading_version then
    raise exception 'stale_snapshot';
  end if;

  select * into v_settlement from public.settlements
    where pool_id = p_pool_id and grading_version = p_grading_version for update;
  if not found then
    raise exception 'settlement_not_found';
  end if;

  if v_settlement.confirmed_at is not null then
    return v_pool; -- already confirmed — idempotent no-op
  end if;

  select coalesce(sum(total_entry_amount), 0) into v_gross_pool
    from public.pool_options where pool_id = p_pool_id;

  for v_entry in
    select * from public.entries where pool_id = p_pool_id and status = 'ACTIVE' for update
  loop
    v_entry_fee := (v_entry.amount * v_pool.house_fee_bps) / 10000;
    v_entry_net := v_entry.amount - v_entry_fee;
    v_total_fee := v_total_fee + v_entry_fee;

    perform public.apply_wallet_transaction(
      'user'::public.wallet_account_type,
      v_entry.user_id,
      'pool_refund_credit'::public.wallet_transaction_type,
      'credit'::public.wallet_direction,
      v_entry_net,
      p_admin_id,
      'NO_WINNING_ENTRIES_FEE_RETAINED',
      p_idempotency_key || ':refund:' || v_entry.id,
      p_pool_id, v_entry.id, v_settlement.id
    );

    update public.entries set status = 'REFUNDED' where id = v_entry.id;
  end loop;

  if v_total_fee > 0 then
    perform public.apply_wallet_transaction(
      'house'::public.wallet_account_type,
      null,
      'house_fee_credit'::public.wallet_transaction_type,
      'credit'::public.wallet_direction,
      v_total_fee,
      p_admin_id,
      'NO_WINNING_ENTRIES_FEE_RETAINED',
      p_idempotency_key || ':house_fee',
      p_pool_id, null, v_settlement.id
    );
  end if;

  update public.settlements
  set winning_option_id = p_winning_option_id,
      gross_pool = v_gross_pool,
      house_fee_bps = v_pool.house_fee_bps,
      house_fee_amount = v_total_fee,
      net_prize_pool = 0,
      winning_entry_count = 0,
      payout_per_entry = 0,
      outcome = 'NO_WINNING_ENTRIES_FEE_RETAINED',
      confirmed_by_admin_id = p_admin_id,
      confirmed_at = now()
  where id = v_settlement.id;

  update public.pools
  set status = 'VOIDED', void_reason = 'NO_WINNING_ENTRIES_FEE_RETAINED'
  where id = p_pool_id;

  select * into v_pool from public.pools where id = p_pool_id;
  return v_pool;
end;
$$;

revoke all on function public.confirm_combo_refund_fee_retained(uuid, uuid, integer, text, uuid) from public;
grant execute on function public.confirm_combo_refund_fee_retained(uuid, uuid, integer, text, uuid) to service_role;
