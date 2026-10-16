-- r84 — Milestone 4: Confidence-backed Picks.
--
-- A Member may optionally put Confidence behind their OWN Pick before the Pick deadline. The Pick stays the one canonical opinion object; the stake is an optional record bound to it. Attaching Confidence is
-- explicit, atomic with locking the Pick, and settles automatically from the existing canonical grading result: correct = the reserved stake comes back plus the same amount newly issued (net +N), incorrect =
-- the reserved stake is consumed (net -N), void = the reserved stake is released (net 0). No odds, no fees, no money, no payment path. Call BS has no Confidence economics.
--
-- Additive only: nothing here changes an unstaked Pick, grading, sentiment or accuracy. The new capability ships OFF.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Settings: the new capability (separate from confidence_enabled) and the configurable settlement wording
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.platform_settings
  add column confidence_backed_picks_enabled boolean not null default false,
  add column confidence_notify_correct text not null default '+{{amount}}🔥 Confidence.' check (char_length(confidence_notify_correct) between 1 and 200),
  add column confidence_notify_incorrect text not null default '−{{amount}}🔥 Confidence.' check (char_length(confidence_notify_incorrect) between 1 and 200),
  add column confidence_notify_void text not null default 'Your {{amount}} Confidence was returned.' check (char_length(confidence_notify_void) between 1 and 200);

