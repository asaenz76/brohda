-- Phase 2: ledger-based wallet (spec §8, §18, §19)

create type public.wallet_account_type as enum ('user', 'house');
create type public.wallet_direction as enum ('credit', 'debit');

-- All 11 types from spec §8.1. Only manual_deposit/manual_withdrawal are
-- used until Phase 4/5 (entries, settlement, reversal) — reserved now to
-- avoid an ALTER TYPE migration later.
create type public.wallet_transaction_type as enum (
  'manual_deposit',
  'manual_withdrawal',
  'pool_entry_debit',
  'pool_payout_credit',
  'pool_refund_credit',
  'admin_adjustment_credit',
  'admin_adjustment_debit',
  'settlement_reversal_debit',
  'settlement_reversal_credit',
  'house_fee_credit',
  'rounding_remainder_credit'
);

create table public.wallet_balances (
  id uuid primary key default gen_random_uuid(),
  account_type public.wallet_account_type not null,
  -- 1:1 with a profile (like user_profiles.id -> auth.users.id), so it
  -- cascades the same way. wallet_transactions.user_id below intentionally
  -- does NOT cascade — ledger history must survive even if a profile is
  -- ever hard-deleted (which normal operation never does; users are
  -- deactivated, not deleted).
  user_id uuid references public.user_profiles (id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  currency text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Exactly one wallet row per user, and exactly one house row.
create unique index wallet_balances_one_per_user
  on public.wallet_balances (user_id) where account_type = 'user';
create unique index wallet_balances_one_house
  on public.wallet_balances ((true)) where account_type = 'house';

create trigger wallet_balances_set_updated_at
before update on public.wallet_balances
for each row execute function public.set_updated_at();

insert into public.wallet_balances (account_type, user_id, balance, currency)
values ('house', null, 0, 'USD');

-- Every user_profile (admin or player) gets a matching wallet row
-- automatically — nothing upstream needs to remember to create one.
create or replace function public.create_wallet_for_new_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.wallet_balances (account_type, user_id, balance, currency)
  values ('user', new.id, 0, 'USD');
  return new;
end;
$$;

create trigger user_profiles_create_wallet
after insert on public.user_profiles
for each row execute function public.create_wallet_for_new_profile();

create table public.wallet_transactions (
  id uuid primary key default gen_random_uuid(),
  account_type public.wallet_account_type not null,
  user_id uuid references public.user_profiles (id),
  type public.wallet_transaction_type not null,
  direction public.wallet_direction not null,
  amount bigint not null check (amount > 0),
  balance_before bigint not null,
  balance_after bigint not null,
  currency text not null default 'USD',
  -- Nullable, no FK yet: pools/entries/settlements don't exist until
  -- Phase 4/5. FKs are added via ALTER TABLE in those migrations.
  pool_id uuid,
  entry_id uuid,
  settlement_id uuid,
  admin_id uuid references public.user_profiles (id),
  reason text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create index wallet_transactions_user_idx
  on public.wallet_transactions (user_id, created_at desc);

alter table public.wallet_balances enable row level security;
alter table public.wallet_transactions enable row level security;

create policy "select_own_wallet_balance"
on public.wallet_balances for select
to authenticated
using (user_id = auth.uid());

create policy "select_all_wallet_balances_as_admin"
on public.wallet_balances for select
to authenticated
using (public.is_super_admin(auth.uid()));

create policy "select_own_wallet_transactions"
on public.wallet_transactions for select
to authenticated
using (user_id = auth.uid());

create policy "select_all_wallet_transactions_as_admin"
on public.wallet_transactions for select
to authenticated
using (public.is_super_admin(auth.uid()));

-- No INSERT/UPDATE/DELETE grants to authenticated on either table: every
-- write goes through apply_wallet_transaction() via the service role.
grant select on public.wallet_balances to authenticated;
grant select on public.wallet_transactions to authenticated;
grant select, update on public.wallet_balances to service_role;
grant select, insert on public.wallet_transactions to service_role;

-- Append-only, reusing the same append-only guard already established for
-- audit_logs.
create trigger wallet_transactions_no_update
before update on public.wallet_transactions
for each row execute function public.forbid_audit_log_mutation();

create trigger wallet_transactions_no_delete
before delete on public.wallet_transactions
for each row execute function public.forbid_audit_log_mutation();

-- The one place money moves. SECURITY DEFINER + fixed search_path, callable
-- only by service_role — mirrors check_and_increment_rate_limit's shape.
create or replace function public.apply_wallet_transaction(
  p_account_type public.wallet_account_type,
  p_user_id uuid,
  p_type public.wallet_transaction_type,
  p_direction public.wallet_direction,
  p_amount bigint,
  p_admin_id uuid,
  p_reason text,
  p_idempotency_key text,
  p_pool_id uuid default null,
  p_entry_id uuid default null,
  p_settlement_id uuid default null
)
returns public.wallet_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.wallet_transactions;
  v_balance_row public.wallet_balances;
  v_new_balance bigint;
  v_result public.wallet_transactions;
begin
  select * into v_existing
  from public.wallet_transactions
  where idempotency_key = p_idempotency_key;

  if found then
    return v_existing;
  end if;

  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  if p_account_type = 'user' then
    select * into v_balance_row
    from public.wallet_balances
    where user_id = p_user_id and account_type = 'user'
    for update;
  else
    select * into v_balance_row
    from public.wallet_balances
    where account_type = 'house'
    for update;
  end if;

  if not found then
    raise exception 'wallet balance row not found';
  end if;

  if p_direction = 'credit' then
    v_new_balance := v_balance_row.balance + p_amount;
  else
    v_new_balance := v_balance_row.balance - p_amount;
    if v_new_balance < 0 then
      raise exception 'insufficient_balance';
    end if;
  end if;

  insert into public.wallet_transactions (
    account_type, user_id, type, direction, amount,
    balance_before, balance_after, currency,
    pool_id, entry_id, settlement_id, admin_id, reason, idempotency_key
  ) values (
    p_account_type, p_user_id, p_type, p_direction, p_amount,
    v_balance_row.balance, v_new_balance, v_balance_row.currency,
    p_pool_id, p_entry_id, p_settlement_id, p_admin_id, p_reason, p_idempotency_key
  ) returning * into v_result;

  update public.wallet_balances
  set balance = v_new_balance, updated_at = now()
  where id = v_balance_row.id;

  return v_result;
end;
$$;

revoke all on function public.apply_wallet_transaction(
  public.wallet_account_type, uuid, public.wallet_transaction_type,
  public.wallet_direction, bigint, uuid, text, text, uuid, uuid, uuid
) from public;

grant execute on function public.apply_wallet_transaction(
  public.wallet_account_type, uuid, public.wallet_transaction_type,
  public.wallet_direction, bigint, uuid, text, text, uuid, uuid, uuid
) to service_role;
