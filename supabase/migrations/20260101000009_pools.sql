-- Phase 4: pools, pool_options, entries (spec §10-§13, §18, §21, X.5/X.9/X.15)

create type public.pool_type as enum ('WHO_WILL_ADVANCE', 'REGULATION_RESULT');

-- Full 11-value set reserved now (only DRAFT/SCHEDULED/OPEN/LOCKED/CANCELLED
-- are reachable until Phase 5 settlement/reversal land) — avoids ALTER TYPE.
create type public.pool_status as enum (
  'DRAFT',
  'SCHEDULED',
  'OPEN',
  'LOCKED',
  'AWAITING_RESULT',
  'READY_FOR_REVIEW',
  'SETTLED',
  'VOIDED',
  'CANCELLED',
  'SETTLEMENT_REVERSED',
  'REVERSAL_FAILED_MANUAL_REVIEW'
);

create type public.pool_visibility as enum ('VISIBLE_TO_ALL_MEMBERS', 'HIDDEN');

create type public.participation_visibility as enum (
  'SHOW_BEFORE_ENTRY',
  'SHOW_AFTER_ENTRY',
  'SHOW_AFTER_LOCK',
  'NEVER_SHOW'
);

create type public.entry_status as enum ('ACTIVE', 'WON', 'LOST', 'VOID', 'REFUNDED');