comment on column public.platform_settings.confidence_backed_picks_enabled is 'Whether Members can put NEW Confidence behind a Pick. OFF by default. Requires confidence_enabled. Turning it OFF never strands an existing reserved stake: reserved stakes still settle from grading.';
comment on column public.platform_settings.confidence_notify_correct is 'Sentence appended to the Pick-graded notification when the Pick was backed by Confidence and was correct. {{amount}} is replaced by the committed amount.';
comment on column public.platform_settings.confidence_notify_incorrect is 'Sentence appended to the Pick-graded notification when a Confidence-backed Pick was incorrect. {{amount}} is replaced by the committed amount.';
comment on column public.platform_settings.confidence_notify_void is 'Sentence appended to the Pick-graded notification when a Confidence-backed Pick was void. {{amount}} is replaced by the committed amount.';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The one canonical Pick timing rule, shared by set_pick and the Confidence attach
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The Game's status, its kickoff, and the instant ordinary Pick creation/editing stops (kickoff minus platform_settings.pick_lock_minutes_before_kickoff). set_pick used to compute this inline; it now calls this,
-- and Confidence-backed Picks call it too, so the rule exists exactly once.
create or replace function public.pick_market_timing(p_market_id uuid)
returns table (fixture_status public.fixture_internal_status, scheduled_start timestamptz, effective_lock_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select f.internal_status, f.scheduled_start_utc,
         f.scheduled_start_utc - (coalesce((select pick_lock_minutes_before_kickoff from public.platform_settings where id = true), 10) || ' minutes')::interval
  from public.markets m
  join public.fixtures f on f.id = m.fixture_id
  where m.id = p_market_id;
$$;
revoke all on function public.pick_market_timing(uuid) from public, anon, authenticated;
grant execute on function public.pick_market_timing(uuid) to service_role;

create or replace function public.set_pick(p_user_id uuid, p_market_id uuid, p_selected_outcome text, p_yes_probability numeric, p_no_probability numeric, p_market_question text, p_market_close_at timestamp with time zone, p_market_status text, p_idempotency_key text)
returns set_pick_result
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_replay public.predictions;
  v_existing public.predictions;
  v_fixture_status public.fixture_internal_status;
  v_scheduled_start timestamptz;
  v_effective_lock_at timestamptz;
  v_result public.predictions;
begin
  if p_selected_outcome not in ('YES', 'NO') then
    raise exception 'invalid_selected_outcome';
  end if;

  select * into v_replay from public.predictions where idempotency_key = p_idempotency_key;
  if found then
    return (v_replay, 'replayed')::public.set_pick_result;
  end if;

  -- Authoritative, live, in-transaction eligibility from the canonical Game, through the one shared timing rule.
  select t.fixture_status, t.scheduled_start, t.effective_lock_at
    into v_fixture_status, v_scheduled_start, v_effective_lock_at
    from public.pick_market_timing(p_market_id) t;

  if not found then
    raise exception 'market_not_found';
  end if;

  select * into v_existing from public.predictions where user_id = p_user_id and market_id = p_market_id for update;

  if not found then
    if v_fixture_status <> 'NOT_STARTED' then
      return (null, 'rejected_game_closed')::public.set_pick_result;
    end if;
    if now() >= v_effective_lock_at then
      return (null, 'rejected_cutoff')::public.set_pick_result;
    end if;

    begin
      insert into public.predictions (
        user_id, market_id, selected_outcome, yes_probability_snapshot, no_probability_snapshot,
        market_question_snapshot, market_close_at_snapshot, market_status_snapshot, idempotency_key
      ) values (
        p_user_id, p_market_id, p_selected_outcome, p_yes_probability, p_no_probability,
        p_market_question, p_market_close_at, p_market_status, p_idempotency_key
      )
      returning * into v_result;
      return (v_result, 'created')::public.set_pick_result;
    exception when unique_violation then
      return public.set_pick(p_user_id, p_market_id, p_selected_outcome, p_yes_probability, p_no_probability, p_market_question, p_market_close_at, p_market_status, p_idempotency_key);
    end;
  end if;

  -- An existing Pick that is already permanently locked (for ANY reason, Confidence included) or graded never becomes editable again.
  if v_existing.locked_at is not null or v_existing.lifecycle_state = 'GRADED' then
    return (v_existing, 'rejected_locked')::public.set_pick_result;
  end if;

  if now() >= v_effective_lock_at or v_fixture_status <> 'NOT_STARTED' then
    update public.predictions set locked_at = least(now(), v_effective_lock_at), lock_reason = 'CUTOFF', updated_at = now()
    where id = v_existing.id
    returning * into v_result;
    return (v_result, 'rejected_cutoff')::public.set_pick_result;
  end if;

  if v_existing.selected_outcome = p_selected_outcome then
    return (v_existing, 'unchanged')::public.set_pick_result;
  end if;

  insert into public.prediction_revisions (
    prediction_id, user_id, previous_selected_outcome, previous_probability_snapshot, new_selected_outcome, new_probability_snapshot
  ) values (
    v_existing.id, p_user_id, v_existing.selected_outcome,
    case when v_existing.selected_outcome = 'YES' then v_existing.yes_probability_snapshot else v_existing.no_probability_snapshot end,
    p_selected_outcome,
    case when p_selected_outcome = 'YES' then p_yes_probability else p_no_probability end
  );

  update public.predictions set
    selected_outcome = p_selected_outcome,
    yes_probability_snapshot = p_yes_probability,
    no_probability_snapshot = p_no_probability,
    market_question_snapshot = p_market_question,
    market_close_at_snapshot = p_market_close_at,
    market_status_snapshot = p_market_status,
    updated_at = now()
  where id = v_existing.id
  returning * into v_result;

  return (v_result, 'updated')::public.set_pick_result;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Pick lock reasons: a Confidence commitment is one more reason a Pick is immutable — it never overwrites another
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.predictions drop constraint predictions_lock_reason_check;
alter table public.predictions add constraint predictions_lock_reason_check
  check (lock_reason in ('CUTOFF', 'CHALLENGE_ACCEPTED', 'MONETARY_POSITION_ACCEPTED', 'CONFIDENCE_COMMITTED'));

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The stake: the minimum record binding a Member, a Pick, a Market and a Game to a committed amount
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table public.confidence_prediction_stakes (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.user_profiles (id) on delete restrict,
  -- At most ONE stake per Pick, ever (a second 🔥3 can never stack on a first to make 🔥6).
  prediction_id uuid not null unique references public.predictions (id) on delete restrict,
  -- Soft references, like predictions.market_id: snapshots of what the Pick was on when it was backed.
  market_id uuid not null,
  fixture_id uuid not null,
  selected_outcome text not null check (selected_outcome in ('YES', 'NO')),
  amount integer not null check (amount > 0),
  -- The ladder in force at commit time. The commitment stays valid, and settles on its committed amount, whatever the ladder becomes later.
  allowed_stakes_snapshot integer[] not null check (public.confidence_stakes_valid(allowed_stakes_snapshot)),
  state text not null default 'RESERVED' check (state in ('RESERVED', 'SETTLED_CORRECT', 'SETTLED_INCORRECT', 'SETTLED_VOID')),
  result text check (result in ('CORRECT', 'INCORRECT', 'VOID')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint confidence_stake_amount_was_allowed check (amount = any (allowed_stakes_snapshot)),
  constraint confidence_stake_state_shape check (
    (state = 'RESERVED' and result is null and settled_at is null)
    or (state = 'SETTLED_CORRECT' and result = 'CORRECT' and settled_at is not null)
    or (state = 'SETTLED_INCORRECT' and result = 'INCORRECT' and settled_at is not null)
    or (state = 'SETTLED_VOID' and result = 'VOID' and settled_at is not null))
);
comment on table public.confidence_prediction_stakes is 'Confidence put behind one Pick. Immutable except the one-way settlement transition. The reserve and the settlement are immutable entries in confidence_ledger_entries (linked by stake_id).';
-- Active stakes are the only thing settlement and reconciliation ever look at: a small, indexed set.
create index confidence_stakes_active_idx on public.confidence_prediction_stakes (created_at) where state = 'RESERVED';
create index confidence_stakes_member_idx on public.confidence_prediction_stakes (member_id, created_at desc);

-- Database-level invariants, independent of any function: the Member owns the Pick, the Pick is still pending, the side and Market match, the amount was on the ladder; afterwards nothing about the commitment
-- can change except the one-way RESERVED -> SETTLED transition, and a stake can never be deleted.
create or replace function public.confidence_stakes_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pred public.predictions;
begin
  if tg_op = 'DELETE' then
    raise exception 'a Confidence stake is never deleted';
  end if;
  if tg_op = 'INSERT' then
    select * into v_pred from public.predictions where id = new.prediction_id;
    if not found or v_pred.user_id <> new.member_id then raise exception 'a stake can only back the Member''s own Pick'; end if;
    if v_pred.lifecycle_state <> 'PENDING' then raise exception 'a graded Pick cannot be backed'; end if;
    if v_pred.market_id <> new.market_id or v_pred.selected_outcome <> new.selected_outcome then raise exception 'the stake must describe the Pick it backs'; end if;
    if new.state <> 'RESERVED' then raise exception 'a new stake starts RESERVED'; end if;
    return new;
  end if;
  if new.member_id <> old.member_id or new.prediction_id <> old.prediction_id or new.market_id <> old.market_id or new.fixture_id <> old.fixture_id or new.selected_outcome <> old.selected_outcome
     or new.amount <> old.amount or new.allowed_stakes_snapshot <> old.allowed_stakes_snapshot or new.created_at <> old.created_at then
    raise exception 'a committed Confidence stake cannot be changed';
  end if;
  if old.state <> 'RESERVED' then raise exception 'a settled Confidence stake cannot change'; end if;
  return new;
end;
$$;
create trigger confidence_stakes_guard_insert_update before insert or update on public.confidence_prediction_stakes for each row execute function public.confidence_stakes_guard();
create trigger confidence_stakes_guard_delete before delete on public.confidence_prediction_stakes for each row execute function public.confidence_stakes_guard();
revoke all on function public.confidence_stakes_guard() from public, anon, authenticated, service_role;

-- A Pick with a stake can never change its side, whoever writes it.
create or replace function public.predictions_confidence_stake_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.confidence_prediction_stakes where prediction_id = old.id) then
    raise exception 'this Pick has Confidence committed behind it, so its selection cannot change';
  end if;
  return new;
end;
$$;
create trigger predictions_confidence_stake_guard before update of selected_outcome on public.predictions
  for each row when (old.selected_outcome is distinct from new.selected_outcome) execute function public.predictions_confidence_stake_guard();
revoke all on function public.predictions_confidence_stake_guard() from public, anon, authenticated, service_role;

alter table public.confidence_prediction_stakes enable row level security;
revoke all on public.confidence_prediction_stakes from public, anon, authenticated;
grant all on public.confidence_prediction_stakes to service_role;
-- A Member reads only their OWN stakes (and only while Confidence is on); the ladder snapshot and Game id stay server-side.
grant select (id, member_id, prediction_id, market_id, selected_outcome, amount, state, result, created_at, settled_at) on public.confidence_prediction_stakes to authenticated;
create policy "members_read_own_confidence_stakes" on public.confidence_prediction_stakes for select to authenticated using (member_id = auth.uid() and public.confidence_enabled_flag());

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The ledger: the four prediction event types, each tied to its stake, each settlement exactly once
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.confidence_ledger_entries add column stake_id uuid references public.confidence_prediction_stakes (id) on delete restrict;
create index confidence_ledger_stake_idx on public.confidence_ledger_entries (stake_id) where stake_id is not null;

alter table public.confidence_ledger_entries drop constraint confidence_ledger_entries_entry_type_check;
alter table public.confidence_ledger_entries add constraint confidence_ledger_entries_entry_type_check
  check (entry_type in ('INITIAL_GRANT', 'DAILY_CLAIM', 'ADMIN_ADJUSTMENT', 'REVERSAL', 'PREDICTION_RESERVE', 'PREDICTION_RELEASE', 'PREDICTION_WIN', 'PREDICTION_LOSS'));
alter table public.confidence_ledger_entries drop constraint confidence_entry_no_reservation_yet;
alter table public.confidence_ledger_entries drop constraint confidence_entry_shape;
alter table public.confidence_ledger_entries add constraint confidence_entry_shape check (
  (entry_type = 'INITIAL_GRANT' and available_delta > 0 and reserved_delta = 0 and stake_id is null and actor_id is null and reason_code is null and reverses_entry_id is null)
  or (entry_type = 'DAILY_CLAIM' and available_delta > 0 and reserved_delta = 0 and stake_id is null and actor_id is null and reason_code is null and reverses_entry_id is null)
  or (entry_type = 'ADMIN_ADJUSTMENT' and available_delta <> 0 and reserved_delta = 0 and stake_id is null and actor_id is not null and reason_code is not null and note is not null and reverses_entry_id is null)
  or (entry_type = 'REVERSAL' and available_delta <> 0 and reserved_delta = 0 and stake_id is null and actor_id is not null and reverses_entry_id is not null and reason_code is null)
  -- Reserve: N moves from available to reserved (total unchanged).
  or (entry_type = 'PREDICTION_RESERVE' and stake_id is not null and available_delta < 0 and reserved_delta = -available_delta and actor_id is null and reason_code is null and reverses_entry_id is null)
  -- Void: the reserved N goes back to available (total unchanged).
  or (entry_type = 'PREDICTION_RELEASE' and stake_id is not null and available_delta > 0 and reserved_delta = -available_delta and actor_id is null and reason_code is null and reverses_entry_id is null)
  -- Correct: the reserved N returns AND the same N is newly issued: reserved -N, available +2N, total +N. Even money, no fee, no odds.
  or (entry_type = 'PREDICTION_WIN' and stake_id is not null and reserved_delta < 0 and available_delta = -2 * reserved_delta and actor_id is null and reason_code is null and reverses_entry_id is null)
  -- Incorrect: the reserved N is consumed: reserved -N, nothing returned, total -N.
  or (entry_type = 'PREDICTION_LOSS' and stake_id is not null and available_delta = 0 and reserved_delta < 0 and actor_id is null and reason_code is null and reverses_entry_id is null));
-- Exactly one reserve per stake, and exactly ONE settlement of any kind per stake — a stake can never pay, burn or release twice.
create unique index confidence_one_reserve_per_stake on public.confidence_ledger_entries (stake_id) where entry_type = 'PREDICTION_RESERVE';
create unique index confidence_one_settlement_per_stake on public.confidence_ledger_entries (stake_id) where entry_type in ('PREDICTION_RELEASE', 'PREDICTION_WIN', 'PREDICTION_LOSS');

-- Prediction entries are governed by grading, never by hand: an admin reversal of one is refused (a mistake is corrected through the canonical grade, which is permanent by design).
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
  if v_orig.stake_id is not null then return jsonb_build_object('outcome', 'prediction_entry'); end if;
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

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Attach: reserve Confidence behind the Member's own Pick and lock the Pick, atomically
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- What the UI needs to know, from the same checks the attach itself makes.
create or replace function public.confidence_stake_status(p_member_id uuid, p_prediction_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_pred public.predictions;
  v_stake public.confidence_prediction_stakes;
  v_account public.confidence_accounts;
  v_timing record;
begin
  select * into v_s from public.platform_settings where id = true;
  select * into v_pred from public.predictions where id = p_prediction_id;
  if not found or v_pred.user_id <> p_member_id then return jsonb_build_object('state', 'none'); end if;
  -- An existing commitment is always shown (and settles), whatever the capability says.
  select * into v_stake from public.confidence_prediction_stakes where prediction_id = p_prediction_id;
  if found then
    return jsonb_build_object('state', 'staked', 'amount', v_stake.amount, 'stakeState', v_stake.state, 'result', v_stake.result);
  end if;
  if v_s.confidence_enabled is not true or v_s.confidence_backed_picks_enabled is not true then return jsonb_build_object('state', 'unavailable', 'reason', 'disabled'); end if;
  if not public.confidence_member_eligible(p_member_id) then return jsonb_build_object('state', 'unavailable', 'reason', 'ineligible'); end if;
  if v_pred.lifecycle_state <> 'PENDING' then return jsonb_build_object('state', 'closed', 'reason', 'graded'); end if;
  select * into v_timing from public.pick_market_timing(v_pred.market_id);
  if not found then return jsonb_build_object('state', 'closed', 'reason', 'market'); end if;
  if v_timing.fixture_status <> 'NOT_STARTED' then return jsonb_build_object('state', 'closed', 'reason', 'game_started'); end if;
  if clock_timestamp() >= v_timing.effective_lock_at or v_pred.lock_reason = 'CUTOFF' then return jsonb_build_object('state', 'closed', 'reason', 'deadline'); end if;
  select * into v_account from public.confidence_accounts where member_id = p_member_id;
  return jsonb_build_object('state', 'open', 'available', coalesce(v_account.available, 0), 'allowedStakes', to_jsonb(v_s.confidence_allowed_stakes), 'locksAt', v_timing.effective_lock_at);
end;
$$;
revoke all on function public.confidence_stake_status(uuid, uuid) from public, anon, authenticated;
grant execute on function public.confidence_stake_status(uuid, uuid) to service_role;

-- The server action derives p_member_id from the authenticated session. Everything is decided here, in one transaction, after taking the Pick's row lock — the same primitive set_pick and the Call BS accept take,
-- so an edit, an accept and an attach can never all believe they won.
create or replace function public.confidence_attach_stake(p_member_id uuid, p_prediction_id uuid, p_amount integer, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_pred public.predictions;
  v_account public.confidence_accounts;
  v_prior public.confidence_ledger_entries;
  v_prior_stake public.confidence_prediction_stakes;
  v_timing record;
  v_fixture uuid;
  v_stake public.confidence_prediction_stakes;
  v_entry public.confidence_ledger_entries;
begin
  select * into v_s from public.platform_settings where id = true;
  if v_s.confidence_enabled is not true or v_s.confidence_backed_picks_enabled is not true then return jsonb_build_object('outcome', 'disabled'); end if;
  if not public.confidence_member_eligible(p_member_id) then return jsonb_build_object('outcome', 'ineligible'); end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 100 then raise exception 'invalid_idempotency_key'; end if;
  if p_amount is null or p_amount < 1 then return jsonb_build_object('outcome', 'invalid_amount'); end if;

  -- Serialise against any change to this Pick, then re-read it under the lock.
  select * into v_pred from public.predictions where id = p_prediction_id for update;
  if not found or v_pred.user_id <> p_member_id then return jsonb_build_object('outcome', 'not_found'); end if;

  -- A retry of the SAME request returns the original result and reserves nothing more.
  select * into v_prior from public.confidence_ledger_entries where member_id = p_member_id and idempotency_key = p_idempotency_key;
  if found then
    select * into v_prior_stake from public.confidence_prediction_stakes where id = v_prior.stake_id;
    if v_prior_stake.prediction_id is distinct from p_prediction_id then return jsonb_build_object('outcome', 'idempotency_conflict'); end if;
    return jsonb_build_object('outcome', 'attached', 'replay', true, 'stakeId', v_prior_stake.id, 'amount', v_prior_stake.amount);
  end if;

  if exists (select 1 from public.confidence_prediction_stakes where prediction_id = p_prediction_id) then return jsonb_build_object('outcome', 'already_backed'); end if;
  if v_pred.lifecycle_state <> 'PENDING' then return jsonb_build_object('outcome', 'pick_graded'); end if;

  -- The canonical timing rule, evaluated NOW (the actual instant, after the locks above — not when the transaction began), against authoritative Game state, never the client.
  select * into v_timing from public.pick_market_timing(v_pred.market_id);
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_timing.fixture_status <> 'NOT_STARTED' then return jsonb_build_object('outcome', 'game_started'); end if;
  if clock_timestamp() >= v_timing.effective_lock_at or v_pred.lock_reason = 'CUTOFF' then return jsonb_build_object('outcome', 'past_deadline'); end if;

  if not (p_amount = any (v_s.confidence_allowed_stakes)) then return jsonb_build_object('outcome', 'invalid_amount'); end if;

  perform public.confidence_bootstrap_member(p_member_id);
  select * into v_account from public.confidence_accounts where member_id = p_member_id for update;
  if not found then return jsonb_build_object('outcome', 'ineligible'); end if;
  -- Availability, never total: reserved Confidence is not spendable twice.
  if v_account.available < p_amount then return jsonb_build_object('outcome', 'insufficient', 'available', v_account.available); end if;

  select m.fixture_id into v_fixture from public.markets m where m.id = v_pred.market_id;
  insert into public.confidence_prediction_stakes (member_id, prediction_id, market_id, fixture_id, selected_outcome, amount, allowed_stakes_snapshot)
    values (p_member_id, p_prediction_id, v_pred.market_id, v_fixture, v_pred.selected_outcome, p_amount, v_s.confidence_allowed_stakes)
    returning * into v_stake;
  insert into public.confidence_ledger_entries (member_id, entry_type, available_delta, reserved_delta, stake_id, idempotency_key, metadata)
    values (p_member_id, 'PREDICTION_RESERVE', -p_amount, p_amount, v_stake.id, p_idempotency_key, jsonb_build_object('predictionId', p_prediction_id))
    returning * into v_entry;
  -- The Pick locks in the same transaction. If something else already locked it (an accepted Call BS, a money Position) that reason is KEPT — the stake itself is the second, independent reason it is immutable.
  update public.predictions set locked_at = coalesce(locked_at, now()), lock_reason = coalesce(lock_reason, 'CONFIDENCE_COMMITTED'), updated_at = now() where id = p_prediction_id;

  return jsonb_build_object('outcome', 'attached', 'stakeId', v_stake.id, 'amount', p_amount, 'available', v_entry.available_after, 'reserved', v_entry.reserved_after, 'total', v_entry.available_after + v_entry.reserved_after);
end;
$$;
revoke all on function public.confidence_attach_stake(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.confidence_attach_stake(uuid, uuid, integer, text) to service_role;

-- All the reasons a Pick is immutable: its own lock reason, plus a Confidence commitment (which never replaces another reason).
create or replace function public.prediction_lock_reasons(p_prediction_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_remove(array[p.lock_reason, case when exists (select 1 from public.confidence_prediction_stakes s where s.prediction_id = p.id) then 'CONFIDENCE_COMMITTED' end], null), '{}')
  from public.predictions p where p.id = p_prediction_id;
$$;
revoke all on function public.prediction_lock_reasons(uuid) from public, anon, authenticated;
grant execute on function public.prediction_lock_reasons(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Settlement: from the existing canonical grade only, exactly once, whatever the capability says
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.confidence_settle_prediction(p_prediction_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stake public.confidence_prediction_stakes;
  v_pred public.predictions;
  v_type text;
  v_available integer;
  v_state text;
begin
  select * into v_stake from public.confidence_prediction_stakes where prediction_id = p_prediction_id for update;
  if not found then return jsonb_build_object('outcome', 'no_stake'); end if;
  if v_stake.state <> 'RESERVED' then return jsonb_build_object('outcome', 'already_settled', 'state', v_stake.state); end if;
  select * into v_pred from public.predictions where id = p_prediction_id;
  -- Only a FINAL grade settles; a Pick that is still pending (or has no result) never does.
  if v_pred.lifecycle_state <> 'GRADED' or v_pred.result is null then return jsonb_build_object('outcome', 'not_graded'); end if;

  if v_pred.result = 'CORRECT' then v_type := 'PREDICTION_WIN'; v_available := 2 * v_stake.amount; v_state := 'SETTLED_CORRECT';
  elsif v_pred.result = 'INCORRECT' then v_type := 'PREDICTION_LOSS'; v_available := 0; v_state := 'SETTLED_INCORRECT';
  else v_type := 'PREDICTION_RELEASE'; v_available := v_stake.amount; v_state := 'SETTLED_VOID';
  end if;

  -- The unique index on (stake, settlement) and this key make a second settlement impossible, however it is reached.
  insert into public.confidence_ledger_entries (member_id, entry_type, available_delta, reserved_delta, stake_id, idempotency_key, metadata)
    values (v_stake.member_id, v_type, v_available, -v_stake.amount, v_stake.id, 'stake-settle-' || v_stake.id::text, jsonb_build_object('predictionId', p_prediction_id, 'result', v_pred.result));
  update public.confidence_prediction_stakes set state = v_state, result = v_pred.result, settled_at = now() where id = v_stake.id;
  return jsonb_build_object('outcome', 'settled', 'type', v_type, 'amount', v_stake.amount, 'result', v_pred.result, 'net', case v_pred.result when 'CORRECT' then v_stake.amount when 'INCORRECT' then -v_stake.amount else 0 end);
end;
$$;
revoke all on function public.confidence_settle_prediction(uuid) from public, anon, authenticated;
grant execute on function public.confidence_settle_prediction(uuid) to service_role;

-- Grading and settlement commit TOGETHER: the moment a Pick becomes GRADED, its stake (if any) settles in the same transaction. A failure inside settlement is contained (and the stake simply stays RESERVED for the
-- sweep below) so a Confidence problem can never block ordinary grading.
create or replace function public.confidence_settle_on_grade()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.confidence_settle_prediction(new.id);
  exception when others then
    raise warning 'confidence settlement deferred for a graded Pick: %', sqlstate;
  end;
  return null;
end;
$$;
create trigger predictions_confidence_settle after update of lifecycle_state on public.predictions
  for each row when (old.lifecycle_state is distinct from new.lifecycle_state and new.lifecycle_state = 'GRADED') execute function public.confidence_settle_on_grade();
revoke all on function public.confidence_settle_on_grade() from public, anon, authenticated, service_role;

-- The retry-safe sweep: only ACTIVE stakes whose Pick is already graded (a partial index on RESERVED stakes — never a rewalk of everything). Normally finds nothing.
create or replace function public.confidence_settle_pending(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_done integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then p_limit := 200; end if;
  for v_id in
    select s.prediction_id from public.confidence_prediction_stakes s join public.predictions p on p.id = s.prediction_id
      where s.state = 'RESERVED' and p.lifecycle_state = 'GRADED' order by s.created_at limit p_limit
  loop
    if (public.confidence_settle_prediction(v_id) ->> 'outcome') = 'settled' then v_done := v_done + 1; end if;
  end loop;
  return jsonb_build_object('settled', v_done);
end;
$$;
revoke all on function public.confidence_settle_pending(integer) from public, anon, authenticated;
grant execute on function public.confidence_settle_pending(integer) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Daily Claim: eligibility and the baseline cap now use TOTAL Confidence (reserved Confidence is still the Member's), the claim still credits AVAILABLE
-- ---------------------------------------------------------------------------------------------------------------------------------------------
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

  perform public.confidence_bootstrap_member(p_member_id);
  select * into v_account from public.confidence_accounts where member_id = p_member_id for update;
  if not found then return jsonb_build_object('outcome', 'ineligible'); end if;

  if p_idempotency_key is not null then
    select * into v_prior from public.confidence_ledger_entries where member_id = p_member_id and idempotency_key = p_idempotency_key;
    if found then return jsonb_build_object('outcome', 'claimed', 'replay', true, 'amount', v_prior.available_delta, 'available', v_prior.available_after, 'total', v_prior.available_after + v_prior.reserved_after); end if;
  end if;

  -- TOTAL, not available: putting Confidence behind a Pick must never manufacture claim eligibility.
  if v_account.total >= v_s.confidence_baseline then
    return jsonb_build_object('outcome', 'at_or_above_baseline', 'available', v_account.available, 'total', v_account.total);
  end if;
  if v_account.last_daily_claim_at is not null then
    v_next := v_account.last_daily_claim_at + make_interval(hours => v_s.confidence_daily_claim_interval_hours);
    if now() < v_next then return jsonb_build_object('outcome', 'too_soon', 'nextAvailableAt', v_next, 'available', v_account.available, 'total', v_account.total); end if;
  end if;

  -- Never past the baseline: capped at the gap in TOTAL. The credit lands in AVAILABLE.
  v_amount := least(v_s.confidence_daily_claim_amount, (v_s.confidence_baseline - v_account.total)::integer);
  insert into public.confidence_ledger_entries (member_id, entry_type, available_delta, idempotency_key, metadata)
    values (p_member_id, 'DAILY_CLAIM', v_amount, p_idempotency_key, jsonb_build_object('baseline', v_s.confidence_baseline, 'intervalHours', v_s.confidence_daily_claim_interval_hours))
    returning * into v_entry;
  return jsonb_build_object('outcome', 'claimed', 'amount', v_amount, 'available', v_entry.available_after, 'total', v_entry.available_after + v_entry.reserved_after,
    'nextAvailableAt', v_entry.created_at + make_interval(hours => v_s.confidence_daily_claim_interval_hours));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Reconciliation: accounts vs ledger (unchanged) PLUS reserved vs active stakes, and the stake lifecycle
-- ---------------------------------------------------------------------------------------------------------------------------------------------
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
  left join (select s.member_id, sum(s.amount) active from public.confidence_prediction_stakes s where s.state = 'RESERVED' group by s.member_id) k on k.member_id = a.member_id
  where a.available <> coalesce(l.av, 0) or a.reserved <> coalesce(l.rs, 0)
     -- a Member's reserved Confidence must equal the sum of their active (RESERVED) stakes
     or a.reserved <> coalesce(k.active, 0);
$$;

-- Stake lifecycle problems: a settled stake with no settlement entry (or the reverse), a missing or wrong reserve entry, and a reserve stranded behind a Pick that has been graded longer than the grace period
-- (settlement is atomic with grading, so this only appears if settlement was deferred and the sweep has not caught up). Must always be empty.
create or replace function public.confidence_reconcile_stakes(p_grace_minutes integer default 15)
returns table (kind text, stake_id uuid, member_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select 'SETTLED_WITHOUT_ENTRY', s.id, s.member_id from public.confidence_prediction_stakes s
    where s.state <> 'RESERVED' and not exists (select 1 from public.confidence_ledger_entries e where e.stake_id = s.id and e.entry_type in ('PREDICTION_RELEASE', 'PREDICTION_WIN', 'PREDICTION_LOSS'))
  union all
  select 'ENTRY_WITHOUT_SETTLEMENT', s.id, s.member_id from public.confidence_prediction_stakes s
    where s.state = 'RESERVED' and exists (select 1 from public.confidence_ledger_entries e where e.stake_id = s.id and e.entry_type in ('PREDICTION_RELEASE', 'PREDICTION_WIN', 'PREDICTION_LOSS'))
  union all
  select 'RESERVE_ENTRY_MISSING_OR_WRONG', s.id, s.member_id from public.confidence_prediction_stakes s
    where not exists (select 1 from public.confidence_ledger_entries e where e.stake_id = s.id and e.entry_type = 'PREDICTION_RESERVE' and e.reserved_delta = s.amount and e.member_id = s.member_id)
  union all
  select 'STRANDED_RESERVE', s.id, s.member_id from public.confidence_prediction_stakes s join public.predictions p on p.id = s.prediction_id
    where s.state = 'RESERVED' and p.lifecycle_state = 'GRADED' and p.graded_at < now() - make_interval(mins => greatest(coalesce(p_grace_minutes, 15), 0));
$$;
revoke all on function public.confidence_reconcile_stakes(integer) from public, anon, authenticated;
grant execute on function public.confidence_reconcile_stakes(integer) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Economy overview: the Milestone 3 figures (now classed by TOTAL Confidence) plus prediction activity. Aggregates only.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
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
    -- Classed by TOTAL Confidence (reserved Confidence is still the Member's).
    'belowBaseline', count(*) filter (where total < v_baseline),
    'atBaseline', count(*) filter (where total = v_baseline),
    'aboveBaseline', count(*) filter (where total > v_baseline),
    'baseline', v_baseline) into v_result from public.confidence_accounts;
  return v_result || jsonb_build_object(
    'eligibleMembers', (select count(*) from public.user_profiles where is_active is true and account_closed_at is null),
    'initialGrants', (select jsonb_build_object('count', count(*), 'total', coalesce(sum(available_delta), 0)) from public.confidence_ledger_entries where entry_type = 'INITIAL_GRANT'),
    'dailyClaims', (select jsonb_build_object('count', count(*), 'total', coalesce(sum(available_delta), 0)) from public.confidence_ledger_entries where entry_type = 'DAILY_CLAIM'),
    'adminAdjustments', (select jsonb_build_object('count', count(*), 'net', coalesce(sum(available_delta), 0)) from public.confidence_ledger_entries where entry_type = 'ADMIN_ADJUSTMENT'),
    'reversals', (select jsonb_build_object('count', count(*), 'net', coalesce(sum(available_delta), 0)) from public.confidence_ledger_entries where entry_type = 'REVERSAL'),
    'predictions', (
      select jsonb_build_object(
        'activeBackedPicks', count(*) filter (where state = 'RESERVED'),
        'reserved', coalesce(sum(amount) filter (where state = 'RESERVED'), 0),
        'totalCommitted', coalesce(sum(amount), 0),
        'backedPicks', count(*),
        'averageCommitted', round(avg(amount)::numeric, 2),
        'winningsIssued', coalesce(sum(amount) filter (where state = 'SETTLED_CORRECT'), 0),
        'lossesBurned', coalesce(sum(amount) filter (where state = 'SETTLED_INCORRECT'), 0),
        'voidReleases', coalesce(sum(amount) filter (where state = 'SETTLED_VOID'), 0),
        'byAmount', coalesce((select jsonb_object_agg(a::text, n) from (select amount a, count(*) n from public.confidence_prediction_stakes group by amount order by amount) d), '{}'::jsonb))
      from public.confidence_prediction_stakes),
    'netChange', jsonb_build_object(
      'days7', (select coalesce(sum(available_delta + reserved_delta), 0) from public.confidence_ledger_entries where created_at >= now() - interval '7 days'),
      'days30', (select coalesce(sum(available_delta + reserved_delta), 0) from public.confidence_ledger_entries where created_at >= now() - interval '30 days')),
    'reconciliationMismatches', (select count(*) from public.confidence_reconcile()) + (select count(*) from public.confidence_reconcile_stakes()));
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The audited settings function: the Milestone 3 keys plus the new capability and the settlement wording
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
  v_allowed text[] := array['confidence_enabled', 'confidence_backed_picks_enabled', 'confidence_baseline', 'confidence_daily_claim_amount', 'confidence_daily_claim_interval_hours', 'confidence_allowed_stakes',
    'confidence_notify_correct', 'confidence_notify_incorrect', 'confidence_notify_void'];
begin
  perform public.require_super_admin(p_admin_id);
  if p_config is null or jsonb_typeof(p_config) <> 'object' then raise exception 'invalid_config'; end if;
  for v_key in select jsonb_object_keys(p_config) loop
    if not (v_key = any (v_allowed)) then raise exception 'unknown_setting_%', v_key; end if;
  end loop;
  if p_config ? 'confidence_allowed_stakes' then
    if jsonb_typeof(p_config -> 'confidence_allowed_stakes') <> 'array' then raise exception 'invalid_stakes'; end if;
    select array_agg(x.value::integer order by x.ord) into v_stakes from jsonb_array_elements_text(p_config -> 'confidence_allowed_stakes') with ordinality as x(value, ord);
    if v_stakes is null then raise exception 'invalid_stakes'; end if;
  end if;
  select * into v_before from public.platform_settings where id = true for update;
  update public.platform_settings set
    confidence_enabled = coalesce((p_config ->> 'confidence_enabled')::boolean, confidence_enabled),
    confidence_backed_picks_enabled = coalesce((p_config ->> 'confidence_backed_picks_enabled')::boolean, confidence_backed_picks_enabled),
    confidence_baseline = coalesce((p_config ->> 'confidence_baseline')::integer, confidence_baseline),
    confidence_daily_claim_amount = coalesce((p_config ->> 'confidence_daily_claim_amount')::integer, confidence_daily_claim_amount),
    confidence_daily_claim_interval_hours = coalesce((p_config ->> 'confidence_daily_claim_interval_hours')::integer, confidence_daily_claim_interval_hours),
    confidence_allowed_stakes = coalesce(v_stakes, confidence_allowed_stakes),
    confidence_notify_correct = coalesce(p_config ->> 'confidence_notify_correct', confidence_notify_correct),
    confidence_notify_incorrect = coalesce(p_config ->> 'confidence_notify_incorrect', confidence_notify_incorrect),
    confidence_notify_void = coalesce(p_config ->> 'confidence_notify_void', confidence_notify_void),
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
