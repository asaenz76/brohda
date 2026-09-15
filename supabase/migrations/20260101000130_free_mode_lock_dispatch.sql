-- FREE prediction mode — Phase 1 (lock-time dispatch, §8).
--
-- advance_or_cancel_locked_pool's two automatic-void call sites (below
-- min_total_entries, and one-sided TEMPLATE_GRADED pools) now dispatch to
-- void_pool_no_refund for a FREE pool instead of confirm_pool_refund —
-- calling confirm_pool_refund on a FREE pool's entries would attempt
-- apply_wallet_transaction with a null amount, which apply_wallet_transaction
-- does not accept (entries.amount is null for FREE, and
-- wallet_transactions.amount is NOT NULL — the insert would fail with an
-- unhandled constraint violation rather than a designed exception). All
-- other logic (min-entries check, one-sided-pool check, MANUAL_REVIEW
-- routing) is unchanged and mode-agnostic — it operates on entry_count,
-- which both modes maintain identically.

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
    if v_pool.entry_mode = 'FREE' then
      return public.void_pool_no_refund(
        p_pool_id,
        'MINIMUM_ENTRIES_NOT_REACHED',
        p_pool_id::text || ':void:MINIMUM_ENTRIES_NOT_REACHED',
        p_admin_id
      );
    end if;
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
      if v_pool.entry_mode = 'FREE' then
        return public.void_pool_no_refund(
          p_pool_id,
          'ONE_SIDED_POOL',
          p_pool_id::text || ':void:ONE_SIDED_POOL',
          p_admin_id
        );
      end if;
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
