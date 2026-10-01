-- Phase I (V1 backend + test-data decommission), step 3 of 3 — drop the
-- V1 Pool backend schema itself.
--
-- Prerequisite: application code for every object dropped here (admin Pool
-- tooling, lock-pools/process-results jobs, the Pool email, Pool
-- notification generation, the legacy Pool leaderboard/analytics RPCs'
-- only callers) was removed in this same phase, and wallet/notification
-- test data + the two hard FKs into pools/pool_options were resolved in
-- the two migrations immediately before this one. Every object below was
-- confirmed to have zero remaining Brohda 2.0 dependency by querying the
-- live database directly for exact function signatures, trigger names,
-- foreign keys, view definitions, and RLS policy bodies — not
-- reconstructed from memory or a single grep pass. One live, actively-used
-- function (close_own_account) does reference a Pool table and is fixed
-- in place below rather than dropped.
--
-- Order (verified against a real failure, not assumed): redefine the one
-- shared function that needs fixing -> views (depend on both the
-- functions and tables below) -> every Pool function, RPC and trigger
-- (some, like add_pool_comment, RETURN the table's own row type, which is
-- a hard catalog dependency — functions must drop before their tables,
-- not after) -> tables, children before parents (no CASCADE needed; both
-- hard FKs from outside the Pool cluster were already cleared in the
-- prior two migrations) -> columns on tables that otherwise survive ->
-- enums, last, once nothing references them.
--
-- Historical migrations that created these objects are NOT modified —
-- they remain the accurate record of when/why this schema existed.

-- ==========================================================================
-- 0a. Fix the one live, shared function that touches a Pool table.
--    close_own_account blocked account closure on an ACTIVE (unsettled)
--    Pool entry — with entries gone, that condition can never occur again,
--    so the check is removed rather than left referencing a dropped table.
--    Every other line is unchanged from the function's current definition.
-- ==========================================================================
create or replace function public.close_own_account(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_balance bigint;
  v_pending_requests int;
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
$function$;

-- ==========================================================================
-- 0b. Fix the other live, shared function that touches Pool tables.
--    apply_wallet_transaction's p_pool_id/p_entry_id enrichment (populating
--    the wallet_transactions.pool_question/fixture_label/competition_name/
--    option_label stamp columns, kept below as shared wallet-ledger
--    infrastructure) selects from pools/fixtures/entries/pool_options —
--    about to be dropped. No current caller ever passes a non-null
--    p_pool_id/p_entry_id (grep-confirmed; Pool entries are gone), so this
--    is dead at the call-site level, but left as-is it would throw
--    "relation does not exist" the moment anything ever did pass one,
--    rather than erroring at the point of this migration. Every other line
--    (balance/idempotency/direction logic) is unchanged; only the two
--    selects against now-dropped tables are removed, leaving the stamp
--    columns null when no pool/entry context is given — which is always,
--    now.
-- ==========================================================================
create or replace function public.apply_wallet_transaction(
  p_account_type wallet_account_type,
  p_user_id uuid,
  p_type wallet_transaction_type,
  p_direction wallet_direction,
  p_amount bigint,
  p_admin_id uuid,
  p_reason text,
  p_idempotency_key text,
  p_pool_id uuid default null::uuid,
  p_entry_id uuid default null::uuid,
  p_settlement_id uuid default null::uuid,
  p_destination text default null::text
)
returns wallet_transactions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_existing public.wallet_transactions;
  v_balance_row public.wallet_balances;
  v_new_balance bigint;
  v_result public.wallet_transactions;
begin
  select * into v_existing
  from public.wallet_transactions
  where idempotency_key = p_idempotency_key;

  if found then
    return v_existing;
  end if;

  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  if p_account_type = 'user' then
    select * into v_balance_row
    from public.wallet_balances
    where user_id = p_user_id and account_type = 'user'
    for update;
  else
    select * into v_balance_row
    from public.wallet_balances
    where account_type = 'house'
    for update;
  end if;

  if not found then
    raise exception 'wallet balance row not found';
  end if;

  if p_direction = 'credit' then
    v_new_balance := v_balance_row.balance + p_amount;
  else
    v_new_balance := v_balance_row.balance - p_amount;
    if v_new_balance < v_balance_row.reserved_balance then
      raise exception 'insufficient_balance';
    end if;
  end if;

  insert into public.wallet_transactions (
    account_type, user_id, type, direction, amount,
    balance_before, balance_after, currency,
    pool_id, entry_id, settlement_id, admin_id, reason, idempotency_key,
    destination
  ) values (
    p_account_type, p_user_id, p_type, p_direction, p_amount,
    v_balance_row.balance, v_new_balance, v_balance_row.currency,
    p_pool_id, p_entry_id, p_settlement_id, p_admin_id, p_reason, p_idempotency_key,
    p_destination
  ) returning * into v_result;

  update public.wallet_balances
  set balance = v_new_balance, updated_at = now()
  where id = v_balance_row.id;

  return v_result;
