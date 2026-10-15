-- r82 — Milestone 3: Confidence economy foundation.
--
-- Confidence is scarce internal reputation capital a Member puts behind their own prediction. It is its OWN domain: it does not read, write or reference the Member wallet, any monetary table or any
-- payment table, so the monetary P2P system can be removed later without touching it. It cannot be purchased, redeemed or transferred, has no cash value, and has no payment-provider dependency —
-- none of that exists anywhere in this schema (guarded by a static test).
--
--   * confidence_accounts        one row per eligible Member: available, reserved, total (= available + reserved BY CONSTRUCTION), last Daily Claim time.
--   * confidence_ledger_entries  the immutable accounting events. The ledger is canonical; the account row is a cache that can only change as a side effect of a ledger insert, and reconciles against it.
--   * Settings in platform_settings (one source of truth: baseline, Daily Claim amount and interval, the future stake ladder, the capability).
--
-- Nothing here changes any existing behaviour: the capability is OFF, no grant is made while it is OFF, and Picks are untouched. Confidence-backed Picks, Sponsored Confidence and Rewards are later milestones.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Settings (product policy — all changeable without a deploy)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The future stake ladder must be a non-empty, strictly ascending list of positive whole numbers. The only upper limit is the integer type itself; how many choices a selector offers, and how large they are, is product policy.
create or replace function public.confidence_stakes_valid(p_stakes integer[])
returns boolean
language sql
immutable
as $$
  select p_stakes is not null
    and cardinality(p_stakes) >= 1
    and array_ndims(p_stakes) = 1
    and not exists (select 1 from unnest(p_stakes) with ordinality as s(v, i) where s.v is null or s.v < 1)
    and not exists (select 1 from unnest(p_stakes) with ordinality as a(v, i) join unnest(p_stakes) with ordinality as b(v, i) on b.i = a.i + 1 where b.v <= a.v);
$$;

alter table public.platform_settings
  add column confidence_enabled boolean not null default false,
  add column confidence_baseline integer not null default 50 check (confidence_baseline >= 1),
  add column confidence_daily_claim_amount integer not null default 1 check (confidence_daily_claim_amount between 1 and 5),
  add column confidence_daily_claim_interval_hours integer not null default 24 check (confidence_daily_claim_interval_hours >= 1),
  add column confidence_allowed_stakes integer[] not null default '{1,2,3,4,5}' check (public.confidence_stakes_valid(confidence_allowed_stakes)),
  add constraint platform_settings_confidence_claim_within_baseline check (confidence_daily_claim_amount <= confidence_baseline);

comment on column public.platform_settings.confidence_enabled is 'Confidence capability. OFF by default and on any unreadable value (fail closed): Members see nothing, no Daily Claim, no initial grant, no bootstrap. Existing ledger data is preserved while OFF.';
comment on column public.platform_settings.confidence_baseline is 'The initial grant for a new account AND the ceiling for Daily Claims (a Member at or above it cannot claim). Changing it never rewrites existing balances. Default 50.';
comment on column public.platform_settings.confidence_daily_claim_amount is 'Confidence a Daily Claim restores (global, never per Member). Capped at the baseline gap, so a claim can never push a Member above the baseline. Range 1-5, default 1.';
comment on column public.platform_settings.confidence_daily_claim_interval_hours is 'Rolling interval between a Member''s successful Daily Claims, measured from the last successful claim (never a calendar day or timezone). Default 24.';
comment on column public.platform_settings.confidence_allowed_stakes is 'The future Confidence-backed Pick stake ladder (non-empty, strictly ascending, positive). Configured here now so it has one source of truth; nothing reads it until Confidence-backed Picks exist. Default {1,2,3,4,5}.';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Eligibility and the capability flag
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- An eligible Member: a Member account (it has a user_profiles row — a Sponsor login never does) that is active and has not closed its account (user_profiles.account_closed_at is the canonical closure source).
create or replace function public.confidence_member_eligible(p_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.user_profiles where id = p_member_id and is_active is true and account_closed_at is null);
$$;
revoke all on function public.confidence_member_eligible(uuid) from public, anon, authenticated;
grant execute on function public.confidence_member_eligible(uuid) to service_role;

