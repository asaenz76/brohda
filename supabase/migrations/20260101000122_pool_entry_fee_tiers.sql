-- Entry-fee tiers: the same matchup+question offered at several entry-fee
-- amounts as one linked batch (e.g. $5/$10/$25/$50/$100/$250), each amount
-- a fully separate pools row — own entries, own wallet_transactions, own
-- prize pool, exactly like any other pool today. tier_group_id is the only
-- new concept: a plain nullable uuid shared by every pool row in a batch,
-- generated once by the app at creation time. Not a FK — it isn't unique
-- per row on pools (many rows share one value), so it can't target a
-- unique key the way fixture_id/created_by do.
alter table public.pools add column tier_group_id uuid;
create index idx_pools_tier_group on public.pools (tier_group_id) where tier_group_id is not null;

-- Denormalized copy on entries, populated server-side inside
-- create_pool_entry from the already-locked pools row (never
-- client-supplied) — needed so the new one-entry-per-tier-group rule below
-- can be enforced by a plain partial unique index, the same mechanism
-- already used for one-entry-per-pool (see unique_active_user_entry_per_pool,
-- 20260101000009_pools.sql).
alter table public.entries add column tier_group_id uuid;

-- Today's uniqueness (unique_active_user_entry_per_pool) is scoped to one
-- pool_id — nothing stops a player entering both the $10 and $100 tiers of
-- the same matchup, which defeats the point of tiers (one bet, at whichever
-- price point they choose). This mirrors that index exactly, just scoped to
-- the shared tier_group_id instead of a single pool_id. A non-tiered pool's
-- entries never have tier_group_id set, so this index does nothing for
-- them — unique_active_user_entry_per_pool continues doing all the work.
create unique index unique_active_user_entry_per_tier_group
on public.entries (tier_group_id, user_id)
where status in ('ACTIVE', 'WON', 'LOST') and tier_group_id is not null;

-- Rewrites the exception handler: today it assumes any unique_violation on
-- the entries insert came from one of exactly two sources (idempotency_key,
-- or unique_active_user_entry_per_pool) and its fallback silently treats
-- anything unrecognized as "return the existing pool_id+user_id entry" —
-- correct only because there was nothing else it could have been. Adding a
-- third unique index breaks that assumption: a tier-group conflict must
-- raise its own distinct, clear exception (the caller needs to say "you
-- already entered a different tier," not silently be handed back an entry
-- that belongs to a completely different pool_id than the one requested).
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

  if p_amount <> v_pool.entry_fee then
    raise exception 'amount_mismatch';
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

  update public.pool_options
  set entry_count = entry_count + 1, total_entry_amount = total_entry_amount + p_amount
  where id = p_option_id;

  if v_pool.first_entry_at is null then
    update public.pools set first_entry_at = now() where id = p_pool_id;
  end if;

  return v_result;
end;
$$;
