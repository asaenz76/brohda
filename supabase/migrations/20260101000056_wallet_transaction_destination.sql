-- A withdrawal request now requires the player to say where to send the
-- funds (Venmo username, cashtag, wallet address + network, etc.) in its
-- `note` field. That text needs to survive past approval so the resulting
-- wallet_transactions row — the only thing players/admins/super admins see
-- in the ledger afterward — still shows it, instead of it staying trapped
-- on the wallet_requests row. Same snapshot-at-write-time approach as
-- 20260101000053_wallet_transaction_context_snapshot.sql.
alter table public.wallet_transactions
  add column destination text;

-- `create or replace` only replaces a function whose argument list is
-- identical — adding a new trailing parameter changes the signature, so it
-- would otherwise leave both the old 11-arg and new 12-arg versions in
-- place as overloads, which PostgREST then can't disambiguate between for
-- any RPC call (PGRST203, "Could not choose the best candidate function").
-- Drop the old signature first so only one version exists afterward.
drop function if exists public.apply_wallet_transaction(
  public.wallet_account_type, uuid, public.wallet_transaction_type, public.wallet_direction,
  bigint, uuid, text, text, uuid, uuid, uuid
);

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
  p_settlement_id uuid default null,
  p_destination text default null
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
    pool_question, fixture_label, competition_name, option_label, destination
  ) values (
    p_account_type, p_user_id, p_type, p_direction, p_amount,
    v_balance_row.balance, v_new_balance, v_balance_row.currency,
    p_pool_id, p_entry_id, p_settlement_id, p_admin_id, p_reason, p_idempotency_key,
    v_pool_question, v_fixture_label, v_competition_name, v_option_label, p_destination
  ) returning * into v_result;

  update public.wallet_balances
  set balance = v_new_balance, updated_at = now()
  where id = v_balance_row.id;

  return v_result;
end;
$$;