-- Used by the read policies so the database itself fails closed while the capability is OFF. Returns a single boolean and nothing else.
create or replace function public.confidence_enabled_flag()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select confidence_enabled from public.platform_settings where id = true), false);
$$;
revoke all on function public.confidence_enabled_flag() from public, anon;
grant execute on function public.confidence_enabled_flag() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table public.confidence_accounts (
  -- One account per Member. RESTRICT: ledger history must outlive any profile change, so a profile with accounting history can never be hard-deleted.
  member_id uuid primary key references public.user_profiles (id) on delete restrict,
  available bigint not null default 0 check (available >= 0),
  reserved bigint not null default 0 check (reserved >= 0),
  -- The invariant total = available + reserved holds by construction; it cannot drift or be written.
  total bigint generated always as (available + reserved) stored,
  last_daily_claim_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.confidence_accounts is 'Per-Member Confidence balance cache. Balances change ONLY as a side effect of inserting a ledger entry (trigger-enforced); direct writes are refused. Reconciles against confidence_ledger_entries (confidence_reconcile()).';

create table public.confidence_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.user_profiles (id) on delete restrict,
  -- Canonical event types. Later milestones add theirs (prediction reserve/release/win/loss, sponsored and Brohda drops) with their own migration; nothing here implements them.
  entry_type text not null check (entry_type in ('INITIAL_GRANT', 'DAILY_CLAIM', 'ADMIN_ADJUSTMENT', 'REVERSAL')),
  available_delta bigint not null,
  reserved_delta bigint not null default 0,
  -- The balances after this entry, stamped by the trigger that applied it (never supplied by a caller).
  available_after bigint not null default 0 check (available_after >= 0),
  reserved_after bigint not null default 0 check (reserved_after >= 0),
  -- Canonical reason for an admin adjustment; the free-text note is private and bounded.
  reason_code text check (reason_code in ('REMEDIATION', 'CORRECTION', 'SUPPORT_CASE')),
  note text check (note is null or char_length(note) <= 500),
  actor_id uuid references public.user_profiles (id) on delete restrict,
  -- A compensating entry points at the one entry it corrects (and an entry can be reversed at most once).
  reverses_entry_id uuid unique references public.confidence_ledger_entries (id) on delete restrict,
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 100),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and char_length(metadata::text) <= 2000),
  created_at timestamptz not null default now(),
  constraint confidence_entry_no_reservation_yet check (reserved_delta = 0),
  constraint confidence_entry_shape check (
    (entry_type = 'INITIAL_GRANT' and available_delta > 0 and actor_id is null and reason_code is null and reverses_entry_id is null)
    or (entry_type = 'DAILY_CLAIM' and available_delta > 0 and actor_id is null and reason_code is null and reverses_entry_id is null)
    or (entry_type = 'ADMIN_ADJUSTMENT' and available_delta <> 0 and actor_id is not null and reason_code is not null and note is not null and reverses_entry_id is null)
    or (entry_type = 'REVERSAL' and available_delta <> 0 and actor_id is not null and reverses_entry_id is not null and reason_code is null))
);
-- Exactly one initial grant per Member, ever — even if the grant is later reversed.
create unique index confidence_one_initial_grant on public.confidence_ledger_entries (member_id) where entry_type = 'INITIAL_GRANT';
-- A retried request (same key) can never write a second entry.
create unique index confidence_idempotency_unique on public.confidence_ledger_entries (member_id, idempotency_key) where idempotency_key is not null;
-- A Member's history, newest first; and aggregate economy reads by event type.
create index confidence_ledger_member_idx on public.confidence_ledger_entries (member_id, created_at desc);
create index confidence_ledger_type_idx on public.confidence_ledger_entries (entry_type);

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Integrity: the ledger is immutable; balances move only by inserting a ledger entry; nothing can go negative
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.confidence_ledger_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'confidence_ledger_entries is append-only; correct a mistake with a compensating entry';
end;
$$;
create trigger confidence_ledger_no_update before update on public.confidence_ledger_entries for each row execute function public.confidence_ledger_immutable();
create trigger confidence_ledger_no_delete before delete on public.confidence_ledger_entries for each row execute function public.confidence_ledger_immutable();