end;
$function$;

-- ==========================================================================
-- 1. Views (must go before the functions they call and the tables they
--    select from — pool_options_public calls can_view_pool_distribution
--    and reads pools/pool_options).
-- ==========================================================================
drop view if exists public.pool_options_public;
drop view if exists public.fixtures_available_for_pool_creation;

-- ==========================================================================
-- 2. RPC functions — Pool entry/lifecycle/likes/comments/admin, the legacy
--    leaderboard/reputation stack, the Pool-visibility helpers, the
--    abandoned Pool-era Stories query, and the Pool-financial admin- and
--    consumer-analytics stacks (confirmed zero Brohda 2.0 caller for every
--    one of these; /admin/analytics itself is retired in this phase since
--    100% of its data was Pool/wallet-test financial metrics with no
--    Brohda 2.0 equivalent, and the consumer "get_user_*" variants were
--    already orphaned by Phase H's consumer /analytics removal). Must go
--    before the table drops below: add_pool_comment's return type is
--    pool_comments' own row type, a hard catalog dependency.
-- ==========================================================================
drop function if exists public.get_pool_participants(uuid);
drop function if exists public.get_pool_totals(uuid);
drop function if exists public.get_pool_totals_bulk(uuid[]);
drop function if exists public.get_pool_participants_bulk(uuid[]);
drop function if exists public.create_pool_entry(uuid, uuid, uuid, bigint, text);
drop function if exists public.void_pool_entry(uuid, uuid, text, text);
drop function if exists public.void_pool_no_refund(uuid, pool_void_reason, text, uuid, integer);
drop function if exists public.prepare_pool_settlement(uuid);
drop function if exists public.prepare_pool_settlement_manual(uuid);
drop function if exists public.confirm_pool_settlement(uuid, uuid, integer, text, uuid);
drop function if exists public.confirm_pool_grading_only(uuid, uuid, integer, text, uuid);
drop function if exists public.confirm_pool_refund(uuid, pool_void_reason, text, uuid, integer);
drop function if exists public.reverse_pool_settlement(uuid, uuid, text, text);
drop function if exists public.abort_pool_reversal(uuid, uuid);
drop function if exists public.undo_pool_grading(uuid, uuid);
drop function if exists public.advance_or_cancel_locked_pool(uuid, uuid);
drop function if exists public.delete_terminal_pool(uuid, uuid);
drop function if exists public.toggle_pool_like(uuid, uuid);
drop function if exists public.add_pool_comment(uuid, uuid, text, uuid);
drop function if exists public.delete_pool_comment(uuid, uuid);
drop function if exists public.seed_legacy_pool_for_tests(uuid, uuid, text, text, integer, integer, integer, timestamptz);
drop function if exists public.confirm_combo_refund_fee_retained(uuid, uuid, integer, text, uuid);
drop function if exists public.get_user_entry_history(timestamptz, timestamptz, text, integer);
drop function if exists public.get_leaderboard(text, text, uuid);
drop function if exists public.get_profile_stats(uuid);
drop function if exists public.get_pick_count(uuid);
drop function if exists public.can_view_pool_distribution(uuid);
drop function if exists public.user_has_entered_pool(uuid, uuid);
drop function if exists public.get_stories_row(uuid, timestamptz);
drop function if exists public.get_platform_overview(timestamptz, timestamptz);
drop function if exists public.get_platform_financial_overview(timestamptz, timestamptz);
drop function if exists public.get_platform_category_performance(timestamptz, timestamptz);
drop function if exists public.get_platform_monthly_activity(timestamptz, timestamptz, text, text);
drop function if exists public.get_platform_top_users(timestamptz, timestamptz, text, integer);
drop function if exists public.get_user_analytics_overview(timestamptz, timestamptz);
drop function if exists public.get_user_category_performance(timestamptz, timestamptz);
drop function if exists public.get_user_competition_performance(timestamptz, timestamptz);
drop function if exists public.get_user_cumulative_pnl(timestamptz, timestamptz, text, text);
drop function if exists public.get_user_financial_overview(timestamptz, timestamptz);
drop function if exists public.get_user_monthly_activity(timestamptz, timestamptz, text, text);

-- ==========================================================================
-- 3. Pool tables, in dependency order (children before parents) — no
--    CASCADE needed: every external reference (wallet_requests,
--    notifications) was already cleared in the two prior migrations, every
--    RPC function referencing them was just dropped above, and this order
--    already satisfies every FK within the Pool cluster itself. This also
--    removes each table's own trigger instances (e.g.
--    pools_enforce_fee_immutability on pools) — a trigger has a hard
--    catalog dependency on its function, so the function itself can only
--    be dropped once the trigger (and so the table) is gone, which is why
--    the trigger-function drop below comes after this, not before.
-- ==========================================================================
drop table if exists public.pool_grading_evidence;
drop table if exists public.pool_combo_legs;
drop table if exists public.pool_likes;
drop table if exists public.pool_comments;
drop table if exists public.settlement_payouts;
drop table if exists public.settlements;
drop table if exists public.entries;
drop table if exists public.pool_options;
drop table if exists public.pools;

