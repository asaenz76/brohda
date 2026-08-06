-- close_own_account (20260101000022) scrubbed display_name/username/
-- avatar_url but left bio/pronouns/gender/stories_last_seen_at untouched —
-- a "closed" account could still show identifying free text via
-- public_profiles. Extends the same irreversible scrub, no new guards
-- needed (the existing balance/pending-request/active-entry checks above
-- this update are unchanged).
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
      avatar_url = null,
      bio = null,
      pronouns = null,
      gender = null,
      stories_last_seen_at = null
  where id = p_user_id;
end;
$$;