-- Inserting a ledger entry IS the only way a balance changes. BEFORE the row is written: lock the account, compute the resulting balances, refuse a negative result and stamp them on the row (a caller never supplies
-- them). AFTER it is actually written (so an ON CONFLICT DO NOTHING that skips the row can never move a balance): apply the deltas to the account and record a Daily Claim time.
create or replace function public.confidence_stamp_ledger_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.confidence_accounts;
begin
  select * into v_account from public.confidence_accounts where member_id = new.member_id for update;
  if not found then raise exception 'confidence_account_missing'; end if;
  new.available_after := v_account.available + new.available_delta;
  new.reserved_after := v_account.reserved + new.reserved_delta;
  if new.available_after < 0 or new.reserved_after < 0 then raise exception 'confidence_negative_balance'; end if;
  return new;
end;
$$;
create trigger confidence_stamp_entry before insert on public.confidence_ledger_entries for each row execute function public.confidence_stamp_ledger_entry();

create or replace function public.confidence_apply_ledger_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('brohda.confidence_ledger', 'on', true);
  update public.confidence_accounts
    set available = new.available_after, reserved = new.reserved_after, updated_at = now(),
        last_daily_claim_at = case when new.entry_type = 'DAILY_CLAIM' then new.created_at else last_daily_claim_at end
    where member_id = new.member_id;
  perform set_config('brohda.confidence_ledger', 'off', true);
  return null;
end;
$$;
create trigger confidence_apply_entry after insert on public.confidence_ledger_entries for each row execute function public.confidence_apply_ledger_entry();

-- A balance cannot be written directly by anyone (including the service role): an account starts empty and changes only through the ledger trigger above.
create or replace function public.confidence_accounts_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.available <> 0 or new.reserved <> 0 or new.last_daily_claim_at is not null then raise exception 'a Confidence account starts empty; balances come only from the ledger'; end if;
  elsif current_setting('brohda.confidence_ledger', true) is distinct from 'on' then
    raise exception 'Confidence balances change only through the ledger';
  end if;
  return new;
