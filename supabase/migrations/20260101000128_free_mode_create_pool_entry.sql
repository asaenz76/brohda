-- FREE prediction mode — Phase 1 (create_pool_entry).
--
-- Adds, ahead of the existing PAID money-moving code (preserved verbatim):
--   1. The entry-time capability gate (§5.2, §7) — fail-closed, linearized
--      against the admin toggle via `SELECT ... FOR SHARE` on the
--      platform_settings singleton row (see the architecture doc's
--      TOGGLE/ENTRY SERIALIZATION DESIGN for the full Postgres lock-mode
--      analysis: FOR SHARE conflicts with the FOR NO KEY UPDATE an UPDATE
--      implicitly takes, but never with other concurrent FOR SHARE
--      readers, so entries never serialize against each other — only
--      against the rare admin write).
--   2. Mode dispatch for the amount contract: PAID keeps the existing
--      amount_mismatch check (now with an explicit `p_amount is null`
--      branch — previously `p_amount <> v_pool.entry_fee` with a null
--      p_amount evaluated to SQL NULL, neither true nor false, and would
--      have silently fallen through); FREE rejects any non-null
--      client-supplied amount outright (amount_not_allowed_for_free_pool)
--      rather than coercing it to null.
--
-- Canonical lock order (must be preserved by any future function touching
-- both tables): lock the specific `pools` row first (`for update`, already
-- this function's existing first step), then `platform_settings`
-- (`for share`). The only writer of platform_settings — the admin toggle
-- action — never subsequently locks a `pools` row, so this order can never
-- form a deadlock cycle. See §13 for the full analysis.
--
-- Every line of the original PAID debit/insert/counter-update logic below
-- is unchanged from the live function this replaces — confirmed by diff
-- against the function actually running in this database before this
-- migration. apply_wallet_transaction itself receives zero modifications.

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
  v_constraint_name text;
  v_paid_enabled boolean;
  v_free_enabled boolean;
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

  -- Entry-time capability gate (§5.2 item 2) — the authoritative boundary.
  -- FOR SHARE is the linearization point against the admin's UPDATE; see
  -- this migration's header comment.
  select paid_pools_enabled, free_pools_enabled
    into v_paid_enabled, v_free_enabled
    from public.platform_settings
    where id = true
    for share;

  if not found then
    -- Fail closed: a missing singleton row is an operational anomaly, not
    -- an implicit "enabled." Distinct exception name so this is
    -- distinguishable from an intentional disable in logs/monitoring.
    raise exception 'platform_settings_missing';
  end if;

  if v_pool.entry_mode = 'PAID' then
    if v_paid_enabled is distinct from true then
      -- Catches false AND null. NULL is not reachable under the current
      -- `not null` column definition, but this is deliberately defensive
      -- against any future relaxation of that constraint.
      raise exception 'paid_pools_disabled';
    end if;

    if p_amount is null or p_amount <> v_pool.entry_fee then
      raise exception 'amount_mismatch';
    end if;
  else -- FREE
    if v_free_enabled is distinct from true then
      raise exception 'free_pools_disabled';
    end if;

    -- Reject, don't coerce. The canonical FREE request supplies
    -- p_amount = null. A caller that supplies any non-null amount
    -- (including 0) is rejected explicitly, before the entry row exists —
    -- never silently rewritten.
    if p_amount is not null then
      raise exception 'amount_not_allowed_for_free_pool';
    end if;
  end if;

  begin
    insert into public.entries (pool_id, user_id, option_id, amount, status, idempotency_key, tier_group_id)
    values (p_pool_id, p_user_id, p_option_id, p_amount, 'ACTIVE', p_idempotency_key, v_pool.tier_group_id)
    returning * into v_result;
  exception when unique_violation then
    get stacked diagnostics v_constraint_name = constraint_name;

    if v_constraint_name = 'entries_idempotency_key_key' then
      select * into v_existing from public.entries where idempotency_key = p_idempotency_key;
      return v_existing;
    elsif v_constraint_name = 'unique_active_user_entry_per_tier_group' then
      raise exception 'already_entered_tier_group';
    elsif v_constraint_name = 'unique_active_user_entry_per_pool' then
      select * into v_existing from public.entries
        where pool_id = p_pool_id and user_id = p_user_id and status in ('ACTIVE', 'WON', 'LOST');
      return v_existing;
    else
      raise;
    end if;
  end;

  -- Debit the wallet — reused from Phase 2. If this raises (insufficient
  -- balance), the whole function rolls back, entry insert included.
  -- Never reached for a FREE entry (p_amount is null past the guard above,
  -- and only the PAID branch calls this).
  if v_pool.entry_mode = 'PAID' then
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
  end if;

  update public.pool_options
  set entry_count = entry_count + 1, total_entry_amount = total_entry_amount + coalesce(p_amount, 0)
  where id = p_option_id;

  if v_pool.first_entry_at is null then
    update public.pools set first_entry_at = now() where id = p_pool_id;
  end if;

  return v_result;
end;
$$;

-- Grants unchanged from the original function (service_role only) —
-- create or replace preserves existing grants in Postgres, but stated
-- explicitly here per the RPC-grant-drift precedent (SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md):
revoke all on function public.create_pool_entry(uuid, uuid, uuid, bigint, text) from public;
grant execute on function public.create_pool_entry(uuid, uuid, uuid, bigint, text) to service_role;
