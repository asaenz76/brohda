-- lib/wallet/ledger.ts currently resolves each row's context (which pool,
-- which fixture, which option was picked) via a live join through
-- pool_id/entry_id at read time. But delete_terminal_pool cascades entries/
-- pool_options/settlements deletion when a pool is hard-deleted (unlike
-- wallet_transactions itself, which is append-only/undeletable) — so any
-- transaction tied to a pool that's since been cleaned up permanently loses
-- its context, inconsistently, depending only on whether that one pool
-- still happens to exist. Same class of bug as notifications.pool_id
-- getting nulled on delete; same fix — snapshot the descriptive text onto
-- the ledger row itself, at the moment it's created, when the source rows
-- are guaranteed to still exist.
alter table public.wallet_transactions
  add column pool_question text,
  add column fixture_label text,
  add column competition_name text,
  add column option_label text;

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
  v_pool_question text;
  v_fixture_label text;
  v_competition_name text;
  v_option_label text;
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

  if p_pool_id is not null then
    select coalesce(p.title, p.question),
           case when f.id is not null then f.home_team_name || ' vs ' || f.away_team_name else null end,
           f.competition_name
      into v_pool_question, v_fixture_label, v_competition_name
    from public.pools p
    left join public.fixtures f on f.id = p.fixture_id
    where p.id = p_pool_id;
  end if;

  if p_entry_id is not null then
    select po.label into v_option_label
    from public.entries e
    join public.pool_options po on po.id = e.option_id
    where e.id = p_entry_id;
  end if;

  insert into public.wallet_transactions (
    account_type, user_id, type, direction, amount,
    balance_before, balance_after, currency,
    pool_id, entry_id, settlement_id, admin_id, reason, idempotency_key,
    pool_question, fixture_label, competition_name, option_label
  ) values (
    p_account_type, p_user_id, p_type, p_direction, p_amount,
    v_balance_row.balance, v_new_balance, v_balance_row.currency,
    p_pool_id, p_entry_id, p_settlement_id, p_admin_id, p_reason, p_idempotency_key,
    v_pool_question, v_fixture_label, v_competition_name, v_option_label
  ) returning * into v_result;

  update public.wallet_balances
  set balance = v_new_balance, updated_at = now()
  where id = v_balance_row.id;

  return v_result;
end;
$$;

-- One-time backfill for existing rows — can only recover context for pools/
-- entries that still exist today; anything already cleaned up stays null,
-- same as before this migration (no way to reconstruct deleted data).
-- wallet_transactions_no_update blocks this unconditionally (like every
-- other update), so it's disabled for just this one controlled backfill
-- and re-enabled immediately after — nothing else runs in between.
alter table public.wallet_transactions disable trigger wallet_transactions_no_update;

update public.wallet_transactions wt
set pool_question = coalesce(p.title, p.question),
    fixture_label = case when f.id is not null then f.home_team_name || ' vs ' || f.away_team_name else null end,
    competition_name = f.competition_name
from public.pools p
left join public.fixtures f on f.id = p.fixture_id
where wt.pool_id = p.id and wt.pool_question is null;

update public.wallet_transactions wt
set option_label = po.label
from public.entries e
join public.pool_options po on po.id = e.option_id
where wt.entry_id = e.id and wt.option_label is null;

alter table public.wallet_transactions enable trigger wallet_transactions_no_update;
