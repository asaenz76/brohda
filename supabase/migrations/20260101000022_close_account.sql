-- Self-service account closure (self-exclusion compliance). Full erasure is
-- neither technically possible (wallet_transactions/audit_logs are
-- append-only — no DELETE grant on the former, a hard trigger blocks the
-- latter, both intentionally) nor what most self-exclusion regimes actually
-- require: they need the operator to retain enough of a record to
-- permanently refuse the same person a new account, plus the financial
-- audit trail. This does the reconcilable version instead: deactivate
-- (blocks login via isUsableSession(), same lever as an admin-driven
-- deactivation) and irreversibly scrub the identifying fields, while
-- leaving auth.users' row (and thus the email) in place forever — that's
-- what actually blocks re-registration, since email is unique there.
--
-- Guards mirror the same "don't let money move after this point" shape as
-- every other financial mutation in this codebase: a service-role-only
-- SQL function, called from the Next.js server action (which owns the
-- requireUser() gate and the typed confirmation), never granted to
-- authenticated directly.
create or replace function public.close_own_account(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance bigint;
  v_pending_requests int;
  v_active_entries int;
begin
  select balance into v_balance
  from public.wallet_balances
  where user_id = p_user_id and account_type = 'user';

  if v_balance is null then
    raise exception 'wallet_not_found';
  end if;

  if v_balance != 0 then
    raise exception 'nonzero_balance';
  end if;

  select count(*) into v_pending_requests
  from public.wallet_requests
  where user_id = p_user_id and status = 'pending';

  if v_pending_requests > 0 then
    raise exception 'pending_wallet_request';
  end if;

  -- An ACTIVE (unsettled) entry can still swing the balance positive later
  -- via settlement — closing now would strand a future payout in an
  -- account nobody can log into or withdraw from.
  select count(*) into v_active_entries
  from public.entries
  where user_id = p_user_id and status = 'ACTIVE';

  if v_active_entries > 0 then
    raise exception 'active_entries';
  end if;

  update public.user_profiles
  set is_active = false,
      display_name = 'Deleted User',
      username = null,
      avatar_url = null
  where id = p_user_id;
end;
$$;

revoke all on function public.close_own_account(uuid) from public;
grant execute on function public.close_own_account(uuid) to service_role;
