-- Stage 1: template versioning snapshot + the new balanced-participation
-- rule version, and the atomic RPC that replaces lockDuePools()'s/
-- advanceLockedPoolAction's previous two-round-trip (read state in JS, then
-- separately call an RPC) below-minimum decision — a real, if narrow, race
-- condition two overlapping invocations could hit. Everything now happens
-- under one `select ... for update` lock in a single RPC call.

alter table public.pools add column template_version integer;

-- NULL/legacy = today's behavior (min-entries only; a one-sided pool can
-- still proceed to settlement, same as always). 2 = the new binary
-- balanced-participation check below. Stamped only for newly-created
-- TEMPLATE_GRADED pools going forward (lib/actions/pools.ts) — never
-- backfilled onto any existing row, and never stamped for COMBO.
alter table public.pools add column participation_rule_version integer
  check (participation_rule_version is null or participation_rule_version = 2);

-- Reuses confirm_pool_refund (below-minimum and one-sided cases both funnel
-- through it, so wallet/refund logic is never duplicated) rather than
-- reimplementing any money movement here. Postgres allows a transaction to
-- re-acquire a row lock it already holds, so nesting a call to a function
-- that itself does `select ... for update` on the same pool row is safe —
-- this codebase already has precedent (reverse_pool_settlement calls
-- prepare_pool_settlement/prepare_pool_settlement_manual internally).
create or replace function public.advance_or_cancel_locked_pool(p_pool_id uuid, p_admin_id uuid default null)
returns public.pools
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
  v_total_valid_entries integer;
  v_yes_count integer;
  v_no_count integer;
  v_yes_entries integer;
  v_no_entries integer;
begin
  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  if v_pool.status <> 'LOCKED' then
    return v_pool; -- already advanced/cancelled/under review — idempotent no-op
  end if;

  select coalesce(sum(entry_count), 0) into v_total_valid_entries
    from public.pool_options where pool_id = p_pool_id;

  if v_total_valid_entries < v_pool.min_total_entries then
    return public.confirm_pool_refund(
      p_pool_id,
      'MINIMUM_ENTRIES_NOT_REACHED',
      p_pool_id::text || ':void:MINIMUM_ENTRIES_NOT_REACHED',
      p_admin_id
    );
  end if;

  if v_pool.participation_rule_version = 2 then
    -- Explicit counts, not a naive `select ... into` — that would silently
    -- return only one row if binary_outcome data were ever corrupted into
    -- having two YES options (or zero), masking the exact failure this
    -- check exists to catch.
    select count(*) filter (where binary_outcome = 'YES'),
           count(*) filter (where binary_outcome = 'NO')
      into v_yes_count, v_no_count
      from public.pool_options where pool_id = p_pool_id;

    if v_yes_count <> 1 or v_no_count <> 1 then
      update public.pools
      set status = 'MANUAL_REVIEW', review_reason = 'BINARY_OPTIONS_UNRESOLVABLE'
      where id = p_pool_id;

      select * into v_pool from public.pools where id = p_pool_id;
      return v_pool;
    end if;

    select entry_count into v_yes_entries from public.pool_options
      where pool_id = p_pool_id and binary_outcome = 'YES';
    select entry_count into v_no_entries from public.pool_options
      where pool_id = p_pool_id and binary_outcome = 'NO';

    if v_yes_entries = 0 or v_no_entries = 0 then
      return public.confirm_pool_refund(
        p_pool_id,
        'ONE_SIDED_POOL',
        p_pool_id::text || ':void:ONE_SIDED_POOL',
        p_admin_id
      );
    end if;
  end if;

  update public.pools set status = 'AWAITING_RESULT' where id = p_pool_id;
  select * into v_pool from public.pools where id = p_pool_id;
  return v_pool;
end;
$$;

revoke all on function public.advance_or_cancel_locked_pool(uuid, uuid) from public;
grant execute on function public.advance_or_cancel_locked_pool(uuid, uuid) to service_role;

-- ONE_SIDED_POOL is a "this didn't really happen" cancellation, same
-- semantics as MINIMUM_ENTRIES_NOT_REACHED/ADMIN_MANUAL_CANCEL — full
-- refund, no fee, status CANCELLED not VOIDED. review_reason is cleared on
-- every transition through this function so a pool that was MANUAL_REVIEW
-- (e.g. cancelled by an admin via ADMIN_MANUAL_CANCEL) doesn't carry stale
-- review state into its terminal status.
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
