-- Commercial payment attempts (ONVO TEST integration; provider-neutral schema).
--
-- The sponsorship invariant is unchanged and enforced where it always was: a sponsorship runs only when PAID *and* approved by Super Admin (and the capability is
-- on, in window, not suspended/cancelled). A payment provider can satisfy ONLY the payment half. Nothing here approves, schedules or publishes anything beyond what
-- the existing manual path already does: payment moves a sponsorship onto the clock only if an approval already stands and is intact.
--
-- Provider-neutral on purpose: `commercial_payment_attempts` knows a provider name and an environment (TEST/LIVE), never an ONVO-specific column. MANUAL payments stay in
-- sponsorship_payment_events exactly as before and remain available.

alter table public.sponsorship_payment_events
  add column environment text check (environment is null or environment in ('TEST', 'LIVE'));

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- One shared place that settles a sponsorship as PAID (manual and provider paths both use it; the manual function now calls it).
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.sponsorship_settle_payment(p_id uuid, p_provider text, p_environment text, p_reference text, p_actor uuid, p_note text, p_key text, p_except_attempt uuid default null)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_after public.sponsorships;
  v_intact boolean;
begin
  v_s := public.sponsorship_lock(p_id);
  if v_s.payment_status = 'PAID' then return v_s; end if;
  if v_s.lifecycle <> 'SUBMITTED' or v_s.payment_status not in ('UNPAID', 'PENDING', 'FAILED') then raise exception 'invalid_transition'; end if;
  if v_s.price_cents is null then raise exception 'price_missing'; end if;

  insert into public.sponsorship_payment_events (sponsorship_id, event_type, amount_cents, currency, provider, environment, provider_reference, note, actor_id, idempotency_key)
  values (p_id, 'PAID', v_s.price_cents, v_s.currency, p_provider, p_environment, nullif(btrim(p_reference), ''), nullif(btrim(p_note), ''),
          case when p_actor is not null and exists (select 1 from public.user_profiles where id = p_actor) then p_actor else null end, p_key);

  update public.sponsorships set payment_status = 'PAID' where id = p_id returning * into v_after;
  -- Payment never activates by itself. It only completes the "paid" half; if (and only if) an approval already stands, the sponsorship moves onto the clock.
  v_intact := v_after.review_status = 'APPROVED' and v_after.approved_hash is not null and v_after.approved_hash = public.sponsorship_material_hash(v_after);
  if v_intact then
    update public.sponsorships set lifecycle = public.sponsorship_scheduled_lifecycle(v_after, now()),
      completed_at = case when now() >= v_after.ends_at then now() else completed_at end
    where id = p_id returning * into v_after;
  end if;
  -- The obligation is settled: any other still-open provider attempt can no longer be a second payment path.
  update public.commercial_payment_attempts set status = 'SUPERSEDED', updated_at = now()
    where sponsorship_id = p_id and status in ('CREATED', 'PENDING') and (p_except_attempt is null or id <> p_except_attempt);
  perform public.sponsorship_audit(p_actor, 'sponsorship.payment_confirmed', p_id, public.sponsorship_state_json(v_s),
    public.sponsorship_state_json(v_after) || jsonb_build_object('paymentProvider', p_provider, 'paymentEnvironment', p_environment), nullif(btrim(p_note), ''));
  return v_after;