-- ==========================================================================
-- 4. Trigger functions — now unreferenced (their only triggers lived on
--    the tables just dropped above). set_updated_at is NOT here, it's a
--    shared generic function still used by many other tables.
-- ==========================================================================
drop function if exists public.enforce_pool_fee_immutability();
drop function if exists public.enforce_pool_option_semantics_immutability();
drop function if exists public.reject_new_legacy_soccer_pool();
drop function if exists public.enforce_pool_capability();
drop function if exists public.forbid_pool_grading_evidence_mutation();

-- ==========================================================================
-- 5. Legacy leaderboard support table — fed only by the settlement RPCs
--    just dropped, read only by get_leaderboard (also just dropped). Its
--    only FK (user_id -> user_profiles) is independent of the Pool cluster.
-- ==========================================================================
drop table if exists public.correct_prediction_log;

-- ==========================================================================
-- 6. Legacy per-notification follow-preference tables. Schema-independent
--    of pools (FK to teams/leagues, not pools), but their only remaining
--    real-world readers were the Pool admin view-model, the Pool
--    follower-notification email, and one admin-only display panel — all
--    removed in this phase. Distinct from, and does not affect,
--    community_follows (the canonical Brohda 2.0 affinity signal).
-- ==========================================================================
drop table if exists public.team_follows;
drop table if exists public.league_follows;

-- ==========================================================================
-- 7. Pool-only columns on tables that otherwise survive
-- ==========================================================================
alter table public.fixtures drop column if exists hidden_from_pool_creation;
alter table public.league_season_imports drop column if exists pool_creation_enabled;
alter table public.platform_settings
  drop column if exists default_entry_fee_cents,
  drop column if exists default_house_fee_bps,
  drop column if exists default_tier_entry_fees_cents,
  drop column if exists paid_pools_enabled,
  drop column if exists free_pools_enabled;
-- correct_predictions_count/current_streak/best_streak: written only by the
-- settlement/grading/reversal RPCs just dropped, read only by
-- get_profile_stats (also just dropped) — fully orphaned. Distinct from
-- prediction_current_streak/prediction_best_streak (lib/predictions/
-- streak.ts), the real, deliberately-deferred Brohda 2.0 streak columns,
-- which this does not touch.
alter table public.user_profiles
  drop column if exists correct_predictions_count,
  drop column if exists current_streak,
  drop column if exists best_streak;

-- ==========================================================================
-- 8. Pool-only enum types — safe now that every column and function
--    signature using them is gone.
-- ==========================================================================
drop type if exists public.pool_type;
drop type if exists public.pool_status;
drop type if exists public.pool_visibility;
drop type if exists public.participation_visibility;
drop type if exists public.entry_status;
drop type if exists public.winning_option_reason;
drop type if exists public.pool_void_reason;
drop type if exists public.entry_mode;
drop type if exists public.analytics_category;
drop type if exists public.pool_review_reason;