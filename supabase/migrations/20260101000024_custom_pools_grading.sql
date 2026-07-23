-- Continuation of 20260101000023_custom_pools.sql: everything that uses
-- the 'CUSTOM' enum value added there.

-- A CUSTOM pool has no real-world event backing it, so fixture_id is no
-- longer always present.
alter table public.pools alter column fixture_id drop not null;

-- Mirrors prepare_pool_settlement's pool-lock/idempotency/gross-pool
-- computation (20260101000010_settlements.sql) but skips the fixture
-- lookup entirely and always requires a manual winner pick. Used both for
-- CUSTOM pools (which have no fixture at all) and as a super_admin
-- override to grade a real-fixture pool by hand instead of waiting on/
-- trusting the automatic score check. confirm_pool_settlement and the
-- existing SettlementReviewForm/confirmSettlementAction need no changes —
-- they already branch generically on requires_manual_verification and a
-- plain pool_options list, regardless of which function created the row.
--
-- Accepts LOCKED in addition to AWAITING_RESULT (unlike the automatic
-- path) — grading straight from LOCKED bypasses the below-minimum-entries
-- auto-refund check that normally happens at the LOCKED->AWAITING_RESULT
-- transition. Accepted tradeoff: a super_admin invoking this manually is
-- a deliberate override.
create or replace function public.prepare_pool_settlement_manual(p_pool_id uuid)
returns public.settlements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
  v_existing public.settlements;
  v_gross_pool bigint;
  v_total_valid_entries integer;
  v_result public.settlements;
begin
  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  select * into v_existing from public.settlements
    where pool_id = p_pool_id and grading_version = v_pool.snapshot_version;
  if found then
    return v_existing;
  end if;

  if v_pool.status not in ('LOCKED', 'AWAITING_RESULT') then
    raise exception 'pool_not_gradable';
  end if;

  select coalesce(sum(entry_count), 0), coalesce(sum(total_entry_amount), 0)
    into v_total_valid_entries, v_gross_pool
    from public.pool_options where pool_id = p_pool_id;

  insert into public.settlements (
    pool_id, grading_version, provider_status,
    winning_option_id, winning_option_reason, requires_manual_verification,
    gross_pool, house_fee_bps, house_fee_amount, net_prize_pool,
    winning_entry_count, payout_per_entry, rounding_remainder, outcome
  ) values (
    p_pool_id, v_pool.snapshot_version, 'MANUAL',
    null, null, true,
    v_gross_pool, v_pool.house_fee_bps, 0, 0, null, 0, 0, 'NORMAL'
  ) returning * into v_result;

  update public.pools set status = 'READY_FOR_REVIEW' where id = p_pool_id;

  return v_result;
end;
$$;

revoke all on function public.prepare_pool_settlement_manual(uuid) from public;
grant execute on function public.prepare_pool_settlement_manual(uuid) to service_role;