end;
$$;
create trigger confidence_accounts_guard_insert before insert on public.confidence_accounts for each row execute function public.confidence_accounts_guard();
create trigger confidence_accounts_guard_update before update on public.confidence_accounts for each row execute function public.confidence_accounts_guard();

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Access: Members read only their own, through RLS; every write is a service-role function
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.confidence_accounts enable row level security;
alter table public.confidence_ledger_entries enable row level security;
revoke all on public.confidence_accounts, public.confidence_ledger_entries from public, anon, authenticated;
grant all on public.confidence_accounts, public.confidence_ledger_entries to service_role;
-- A Member may read their own account and the NON-sensitive columns of their own history. The admin note, the actor, the reason code, the metadata and the reversal link are never granted to Members.
grant select on public.confidence_accounts to authenticated;
grant select (id, member_id, entry_type, available_delta, reserved_delta, available_after, reserved_after, created_at) on public.confidence_ledger_entries to authenticated;
create policy "members_read_own_confidence_account" on public.confidence_accounts for select to authenticated using (member_id = auth.uid() and public.confidence_enabled_flag());
create policy "members_read_own_confidence_history" on public.confidence_ledger_entries for select to authenticated using (member_id = auth.uid() and public.confidence_enabled_flag());

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Bootstrap and the initial grant: exactly once, race-safe, idempotent
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.confidence_bootstrap_member(p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_created integer := 0;
  v_granted integer := 0;
begin
  select * into v_s from public.platform_settings where id = true;
  if v_s.confidence_enabled is not true then return jsonb_build_object('outcome', 'disabled'); end if;
  if not public.confidence_member_eligible(p_member_id) then return jsonb_build_object('outcome', 'ineligible'); end if;
  -- Serialise concurrent bootstraps of the same Member (login, backfill job and signup can all arrive together).
  perform pg_advisory_xact_lock(hashtextextended('confidence:bootstrap:' || p_member_id::text, 0));
  insert into public.confidence_accounts (member_id) values (p_member_id) on conflict (member_id) do nothing;
  get diagnostics v_created = row_count;
  -- The unique index on (member, INITIAL_GRANT) is the final word: a second grant is impossible however this is reached.
  insert into public.confidence_ledger_entries (member_id, entry_type, available_delta, idempotency_key, metadata)
    values (p_member_id, 'INITIAL_GRANT', v_s.confidence_baseline, 'initial-grant-' || p_member_id::text, jsonb_build_object('baseline', v_s.confidence_baseline))
    on conflict do nothing;
  get diagnostics v_granted = row_count;
  return jsonb_build_object('outcome', case when v_granted > 0 then 'granted' else 'exists' end, 'accountCreated', v_created > 0);
end;
$$;
revoke all on function public.confidence_bootstrap_member(uuid) from public, anon, authenticated;
grant execute on function public.confidence_bootstrap_member(uuid) to service_role;

-- The bounded, observable backfill for existing Members (and anyone who joined while the capability was OFF): at most p_limit Members per call, oldest first. Run by the housekeeping cron; a no-op while OFF.
create or replace function public.confidence_bootstrap_batch(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_id uuid;
  v_done integer := 0;
  v_remaining integer;
begin
  select * into v_s from public.platform_settings where id = true;
  if v_s.confidence_enabled is not true then return jsonb_build_object('enabled', false); end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 then p_limit := 200; end if;
  for v_id in
    select p.id from public.user_profiles p
      where p.is_active is true and p.account_closed_at is null and not exists (select 1 from public.confidence_accounts a where a.member_id = p.id)
      order by p.created_at, p.id limit p_limit
  loop
    perform public.confidence_bootstrap_member(v_id);
    v_done := v_done + 1;
  end loop;
  select count(*) into v_remaining from public.user_profiles p
    where p.is_active is true and p.account_closed_at is null and not exists (select 1 from public.confidence_accounts a where a.member_id = p.id);
  return jsonb_build_object('enabled', true, 'processed', v_done, 'remaining', v_remaining);
end;
$$;
revoke all on function public.confidence_bootstrap_batch(integer) from public, anon, authenticated;
grant execute on function public.confidence_bootstrap_batch(integer) to service_role;

-- New Members get their account and grant automatically, the same way every profile already gets its other rows — but only while the capability is ON (OFF means no side effect at all), and a failure here
-- can never break signup (the housekeeping backfill and the first visit both catch up).
create or replace function public.confidence_bootstrap_new_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.confidence_bootstrap_member(new.id);
  exception when others then
    raise warning 'confidence bootstrap failed for a new profile: %', sqlstate;
  end;
  return null;
end;
$$;
create trigger user_profiles_confidence_bootstrap after insert on public.user_profiles for each row execute function public.confidence_bootstrap_new_profile();

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Daily Claim: an active action, rolling interval, only below the baseline, never above it, never banked
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The server derives p_member_id from the authenticated session (never from the client); this function is service-role only.
create or replace function public.confidence_daily_claim(p_member_id uuid, p_idempotency_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_account public.confidence_accounts;
  v_prior public.confidence_ledger_entries;
  v_amount integer;
  v_next timestamptz;
  v_entry public.confidence_ledger_entries;
begin
  select * into v_s from public.platform_settings where id = true;
  if v_s.confidence_enabled is not true then return jsonb_build_object('outcome', 'disabled'); end if;
  if not public.confidence_member_eligible(p_member_id) then return jsonb_build_object('outcome', 'ineligible'); end if;
  if p_idempotency_key is not null and char_length(p_idempotency_key) not between 8 and 100 then raise exception 'invalid_idempotency_key'; end if;

  -- Make sure the account exists (idempotent), then serialise this Member's claims on their account row.
  perform public.confidence_bootstrap_member(p_member_id);
  select * into v_account from public.confidence_accounts where member_id = p_member_id for update;
  if not found then return jsonb_build_object('outcome', 'ineligible'); end if;

  -- A retry of the SAME request returns what the first one did, without a second entry.
  if p_idempotency_key is not null then
    select * into v_prior from public.confidence_ledger_entries where member_id = p_member_id and idempotency_key = p_idempotency_key;
    if found then return jsonb_build_object('outcome', 'claimed', 'replay', true, 'amount', v_prior.available_delta, 'available', v_prior.available_after, 'total', v_prior.available_after + v_prior.reserved_after); end if;
  end if;

  if v_account.available >= v_s.confidence_baseline then
    return jsonb_build_object('outcome', 'at_or_above_baseline', 'available', v_account.available);
  end if;
  if v_account.last_daily_claim_at is not null then
    v_next := v_account.last_daily_claim_at + make_interval(hours => v_s.confidence_daily_claim_interval_hours);
    if now() < v_next then return jsonb_build_object('outcome', 'too_soon', 'nextAvailableAt', v_next, 'available', v_account.available); end if;
  end if;

  -- Never past the baseline: the claim is capped at the gap.
  v_amount := least(v_s.confidence_daily_claim_amount, (v_s.confidence_baseline - v_account.available)::integer);
  insert into public.confidence_ledger_entries (member_id, entry_type, available_delta, idempotency_key, metadata)
    values (p_member_id, 'DAILY_CLAIM', v_amount, p_idempotency_key, jsonb_build_object('baseline', v_s.confidence_baseline, 'intervalHours', v_s.confidence_daily_claim_interval_hours))
    returning * into v_entry;
  return jsonb_build_object('outcome', 'claimed', 'amount', v_amount, 'available', v_entry.available_after, 'total', v_entry.available_after + v_entry.reserved_after,
    'nextAvailableAt', v_entry.created_at + make_interval(hours => v_s.confidence_daily_claim_interval_hours));
end;
$$;
revoke all on function public.confidence_daily_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.confidence_daily_claim(uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Super Admin: adjustments and reversals are compensating ledger entries; history is never overwritten
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_confidence_adjust(p_admin_id uuid, p_member_id uuid, p_amount bigint, p_reason_code text, p_note text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note text;
  v_prior public.confidence_ledger_entries;
  v_entry public.confidence_ledger_entries;
begin
  perform public.require_super_admin(p_admin_id);
  if p_reason_code not in ('REMEDIATION', 'CORRECTION', 'SUPPORT_CASE') then raise exception 'invalid_reason'; end if;
  if p_amount is null or p_amount = 0 then return jsonb_build_object('outcome', 'invalid_amount'); end if;
  v_note := nullif(btrim(regexp_replace(left(coalesce(p_note, ''), 500), '[\r\n\t]+', ' ', 'g')), '');
  if v_note is null or char_length(v_note) < 3 then return jsonb_build_object('outcome', 'note_required'); end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 100 then raise exception 'invalid_idempotency_key'; end if;
  if not exists (select 1 from public.confidence_accounts where member_id = p_member_id) then return jsonb_build_object('outcome', 'no_account'); end if;
  select * into v_prior from public.confidence_ledger_entries where member_id = p_member_id and idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('outcome', 'adjusted', 'replay', true, 'entryId', v_prior.id, 'available', v_prior.available_after); end if;
  begin
    insert into public.confidence_ledger_entries (member_id, entry_type, available_delta, reason_code, note, actor_id, idempotency_key)
      values (p_member_id, 'ADMIN_ADJUSTMENT', p_amount, p_reason_code, v_note, p_admin_id, p_idempotency_key) returning * into v_entry;
  exception when others then
    if sqlerrm = 'confidence_negative_balance' then return jsonb_build_object('outcome', 'would_go_negative'); end if;
    -- A change too large for the 64-bit balance is not a representable amount.
    if sqlstate = '22003' then return jsonb_build_object('outcome', 'invalid_amount'); end if;
    raise;
  end;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, reason, after)
    values (p_admin_id, 'confidence.adjusted', 'member', p_member_id::text, v_note, jsonb_build_object('entryId', v_entry.id, 'amount', p_amount, 'reasonCode', p_reason_code, 'available', v_entry.available_after));
  return jsonb_build_object('outcome', 'adjusted', 'entryId', v_entry.id, 'available', v_entry.available_after);
end;
$$;
revoke all on function public.admin_confidence_adjust(uuid, uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_confidence_adjust(uuid, uuid, bigint, text, text, text) to service_role;

create or replace function public.admin_confidence_reverse(p_admin_id uuid, p_entry_id uuid, p_note text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note text;
  v_orig public.confidence_ledger_entries;
  v_prior public.confidence_ledger_entries;
  v_entry public.confidence_ledger_entries;
begin
  perform public.require_super_admin(p_admin_id);
  v_note := nullif(btrim(regexp_replace(left(coalesce(p_note, ''), 500), '[\r\n\t]+', ' ', 'g')), '');
  if v_note is null or char_length(v_note) < 3 then return jsonb_build_object('outcome', 'note_required'); end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 100 then raise exception 'invalid_idempotency_key'; end if;
  select * into v_orig from public.confidence_ledger_entries where id = p_entry_id;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_orig.entry_type = 'REVERSAL' then return jsonb_build_object('outcome', 'cannot_reverse_a_reversal'); end if;
  select * into v_prior from public.confidence_ledger_entries where member_id = v_orig.member_id and idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('outcome', 'reversed', 'replay', true, 'entryId', v_prior.id, 'available', v_prior.available_after); end if;
  if exists (select 1 from public.confidence_ledger_entries where reverses_entry_id = p_entry_id) then return jsonb_build_object('outcome', 'already_reversed'); end if;
  begin
    insert into public.confidence_ledger_entries (member_id, entry_type, available_delta, reserved_delta, note, actor_id, reverses_entry_id, idempotency_key)
      values (v_orig.member_id, 'REVERSAL', -v_orig.available_delta, -v_orig.reserved_delta, v_note, p_admin_id, p_entry_id, p_idempotency_key) returning * into v_entry;
  exception when others then
    if sqlerrm = 'confidence_negative_balance' then return jsonb_build_object('outcome', 'would_go_negative'); end if;
    if sqlstate = '23505' then return jsonb_build_object('outcome', 'already_reversed'); end if;
    raise;
  end;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, reason, after)
    values (p_admin_id, 'confidence.reversed', 'member', v_orig.member_id::text, v_note, jsonb_build_object('entryId', v_entry.id, 'reverses', p_entry_id, 'amount', v_entry.available_delta, 'available', v_entry.available_after));
  return jsonb_build_object('outcome', 'reversed', 'entryId', v_entry.id, 'available', v_entry.available_after);
end;
$$;
revoke all on function public.admin_confidence_reverse(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_confidence_reverse(uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Super Admin: the audited settings function. Every change is validated TOGETHER (the table constraints are the authority) and applied or refused as a whole; changing the baseline never rewrites a balance.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_set_confidence_config(p_admin_id uuid, p_config jsonb)
returns public.platform_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.platform_settings;
  v_after public.platform_settings;
  v_key text;
  v_b jsonb;
  v_a jsonb;
  v_stakes integer[];
  v_allowed text[] := array['confidence_enabled', 'confidence_baseline', 'confidence_daily_claim_amount', 'confidence_daily_claim_interval_hours', 'confidence_allowed_stakes'];
begin
  perform public.require_super_admin(p_admin_id);
  if p_config is null or jsonb_typeof(p_config) <> 'object' then raise exception 'invalid_config'; end if;
  for v_key in select jsonb_object_keys(p_config) loop
    if not (v_key = any (v_allowed)) then raise exception 'unknown_setting_%', v_key; end if;
  end loop;
  if p_config ? 'confidence_allowed_stakes' then
    if jsonb_typeof(p_config -> 'confidence_allowed_stakes') <> 'array' then raise exception 'invalid_stakes'; end if;
    select array_agg(x.value::integer order by x.ord) into v_stakes from jsonb_array_elements_text(p_config -> 'confidence_allowed_stakes') with ordinality as x(value, ord);
    -- An empty list yields no array at all; it must be refused, never silently ignored.
    if v_stakes is null then raise exception 'invalid_stakes'; end if;
  end if;
  select * into v_before from public.platform_settings where id = true for update;
  update public.platform_settings set
    confidence_enabled = coalesce((p_config ->> 'confidence_enabled')::boolean, confidence_enabled),
    confidence_baseline = coalesce((p_config ->> 'confidence_baseline')::integer, confidence_baseline),
    confidence_daily_claim_amount = coalesce((p_config ->> 'confidence_daily_claim_amount')::integer, confidence_daily_claim_amount),
    confidence_daily_claim_interval_hours = coalesce((p_config ->> 'confidence_daily_claim_interval_hours')::integer, confidence_daily_claim_interval_hours),
    confidence_allowed_stakes = coalesce(v_stakes, confidence_allowed_stakes),
    updated_at = now(), updated_by = p_admin_id
    where id = true returning * into v_after;
  v_b := (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(v_before)) where key like 'confidence\_%');
  v_a := (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(v_after)) where key like 'confidence\_%');
  if v_b is distinct from v_a then
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after) values (p_admin_id, 'settings.confidence_updated', 'platform_settings', null, v_b, v_a);
  end if;
  return v_after;
end;
$$;
revoke all on function public.admin_set_confidence_config(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_set_confidence_config(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Reconciliation and economy observability (aggregate only — never a Member's private history)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Accounts whose cached balance disagrees with the sum of their ledger entries. Must always be zero rows.
create or replace function public.confidence_reconcile()
returns table (member_id uuid, available bigint, ledger_available bigint, reserved bigint, ledger_reserved bigint)
language sql
stable
security definer
set search_path = public
as $$
  select a.member_id, a.available, coalesce(l.av, 0), a.reserved, coalesce(l.rs, 0)
  from public.confidence_accounts a
  left join (select e.member_id, sum(e.available_delta) av, sum(e.reserved_delta) rs from public.confidence_ledger_entries e group by e.member_id) l on l.member_id = a.member_id
  where a.available <> coalesce(l.av, 0) or a.reserved <> coalesce(l.rs, 0);
$$;
revoke all on function public.confidence_reconcile() from public, anon, authenticated;
grant execute on function public.confidence_reconcile() to service_role;

create or replace function public.confidence_economy_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_baseline integer;
  v_result jsonb;
begin
  select confidence_baseline into v_baseline from public.platform_settings where id = true;
  select jsonb_build_object(
    'accounts', count(*),
    'totalConfidence', coalesce(sum(total), 0),
    'available', coalesce(sum(available), 0),
    'reserved', coalesce(sum(reserved), 0),
    'average', round(avg(total)::numeric, 2),
    'median', percentile_cont(0.5) within group (order by total),
    'distribution', jsonb_build_object('min', min(total), 'p10', percentile_cont(0.1) within group (order by total), 'p25', percentile_cont(0.25) within group (order by total),
      'p50', percentile_cont(0.5) within group (order by total), 'p75', percentile_cont(0.75) within group (order by total), 'p90', percentile_cont(0.9) within group (order by total), 'max', max(total)),
    'belowBaseline', count(*) filter (where available < v_baseline),
    'atBaseline', count(*) filter (where available = v_baseline),
    'aboveBaseline', count(*) filter (where available > v_baseline),
    'baseline', v_baseline) into v_result from public.confidence_accounts;
  return v_result || jsonb_build_object(
    'eligibleMembers', (select count(*) from public.user_profiles where is_active is true and account_closed_at is null),
    'initialGrants', (select jsonb_build_object('count', count(*), 'total', coalesce(sum(available_delta), 0)) from public.confidence_ledger_entries where entry_type = 'INITIAL_GRANT'),
    'dailyClaims', (select jsonb_build_object('count', count(*), 'total', coalesce(sum(available_delta), 0)) from public.confidence_ledger_entries where entry_type = 'DAILY_CLAIM'),
    'adminAdjustments', (select jsonb_build_object('count', count(*), 'net', coalesce(sum(available_delta), 0)) from public.confidence_ledger_entries where entry_type = 'ADMIN_ADJUSTMENT'),
    'reversals', (select jsonb_build_object('count', count(*), 'net', coalesce(sum(available_delta), 0)) from public.confidence_ledger_entries where entry_type = 'REVERSAL'),
    'reconciliationMismatches', (select count(*) from public.confidence_reconcile()));
end;
$$;
revoke all on function public.confidence_economy_overview() from public, anon, authenticated;
grant execute on function public.confidence_economy_overview() to service_role;
