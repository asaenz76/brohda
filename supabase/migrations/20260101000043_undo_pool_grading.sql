-- undo_pool_grading: lets a super_admin back out of a pool that's been
-- prepared for review (READY_FOR_REVIEW) but never confirmed — e.g. the
-- wrong grading path was used (generic "Grade manually" instead of a
-- COMBO's leg checkboxes), or the admin just wants to re-grade before
-- committing. Since nothing has been confirmed yet, no wallet transaction
-- has ever run for this settlement — this is a pure state-machine revert,
-- not a financial reversal (that's the separate, already-existing
-- reverse_pool_settlement flow, which undoes a *confirmed* settlement's
-- money movement and is deliberately out of scope here).
--
-- Reverts to LOCKED unconditionally rather than trying to restore whatever
-- status preceded READY_FOR_REVIEW (LOCKED or AWAITING_RESULT) — LOCKED is
-- always a valid, safe landing spot: AdvanceLockedPoolButton already lets
-- the admin move it back to AWAITING_RESULT by hand if that's what they
-- actually need next.
create or replace function public.undo_pool_grading(
  p_pool_id uuid,
  p_admin_id uuid
)
returns public.pools
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
  v_settlement public.settlements;
begin
  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  if v_pool.status <> 'READY_FOR_REVIEW' then
    raise exception 'pool_not_pending_review';
  end if;

  select * into v_settlement from public.settlements
    where pool_id = p_pool_id and grading_version = v_pool.snapshot_version for update;
  if not found then
    raise exception 'settlement_not_found';
  end if;

  if v_settlement.confirmed_at is not null then
    raise exception 'settlement_already_confirmed';
  end if;

  delete from public.settlements where id = v_settlement.id;
  -- Clears any winning_option_id gradeComboLegsAction may have stamped for
  -- the zero-entries case before this undo — a clean slate to re-grade from.
  update public.pool_options set is_winning_option = false where pool_id = p_pool_id;
  update public.pools set status = 'LOCKED' where id = p_pool_id;

  select * into v_pool from public.pools where id = p_pool_id;
  return v_pool;
end;
$$;

revoke all on function public.undo_pool_grading(uuid, uuid) from public;
grant execute on function public.undo_pool_grading(uuid, uuid) to service_role;
