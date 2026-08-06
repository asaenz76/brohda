-- 20260101000047_defense_in_depth_role_checks.sql added an authorization
-- check to confirm_pool_refund: p_admin_id is null for fully-automatic
-- system calls (below-minimum-entries cancellation at lock time, X.7
-- anomaly voids from the process-results cron), but whenever a human admin
-- id is passed it must actually belong to a super admin. That check was
-- silently dropped when 20260101000089_binary_pool_participation_rpc.sql's
-- `create or replace function public.confirm_pool_refund(...)` (adding the
-- ONE_SIDED_POOL void reason) redefined the function body from scratch
-- without carrying it forward — CREATE OR REPLACE fully replaces a
-- function, so the currently-live confirm_pool_refund has had no internal
-- admin-identity check since. This restores it, identical to 47's version,
-- on top of everything 89 already added.
create or replace function public.confirm_pool_refund(
  p_pool_id uuid,
  p_void_reason public.pool_void_reason,
  p_idempotency_key text,
  p_admin_id uuid default null,
  p_grading_version integer default null
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
  v_new_status public.pool_status;
begin
  -- p_admin_id is null for fully-automatic system calls (below-minimum-
  -- entries cancellation at lock time, X.7 anomaly voids from the
  -- process-results cron) — those are gated by the cron route's own
  -- CRON_SECRET check, not by a human identity here.
  if p_admin_id is not null and not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  if v_pool.status in (
    'SETTLED', 'VOIDED', 'CANCELLED', 'SETTLEMENT_REVERSED', 'REVERSAL_FAILED_MANUAL_REVIEW'
  ) then
    return v_pool; -- already terminal — idempotent no-op
  end if;

  if p_grading_version is not null then
    if v_pool.snapshot_version <> p_grading_version then
      raise exception 'stale_snapshot';
    end if;

    select * into v_settlement from public.settlements
      where pool_id = p_pool_id and grading_version = p_grading_version for update;
  end if;

  v_new_status := case when p_void_reason in ('MINIMUM_ENTRIES_NOT_REACHED', 'ADMIN_MANUAL_CANCEL', 'ONE_SIDED_POOL')
    then 'CANCELLED'::public.pool_status else 'VOIDED'::public.pool_status end;

  for v_entry in
    select * from public.entries where pool_id = p_pool_id and status = 'ACTIVE' for update
  loop
    perform public.apply_wallet_transaction(
      'user'::public.wallet_account_type,
      v_entry.user_id,
      'pool_refund_credit'::public.wallet_transaction_type,
      'credit'::public.wallet_direction,
      v_entry.amount,
      p_admin_id,
      p_void_reason::text,
      p_idempotency_key || ':refund:' || v_entry.id,
      p_pool_id, v_entry.id, null
    );

    update public.entries set status = 'REFUNDED' where id = v_entry.id;
  end loop;

  update public.pools
  set status = v_new_status, void_reason = p_void_reason, review_reason = null
  where id = p_pool_id;

  if v_settlement.id is not null then
    update public.settlements
    set confirmed_by_admin_id = p_admin_id, confirmed_at = now()
    where id = v_settlement.id;
  end if;

  select * into v_pool from public.pools where id = p_pool_id;
  return v_pool;
end;
$$;

revoke all on function public.confirm_pool_refund(uuid, public.pool_void_reason, text, uuid, integer) from public;
grant execute on function public.confirm_pool_refund(uuid, public.pool_void_reason, text, uuid, integer) to service_role;