create table public.pools (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references public.fixtures (id),
  created_by uuid not null references public.user_profiles (id),
  pool_type public.pool_type not null,
  question text not null,
  entry_fee bigint not null check (entry_fee > 0),
  house_fee_bps integer not null default 0 check (house_fee_bps >= 0 and house_fee_bps <= 10000),
  -- Reserved per Decision 5: never exposed in the admin UI, forced to 1
  -- server-side. The unique index on entries is the real enforcement.
  max_entries_per_user integer not null default 1,
  min_total_entries integer not null default 2,
  visibility public.pool_visibility not null default 'VISIBLE_TO_ALL_MEMBERS',
  participation_visibility public.participation_visibility not null default 'SHOW_AFTER_ENTRY',
  open_at timestamptz not null,
  locks_at timestamptz not null,
  status public.pool_status not null default 'DRAFT',
  first_entry_at timestamptz,
  -- Reserved for Phase 5's optimistic-concurrency settlement review.
  snapshot_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_pools_status on public.pools (status);
create index idx_pools_fixture on public.pools (fixture_id);
create index idx_pools_locks_at on public.pools (locks_at);

create trigger pools_set_updated_at
before update on public.pools
for each row execute function public.set_updated_at();

-- Fee/question/type freeze once the first entry lands (spec §11.3), and
-- lock time may only move earlier afterward. App-layer server actions
-- check this too — this trigger is the non-negotiable backstop.
create or replace function public.enforce_pool_fee_immutability()
returns trigger
language plpgsql
as $$
begin
  if old.first_entry_at is not null then
    if new.entry_fee <> old.entry_fee
      or new.house_fee_bps <> old.house_fee_bps
      or new.question <> old.question
      or new.pool_type <> old.pool_type
    then
      raise exception 'pool fields are frozen after the first entry';
    end if;

    if new.locks_at > old.locks_at then
      raise exception 'lock time may only move earlier after the first entry';
    end if;
  end if;

  return new;
end;
$$;

create trigger pools_enforce_fee_immutability
before update on public.pools
for each row execute function public.enforce_pool_fee_immutability();

create table public.pool_options (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools (id),
  label text not null,
  external_team_id text,
  team_name text,
  logo_url text,
  sort_order integer not null default 0,
  is_winning_option boolean not null default false,
  entry_count integer not null default 0,
  total_entry_amount bigint not null default 0,
  created_at timestamptz not null default now()
);

create index idx_pool_options_pool on public.pool_options (pool_id);

create table public.entries (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools (id),
  user_id uuid not null references public.user_profiles (id),
  option_id uuid not null references public.pool_options (id),
  amount bigint not null check (amount > 0),
  status public.entry_status not null default 'ACTIVE',
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_entries_pool on public.entries (pool_id);
create index idx_entries_user on public.entries (user_id, created_at desc);

-- The final arbiter of "one entry per user per pool" (spec §18, verbatim).
-- VOID/REFUNDED rows don't block a fresh entry.
create unique index unique_active_user_entry_per_pool
on public.entries (pool_id, user_id)
where status in ('ACTIVE', 'WON', 'LOST');

create trigger entries_set_updated_at
before update on public.entries
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Privacy helpers (spec X.9/X.15): enforced at the query/RLS layer, not
-- the response mapper.
-- ---------------------------------------------------------------------

create or replace function public.user_has_entered_pool(p_pool_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.entries
    where pool_id = p_pool_id and user_id = p_user_id and status in ('ACTIVE', 'WON', 'LOST')
  );
$$;

revoke all on function public.user_has_entered_pool(uuid, uuid) from public;
grant execute on function public.user_has_entered_pool(uuid, uuid) to authenticated, service_role;

create or replace function public.can_view_pool_distribution(p_pool_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_pool public.pools;
begin
  select * into v_pool from public.pools where id = p_pool_id;
  if not found then
    return false;
  end if;

  return case v_pool.participation_visibility
    when 'SHOW_BEFORE_ENTRY' then true
    when 'SHOW_AFTER_ENTRY' then public.user_has_entered_pool(p_pool_id, auth.uid())
    when 'SHOW_AFTER_LOCK' then v_pool.status not in ('DRAFT', 'SCHEDULED', 'OPEN')
    else false -- NEVER_SHOW
  end;
end;
$$;

revoke all on function public.can_view_pool_distribution(uuid) from public;
grant execute on function public.can_view_pool_distribution(uuid) to authenticated, service_role;

-- Social proof (X.5.6): who's playing, never what they picked. Safe to
-- expose regardless of participation_visibility since option_id never
-- leaves this function.
create or replace function public.get_pool_participants(p_pool_id uuid)
returns table (user_id uuid, display_name text, avatar_url text)
language sql
security definer
set search_path = public
stable
as $$
  select up.id, up.display_name, up.avatar_url
  from public.entries e
  join public.user_profiles up on up.id = e.user_id
  where e.pool_id = p_pool_id and e.status in ('ACTIVE', 'WON', 'LOST')
  order by e.created_at asc;
$$;

revoke all on function public.get_pool_participants(uuid) from public;
grant execute on function public.get_pool_participants(uuid) to authenticated, service_role;

-- Pool-wide totals (spec §14's "total entries, gross pool" pre-selection
-- info) are always visible — participation_visibility gates the PER-OPTION
-- breakdown (X.5.6: "hide per-option entry totals... which option is
-- leading"), not the undifferentiated sum, which reveals nothing about any
-- single option.
create or replace function public.get_pool_totals(p_pool_id uuid)
returns table (total_entries integer, gross_pool bigint)
language sql
security definer
set search_path = public
stable
as $$
  select
    coalesce(sum(entry_count), 0)::integer,
    coalesce(sum(total_entry_amount), 0)::bigint
  from public.pool_options
  where pool_id = p_pool_id;
$$;

revoke all on function public.get_pool_totals(uuid) from public;
grant execute on function public.get_pool_totals(uuid) to authenticated, service_role;

-- pool_options itself is service-role only; authenticated reads through
-- this view, which nulls the aggregate columns per can_view_pool_distribution
-- and excludes DRAFT pools (owned by the migration role, so it bypasses RLS
-- like public_profiles — the WHERE clause here is the actual gate).
create view public.pool_options_public as
select
  po.id,
  po.pool_id,
  po.label,
  po.external_team_id,
  po.team_name,
  po.logo_url,
  po.sort_order,
  po.is_winning_option,
  po.created_at,
  case when public.can_view_pool_distribution(po.pool_id) then po.entry_count else null end
    as entry_count,
  case when public.can_view_pool_distribution(po.pool_id) then po.total_entry_amount else null end
    as total_entry_amount
from public.pool_options po
join public.pools p on p.id = po.pool_id
where p.status != 'DRAFT' or public.is_super_admin(auth.uid());

grant select on public.pool_options_public to authenticated;

-- ---------------------------------------------------------------------
-- The atomic entry transaction (spec §13.3, step for step).
-- ---------------------------------------------------------------------

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
begin
  select * into v_existing from public.entries where idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  select * into v_user from public.user_profiles where id = p_user_id;
  if not found or not v_user.is_active then
    raise exception 'user_inactive';
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
    insert into public.entries (pool_id, user_id, option_id, amount, status, idempotency_key)
    values (p_pool_id, p_user_id, p_option_id, p_amount, 'ACTIVE', p_idempotency_key)
    returning * into v_result;
  exception when unique_violation then
    -- Either the idempotency key raced, or the one-entry-per-pool index
    -- fired — either way, the spec wants an idempotent success returning
    -- the user's existing entry, not an error.
    select * into v_existing from public.entries where idempotency_key = p_idempotency_key;
    if found then
      return v_existing;
    end if;

    select * into v_existing from public.entries
      where pool_id = p_pool_id and user_id = p_user_id and status in ('ACTIVE', 'WON', 'LOST');
    return v_existing;
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

revoke all on function public.create_pool_entry(uuid, uuid, uuid, bigint, text) from public;
grant execute on function public.create_pool_entry(uuid, uuid, uuid, bigint, text) to service_role;

-- Admin entry void (spec §13.5): mark VOID, decrement aggregates, refund.
create or replace function public.void_pool_entry(
  p_entry_id uuid,
  p_admin_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns public.entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.entries;
  v_pool public.pools;
  v_result public.entries;
begin
  select * into v_entry from public.entries where id = p_entry_id for update;
  if not found then
    raise exception 'entry_not_found';
  end if;
  if v_entry.status <> 'ACTIVE' then
    raise exception 'entry_not_active';
  end if;

  select * into v_pool from public.pools where id = v_entry.pool_id for update;
  if v_pool.status <> 'OPEN' then
    raise exception 'pool_not_open';
  end if;

  update public.entries
  set status = 'VOID'
  where id = p_entry_id
  returning * into v_result;

  update public.pool_options
  set entry_count = entry_count - 1, total_entry_amount = total_entry_amount - v_entry.amount
  where id = v_entry.option_id;

  perform public.apply_wallet_transaction(
    'user'::public.wallet_account_type,
    v_entry.user_id,
    'pool_refund_credit'::public.wallet_transaction_type,
    'credit'::public.wallet_direction,
    v_entry.amount,
    p_admin_id,
    p_reason,
    p_idempotency_key,
    v_pool.id,
    v_entry.id,
    null
  );

  return v_result;
end;
$$;

revoke all on function public.void_pool_entry(uuid, uuid, text, text) from public;
grant execute on function public.void_pool_entry(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------

alter table public.pools enable row level security;
alter table public.pool_options enable row level security;
alter table public.entries enable row level security;

create policy "members_can_read_published_pools"
on public.pools for select
to authenticated
using (status != 'DRAFT');

create policy "admins_can_read_all_pools"
on public.pools for select
to authenticated
using (public.is_super_admin(auth.uid()));

grant select on public.pools to authenticated;
grant select, insert, update, delete on public.pools to service_role;

-- pool_options itself is never read directly by authenticated clients —
-- only through pool_options_public above.
grant select, insert, update, delete on public.pool_options to service_role;

create policy "users_can_read_own_entries"
on public.entries for select
to authenticated
using (user_id = auth.uid());

create policy "admins_can_read_all_entries"
on public.entries for select
to authenticated
using (public.is_super_admin(auth.uid()));

grant select on public.entries to authenticated;
grant select, insert, update, delete on public.entries to service_role;