end;
$$;
revoke all on function public.sponsorship_settle_payment(uuid, text, text, text, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.sponsorship_settle_payment(uuid, text, text, text, uuid, text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table public.commercial_payment_attempts (
  id                  uuid primary key default gen_random_uuid(),
  sponsorship_id      uuid not null references public.sponsorships (id),
  sponsor_id          uuid not null references public.sponsors (id),
  provider            text not null check (provider in ('ONVO')),
  environment         text not null check (environment in ('TEST', 'LIVE')),
  -- Local status (provider-neutral). SUCCEEDED is the only one that satisfied the sponsorship; the rest explain why not.
  status              text not null default 'CREATED' check (status in ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'SUPERSEDED', 'CANCELLED', 'DUPLICATE_PAYMENT', 'MISMATCH', 'UNAPPLIED')),
  provider_status     text check (provider_status is null or char_length(provider_status) <= 60),
  -- The amount is the sponsorship's FROZEN price, read by the database — never anything the browser sent.
  amount_cents        integer not null check (amount_cents > 0),
  currency            text not null check (currency ~ '^[A-Z]{3}$'),
  provider_session_id text check (provider_session_id is null or char_length(provider_session_id) <= 200),
  provider_payment_ref text check (provider_payment_ref is null or char_length(provider_payment_ref) <= 200),
  checkout_url        text check (checkout_url is null or char_length(checkout_url) <= 1000),
  failure_code        text check (failure_code is null or char_length(failure_code) <= 120),
  idempotency_key     text not null unique check (char_length(idempotency_key) between 1 and 200),
  created_by          uuid references auth.users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  paid_at             timestamptz,
  failed_at           timestamptz,
  refunded_at         timestamptz,
  last_provider_event_at timestamptz
);
-- One OPEN attempt per sponsorship (double-click / two tabs / retry can never start two parallel payments) and at most ONE satisfying payment.
create unique index commercial_payment_one_open_attempt on public.commercial_payment_attempts (sponsorship_id) where status in ('CREATED', 'PENDING');
create unique index commercial_payment_one_success on public.commercial_payment_attempts (sponsorship_id) where status = 'SUCCEEDED';
create unique index commercial_payment_session_unique on public.commercial_payment_attempts (provider, environment, provider_session_id) where provider_session_id is not null;
create unique index commercial_payment_ref_unique on public.commercial_payment_attempts (provider, environment, provider_payment_ref) where provider_payment_ref is not null;
create index commercial_payment_attempts_sponsorship_idx on public.commercial_payment_attempts (sponsorship_id, created_at);
create trigger commercial_payment_attempts_set_updated_at before update on public.commercial_payment_attempts for each row execute function public.set_updated_at();

-- Every provider message / reconciliation read, once: the idempotency ledger and the operational audit (no card data, no raw payload).
create table public.commercial_payment_provider_events (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null,
  environment text not null,
  event_type  text not null check (char_length(event_type) <= 80),
  object_key  text check (object_key is null or char_length(object_key) <= 200),
  dedup_key   text not null unique check (char_length(dedup_key) between 1 and 300),
  attempt_id  uuid references public.commercial_payment_attempts (id),
  source      text not null default 'WEBHOOK' check (source in ('WEBHOOK', 'RECONCILE', 'RETURN')),
  result      text not null default 'RECEIVED',
  received_at timestamptz not null default now()
);
create index commercial_payment_provider_events_attempt_idx on public.commercial_payment_provider_events (attempt_id);

create table public.commercial_payment_refunds (
  id                 uuid primary key default gen_random_uuid(),
  attempt_id         uuid not null references public.commercial_payment_attempts (id),
  sponsorship_id     uuid not null references public.sponsorships (id),
  provider           text not null,
  environment        text not null,
  provider_refund_id text,
  amount_cents       integer not null check (amount_cents > 0),
  currency           text not null,
  status             text not null default 'REQUESTED' check (status in ('REQUESTED', 'PENDING', 'SUCCEEDED', 'FAILED')),
  failure_code       text,
  requested_by       uuid not null references public.user_profiles (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
-- A payment is refunded at most once through the provider: a second request while one is in flight or done is refused; a FAILED one can be retried (or done by hand).
create unique index commercial_refund_one_active on public.commercial_payment_refunds (attempt_id) where status in ('REQUESTED', 'PENDING', 'SUCCEEDED');
create trigger commercial_payment_refunds_set_updated_at before update on public.commercial_payment_refunds for each row execute function public.set_updated_at();

alter table public.commercial_payment_attempts enable row level security;
alter table public.commercial_payment_provider_events enable row level security;
alter table public.commercial_payment_refunds enable row level security;
revoke all on public.commercial_payment_attempts, public.commercial_payment_provider_events, public.commercial_payment_refunds from public, anon, authenticated;
grant select on public.commercial_payment_attempts, public.commercial_payment_provider_events, public.commercial_payment_refunds to authenticated;
grant all on public.commercial_payment_attempts, public.commercial_payment_provider_events, public.commercial_payment_refunds to service_role;
-- Only Super Admin reads these directly. A Sponsor sees its own safe payment status through server code, never provider identifiers.
create policy "commercial_attempts_super_admin_read" on public.commercial_payment_attempts for select to authenticated using (public.is_super_admin(auth.uid()));
create policy "commercial_events_super_admin_read" on public.commercial_payment_provider_events for select to authenticated using (public.is_super_admin(auth.uid()));
create policy "commercial_refunds_super_admin_read" on public.commercial_payment_refunds for select to authenticated using (public.is_super_admin(auth.uid()));

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Manual payment now goes through the shared settle function (behavior unchanged; it also closes any open provider attempt).
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_mark_sponsorship_paid(p_admin_id uuid, p_id uuid, p_reference text, p_note text, p_idempotency_key text)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
begin
  perform public.require_super_admin(p_admin_id);
  v_s := public.sponsorship_lock(p_id);
  -- A retry with the same key (or an already-paid sponsorship) is a no-op: never a second payment event, audit row or activation.
  if exists (select 1 from public.sponsorship_payment_events where idempotency_key = p_idempotency_key) or v_s.payment_status = 'PAID' then return v_s; end if;
  if v_s.lifecycle <> 'SUBMITTED' or v_s.payment_status not in ('UNPAID', 'PENDING', 'FAILED') then raise exception 'invalid_transition'; end if;
  if v_s.price_cents is null then raise exception 'price_missing'; end if;
  return public.sponsorship_settle_payment(p_id, 'MANUAL', null, p_reference, p_admin_id, p_note, p_idempotency_key);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Starting a payment: authorization, eligibility and the canonical amount all live here.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.commercial_payment_begin(p_user_id uuid, p_id uuid, p_provider text, p_environment text, p_idempotency_key text)
returns public.commercial_payment_attempts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_a public.commercial_payment_attempts;
begin
  -- Ownership, ACTIVE sponsor account and the sponsorship capability are checked (and the row locked) here; this also serializes a double-click / two tabs.
  v_s := public.sponsor_acting_on(p_user_id, p_id);
  if v_s.lifecycle <> 'SUBMITTED' then raise exception 'sponsorship_not_payable'; end if;
  if v_s.payment_status = 'PAID' then raise exception 'already_paid'; end if;
  if v_s.payment_status not in ('PENDING', 'FAILED') then raise exception 'sponsorship_not_payable'; end if;
  if v_s.price_cents is null or v_s.price_cents <= 0 or v_s.currency is null then raise exception 'price_missing'; end if;

  select * into v_a from public.commercial_payment_attempts where sponsorship_id = p_id and status in ('CREATED', 'PENDING') for update;
  if found then
    -- Reuse the one open attempt when it still matches what is owed; otherwise retire it (never two parallel intents).
    if v_a.provider = p_provider and v_a.environment = p_environment and v_a.amount_cents = v_s.price_cents and v_a.currency = v_s.currency then return v_a; end if;
    update public.commercial_payment_attempts set status = 'SUPERSEDED' where id = v_a.id;
  end if;

  insert into public.commercial_payment_attempts (sponsorship_id, sponsor_id, provider, environment, amount_cents, currency, idempotency_key, created_by)
  values (p_id, v_s.sponsor_id, p_provider, p_environment, v_s.price_cents, v_s.currency, p_idempotency_key, p_user_id)
  on conflict (idempotency_key) do nothing
  returning * into v_a;
  if v_a.id is null then select * into v_a from public.commercial_payment_attempts where idempotency_key = p_idempotency_key; end if;
  -- A de-duplication key can only ever mean THIS sponsorship; a key that belongs to another one is refused, never silently returned.
  if v_a.sponsorship_id is distinct from p_id then raise exception 'idempotency_conflict'; end if;
  perform public.sponsorship_audit(p_user_id, 'sponsorship.payment_attempt_created', p_id, null, jsonb_build_object('provider', p_provider, 'environment', p_environment, 'amountCents', v_a.amount_cents, 'currency', v_a.currency, 'attemptId', v_a.id), null);
  return v_a;
end;
$$;

create or replace function public.commercial_payment_attach(p_attempt_id uuid, p_session_id text, p_checkout_url text, p_provider_status text)
returns public.commercial_payment_attempts
language plpgsql
security definer
set search_path = public
as $$
declare v_a public.commercial_payment_attempts;
begin
  update public.commercial_payment_attempts set status = 'PENDING', provider_session_id = p_session_id, checkout_url = p_checkout_url, provider_status = p_provider_status
    where id = p_attempt_id and status in ('CREATED', 'PENDING') returning * into v_a;
  if v_a.id is null then select * into v_a from public.commercial_payment_attempts where id = p_attempt_id; end if;
  return v_a;
end;
$$;


-- Only ONE request may create the provider session for an attempt (a double-click or a second tab gets false and waits for the first). A claim older than a minute
-- is treated as abandoned (the creating request died) and can be taken again.
create or replace function public.commercial_payment_claim_creation(p_attempt_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  update public.commercial_payment_attempts set provider_status = 'CREATING', updated_at = now()
    where id = p_attempt_id and status = 'CREATED' and provider_session_id is null
      and (provider_status is distinct from 'CREATING' or updated_at < now() - interval '60 seconds')
    returning id into v_id;
  return v_id is not null;
end;
$$;
revoke all on function public.commercial_payment_claim_creation(uuid) from public, anon, authenticated;
grant execute on function public.commercial_payment_claim_creation(uuid) to service_role;

-- The provider could not be reached / refused: nothing is guessed. The attempt is FAILED (retryable); if the session did get created and is paid later, the
-- webhook/reconciliation still recognizes it (success is accepted from any non-terminal attempt of this sponsorship).
create or replace function public.commercial_payment_creation_failed(p_attempt_id uuid, p_code text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.commercial_payment_attempts set status = 'FAILED', failure_code = left(p_code, 120), failed_at = now() where id = p_attempt_id and status in ('CREATED');
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The ONE place provider state becomes local state: idempotent, order-tolerant, amount-checked, never approves anything.
-- p_outcome: PENDING | FAILED | EXPIRED | SUCCEEDED   (already normalized from the provider's own words by the adapter)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.commercial_payment_apply_result(
  p_provider text, p_environment text, p_dedup_key text, p_event_type text, p_source text,
  p_attempt_id uuid, p_session_id text, p_payment_ref text,
  p_outcome text, p_amount_cents bigint, p_currency text, p_provider_status text, p_failure_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ledger uuid;
  v_a public.commercial_payment_attempts;
  v_s public.sponsorships;
  v_result text;
  v_after public.sponsorships;
begin
  if p_outcome not in ('PENDING', 'FAILED', 'EXPIRED', 'SUCCEEDED') then raise exception 'invalid_outcome'; end if;

  -- 1. The ledger row IS the idempotency check: a repeated delivery of the same fact stops here, changing nothing and notifying nobody.
  insert into public.commercial_payment_provider_events (provider, environment, event_type, object_key, dedup_key, source)
  values (p_provider, p_environment, p_event_type, coalesce(p_session_id, p_payment_ref), p_dedup_key, p_source)
  on conflict (dedup_key) do nothing returning id into v_ledger;
  if v_ledger is null then return jsonb_build_object('result', 'DUPLICATE'); end if;

  -- 2. Find the attempt by its own id, else the provider's session / payment reference. Unknown object: recorded, never guessed at.
  if p_attempt_id is not null then select * into v_a from public.commercial_payment_attempts where id = p_attempt_id; end if;
  if v_a.id is null and p_session_id is not null then select * into v_a from public.commercial_payment_attempts where provider = p_provider and environment = p_environment and provider_session_id = p_session_id; end if;
  if v_a.id is null and p_payment_ref is not null then select * into v_a from public.commercial_payment_attempts where provider = p_provider and environment = p_environment and provider_payment_ref = p_payment_ref; end if;
  if v_a.id is null then
    update public.commercial_payment_provider_events set result = 'UNKNOWN_OBJECT' where id = v_ledger;
    return jsonb_build_object('result', 'UNKNOWN_OBJECT');
  end if;

  v_s := public.sponsorship_lock(v_a.sponsorship_id);
  select * into v_a from public.commercial_payment_attempts where id = v_a.id for update;
  update public.commercial_payment_provider_events set attempt_id = v_a.id where id = v_ledger;

  -- A TEST event can never settle a LIVE attempt, nor the reverse.
  if v_a.environment <> p_environment or v_a.provider <> p_provider then
    update public.commercial_payment_provider_events set result = 'ENVIRONMENT_MISMATCH' where id = v_ledger;
    perform public.sponsorship_audit(null, 'sponsorship.payment_environment_mismatch', v_a.sponsorship_id, null, jsonb_build_object('attemptId', v_a.id, 'eventEnvironment', p_environment), null);
    return jsonb_build_object('result', 'ENVIRONMENT_MISMATCH');
  end if;

  update public.commercial_payment_attempts set last_provider_event_at = now(), provider_status = coalesce(left(p_provider_status, 60), provider_status),
    provider_session_id = coalesce(provider_session_id, p_session_id), provider_payment_ref = coalesce(provider_payment_ref, p_payment_ref)
    where id = v_a.id returning * into v_a;

  -- 3. Order tolerance: SUCCEEDED is terminal and wins over anything that arrives later or earlier (FAILED then SUCCEEDED ends PAID; SUCCEEDED then FAILED stays PAID);
  --    a lower-ranked message never rewrites a higher-ranked state.
  if v_a.status in ('SUCCEEDED', 'DUPLICATE_PAYMENT', 'MISMATCH', 'UNAPPLIED') then
    v_result := case when p_outcome = 'SUCCEEDED' then 'DUPLICATE' else 'IGNORED_STALE' end;
    update public.commercial_payment_provider_events set result = v_result where id = v_ledger;
    return jsonb_build_object('result', v_result, 'attemptId', v_a.id);
  end if;

  if p_outcome = 'PENDING' then
    if v_a.status in ('CREATED', 'PENDING') then update public.commercial_payment_attempts set status = 'PENDING' where id = v_a.id; v_result := 'APPLIED_PENDING'; else v_result := 'IGNORED_STALE'; end if;

  elsif p_outcome = 'FAILED' or p_outcome = 'EXPIRED' then
    if v_a.status in ('CREATED', 'PENDING') then
      update public.commercial_payment_attempts set status = case when p_outcome = 'FAILED' then 'FAILED' else 'EXPIRED' end, failure_code = left(p_failure_code, 120), failed_at = now() where id = v_a.id;
      -- A failure is shown to the Sponsor as such (and can be retried); inventory stays held exactly as the existing rules hold it.
      if p_outcome = 'FAILED' and v_s.payment_status = 'PENDING' then
        insert into public.sponsorship_payment_events (sponsorship_id, event_type, amount_cents, currency, provider, environment, provider_reference, note, idempotency_key)
        values (v_s.id, 'FAILED', v_a.amount_cents, v_a.currency, v_a.provider, v_a.environment, v_a.provider_payment_ref, left(coalesce(p_failure_code, 'payment failed'), 200), 'commercial:failed:' || v_a.id)
        on conflict (idempotency_key) do nothing;
        update public.sponsorships set payment_status = 'FAILED' where id = v_s.id;
        perform public.sponsorship_audit(null, 'sponsorship.payment_failed', v_s.id, null, jsonb_build_object('attemptId', v_a.id, 'code', p_failure_code), null);
      end if;
      v_result := 'APPLIED_' || p_outcome;
    else v_result := 'IGNORED_STALE'; end if;

  else -- SUCCEEDED
    if p_amount_cents is null or p_currency is null or p_amount_cents <> v_a.amount_cents or p_currency <> v_a.currency then
      update public.commercial_payment_attempts set status = 'MISMATCH' where id = v_a.id;
      perform public.sponsorship_audit(null, 'sponsorship.payment_amount_mismatch', v_s.id, null, jsonb_build_object('attemptId', v_a.id, 'expectedCents', v_a.amount_cents, 'expectedCurrency', v_a.currency, 'reportedCents', p_amount_cents, 'reportedCurrency', p_currency), null);
      v_result := 'AMOUNT_MISMATCH';
    elsif v_s.payment_status = 'PAID' then
      -- Already settled (by hand or by another attempt). Two payments for one obligation: flagged for a human, never counted twice, never auto-refunded.
      update public.commercial_payment_attempts set status = 'DUPLICATE_PAYMENT', paid_at = now() where id = v_a.id;
      perform public.sponsorship_audit(null, 'sponsorship.duplicate_payment_detected', v_s.id, null, jsonb_build_object('attemptId', v_a.id, 'provider', v_a.provider, 'environment', v_a.environment), null);
      v_result := 'DUPLICATE_PAYMENT';
    elsif v_s.lifecycle = 'SUBMITTED' and v_s.payment_status in ('PENDING', 'FAILED', 'UNPAID') then
      update public.commercial_payment_attempts set status = 'SUCCEEDED', paid_at = now(), failed_at = null where id = v_a.id returning * into v_a;
      v_after := public.sponsorship_settle_payment(v_s.id, v_a.provider, v_a.environment, coalesce(v_a.provider_payment_ref, v_a.provider_session_id), null, v_a.provider || ' payment ' || lower(v_a.environment), 'commercial:paid:' || v_a.id, v_a.id);
      v_result := 'APPLIED_PAID';
    else
      -- Money arrived for a sponsorship that can no longer take it (e.g. cancelled meanwhile): kept as evidence, applied to nothing, flagged.
      update public.commercial_payment_attempts set status = 'UNAPPLIED', paid_at = now() where id = v_a.id;
      perform public.sponsorship_audit(null, 'sponsorship.unapplied_payment_detected', v_s.id, null, jsonb_build_object('attemptId', v_a.id, 'lifecycle', v_s.lifecycle, 'paymentStatus', v_s.payment_status), null);
      v_result := 'UNAPPLIED';
    end if;
  end if;

  update public.commercial_payment_provider_events set result = v_result where id = v_ledger;
  return jsonb_build_object('result', v_result, 'attemptId', v_a.id, 'sponsorshipId', v_s.id);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Provider refunds: Super Admin starts one, the provider's confirmed answer decides local state. Brohda's refund POLICY decides WHETHER one is owed; this only
-- records one METHOD of paying it. Never REFUNDED until the provider says so.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.commercial_refund_begin(p_admin_id uuid, p_attempt_id uuid)
returns public.commercial_payment_refunds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a public.commercial_payment_attempts;
  v_s public.sponsorships;
  v_r public.commercial_payment_refunds;
begin
  perform public.require_super_admin(p_admin_id);
  select * into v_a from public.commercial_payment_attempts where id = p_attempt_id for update;
  if not found then raise exception 'payment_not_found'; end if;
  v_s := public.sponsorship_lock(v_a.sponsorship_id);
  if v_a.status <> 'SUCCEEDED' or v_a.provider_payment_ref is null then raise exception 'payment_not_refundable'; end if;
  if v_s.payment_status not in ('PAID', 'REFUND_PENDING') then raise exception 'payment_not_refundable'; end if;
  if exists (select 1 from public.commercial_payment_refunds where attempt_id = p_attempt_id and status in ('REQUESTED', 'PENDING', 'SUCCEEDED')) then raise exception 'refund_already_requested'; end if;
  insert into public.commercial_payment_refunds (attempt_id, sponsorship_id, provider, environment, amount_cents, currency, requested_by)
  values (v_a.id, v_a.sponsorship_id, v_a.provider, v_a.environment, v_a.amount_cents, v_a.currency, p_admin_id) returning * into v_r;
  perform public.sponsorship_audit(p_admin_id, 'sponsorship.provider_refund_requested', v_a.sponsorship_id, null, jsonb_build_object('refundId', v_r.id, 'attemptId', v_a.id, 'amountCents', v_r.amount_cents), null);
  return v_r;
end;
$$;

create or replace function public.commercial_refund_record(p_admin_id uuid, p_refund_id uuid, p_provider_refund_id text, p_status text, p_failure_code text)
returns public.commercial_payment_refunds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_r public.commercial_payment_refunds;
begin
  perform public.require_super_admin(p_admin_id);
  if p_status not in ('pending', 'succeeded', 'failed') then raise exception 'invalid_status'; end if;
  select * into v_r from public.commercial_payment_refunds where id = p_refund_id for update;
  if not found then raise exception 'refund_not_found'; end if;
  if v_r.status = 'SUCCEEDED' then return v_r; end if; -- final
  update public.commercial_payment_refunds set provider_refund_id = coalesce(p_provider_refund_id, provider_refund_id), failure_code = left(p_failure_code, 120),
    status = case p_status when 'succeeded' then 'SUCCEEDED' when 'pending' then 'PENDING' else 'FAILED' end where id = p_refund_id returning * into v_r;
  if p_status = 'pending' then
    -- In flight at the provider: record the intent as REFUND_PENDING (idempotent); it is NOT refunded yet.
    perform public.admin_record_sponsorship_payment_event(p_admin_id, v_r.sponsorship_id, 'REFUND_PENDING', p_provider_refund_id, 'provider refund requested', 'commercial:refund-pending:' || v_r.id)
      where (select payment_status from public.sponsorships where id = v_r.sponsorship_id) = 'PAID';
  elsif p_status = 'succeeded' then
    perform public.admin_record_sponsorship_payment_event(p_admin_id, v_r.sponsorship_id, 'REFUNDED', p_provider_refund_id, 'provider refund confirmed', 'commercial:refunded:' || v_r.id);
    update public.commercial_payment_attempts set refunded_at = now() where id = v_r.attempt_id;
  else
    perform public.sponsorship_audit(p_admin_id, 'sponsorship.provider_refund_failed', v_r.sponsorship_id, null, jsonb_build_object('refundId', v_r.id, 'code', p_failure_code), null);
  end if;
  return v_r;
end;
$$;

revoke all on function public.commercial_payment_begin(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.commercial_payment_attach(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.commercial_payment_creation_failed(uuid, text) from public, anon, authenticated;
revoke all on function public.commercial_payment_apply_result(text, text, text, text, text, uuid, text, text, text, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.commercial_refund_begin(uuid, uuid) from public, anon, authenticated;
revoke all on function public.commercial_refund_record(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.commercial_payment_begin(uuid, uuid, text, text, text) to service_role;
grant execute on function public.commercial_payment_attach(uuid, text, text, text) to service_role;
grant execute on function public.commercial_payment_creation_failed(uuid, text) to service_role;
grant execute on function public.commercial_payment_apply_result(text, text, text, text, text, uuid, text, text, text, bigint, text, text, text) to service_role;
grant execute on function public.commercial_refund_begin(uuid, uuid) to service_role;
grant execute on function public.commercial_refund_record(uuid, uuid, text, text, text) to service_role;
