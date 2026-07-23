-- Extends pool deletion beyond the original "zero entries ever" case:
-- super_admin can now also hard-delete a pool once it's reached a genuinely
-- terminal status (SETTLED/CANCELLED/VOIDED), for database cleanup — the
-- kind of thing that piles up after enough test runs or just normal
-- platform life. Still blocked for anything mid-lifecycle (OPEN/LOCKED/
-- AWAITING_RESULT/DRAFT — use Cancel Pool; READY_FOR_REVIEW/
-- SETTLEMENT_REVERSED/REVERSAL_FAILED_MANUAL_REVIEW — resolve those first).
--
-- Wrapped in one plpgsql function (not sequential JS calls, unlike the
-- original zero-entry-only cascade) because this path can now touch real
-- settled money history and leaderboard stats — a partial failure midway
-- through decrementing a user's correct_predictions_count with no pool
-- actually deleted would leave the leaderboard permanently wrong. Every
-- other multi-step financial mutation in this codebase (settle/refund/
-- reverse) already follows this same one-transaction pattern.
--
-- wallet_transactions is deliberately left untouched: it has no enforced
-- FK to pools/entries/settlements (confirmed in
-- 20260101000007_wallet.sql's own comment), and every place that reads it
-- (Activity, Wallet, house revenue reporting) already does a defensive
-- Map-lookup that tolerates a missing pool — a user's own financial ledger
-- must never disappear just because the pool that caused it did.
create or replace function public.delete_terminal_pool(
  p_pool_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
  v_entry record;
  v_settlement_ids uuid[];
begin
  select * into v_pool from public.pools where id = p_pool_id for update;
  if not found then
    raise exception 'pool_not_found';
  end if;

  if v_pool.first_entry_at is not null and v_pool.status not in ('SETTLED', 'CANCELLED', 'VOIDED') then
    raise exception 'pool_not_deletable';
  end if;

  -- Roll back leaderboard stats for any WON entries this pool contributed
  -- — the exact same decrement reverse_pool_settlement already performs
  -- when undoing a confirmed settlement's effects. best_streak is a
  -- historical high-water mark and is deliberately left alone, matching
  -- that same precedent.
  for v_entry in
    select user_id from public.entries where pool_id = p_pool_id and status = 'WON'
  loop
    update public.user_profiles
    set correct_predictions_count = greatest(correct_predictions_count - 1, 0),
        current_streak = greatest(current_streak - 1, 0)
    where id = v_entry.user_id;
  end loop;

  select array_agg(id) into v_settlement_ids from public.settlements where pool_id = p_pool_id;

  if v_settlement_ids is not null then
    delete from public.settlement_payouts where settlement_id = any(v_settlement_ids);
  end if;
  -- pool_likes/pool_comments cascade automatically (ON DELETE CASCADE).
  delete from public.correct_prediction_log where pool_id = p_pool_id;
  delete from public.entries where pool_id = p_pool_id;
  delete from public.settlements where pool_id = p_pool_id;
  delete from public.pool_combo_legs where pool_id = p_pool_id;
  delete from public.pool_options where pool_id = p_pool_id;
  -- Notification history is kept, just detached from the deleted pool.
  update public.notifications set pool_id = null where pool_id = p_pool_id;

  delete from public.pools where id = p_pool_id;
end;
$$;

revoke all on function public.delete_terminal_pool(uuid) from public;
grant execute on function public.delete_terminal_pool(uuid) to service_role;
