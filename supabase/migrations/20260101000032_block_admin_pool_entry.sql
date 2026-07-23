-- Admins/super_admins coordinate pools, they don't play in them — block
-- entry at the RPC level (defense in depth; enterPoolAction already
-- rejects this app-side, but create_pool_entry is service-role-only and
-- reachable by nothing else, so both layers should agree independently).

create or replace function public.create_pool_entry(
  p_pool_id uuid,
  p_user_id uuid,
  p_option_id uuid,
  p_amount bigint,
  p_idempotency_key text
)
returns public.entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.entries;
  v_user public.user_profiles;
  v_pool public.pools;
  v_option public.pool_options;
  v_result public.entries;
begin
  select * into v_existing from public.entries where idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  select * into v_user from public.user_profiles where id = p_user_id;
  if not found or not v_user.is_active then
    raise exception 'user_inactive';
  end if;
  if v_user.role in ('admin', 'super_admin') then
    raise exception 'admin_cannot_enter_pool';
  end if;

  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;
  if v_pool.status <> 'OPEN' then
    raise exception 'pool_not_open';
  end if;
  if now() >= v_pool.locks_at then
    raise exception 'pool_locked';
  end if;

  select * into v_option from public.pool_options where id = p_option_id and pool_id = p_pool_id;
  if not found then
    raise exception 'invalid_option';
  end if;

  if p_amount <> v_pool.entry_fee then
    raise exception 'amount_mismatch';
  end if;

  begin
    insert into public.entries (pool_id, user_id, option_id, amount, status, idempotency_key)
    values (p_pool_id, p_user_id, p_option_id, p_amount, 'ACTIVE', p_idempotency_key)
    returning * into v_result;
  exception when unique_violation then
    -- Either the idempotency key raced, or the one-entry-per-pool index
    -- fired — either way, the spec wants an idempotent success returning
    -- the user's existing entry, not an error.
    select * into v_existing from public.entries where idempotency_key = p_idempotency_key;
    if found then
      return v_existing;
    end if;

    select * into v_existing from public.entries
      where pool_id = p_pool_id and user_id = p_user_id and status in ('ACTIVE', 'WON', 'LOST');
    return v_existing;
  end;

  -- Debit the wallet — reused from Phase 2. If this raises (insufficient
  -- balance), the whole function rolls back, entry insert included.
  perform public.apply_wallet_transaction(
    'user'::public.wallet_account_type,
    p_user_id,
    'pool_entry_debit'::public.wallet_transaction_type,
    'debit'::public.wallet_direction,
    p_amount,
    null,
    null,
    p_idempotency_key || ':wallet',
    p_pool_id,
    v_result.id,
    null
  );

  update public.pool_options
  set entry_count = entry_count + 1, total_entry_amount = total_entry_amount + p_amount
  where id = p_option_id;

  if v_pool.first_entry_at is null then
    update public.pools set first_entry_at = now() where id = p_pool_id;
  end if;

  return v_result;
end;
$$;
