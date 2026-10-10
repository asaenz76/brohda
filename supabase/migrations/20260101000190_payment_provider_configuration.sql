-- Payment provider configuration (corrective milestone): the provider is OPERATIONAL CONFIGURATION, not schema.
--
-- 1. `commercial_payment_attempts.provider` was constrained to the single value 'ONVO', so adding or switching a provider needed a migration. The constraint is replaced
--    by a provider-neutral identifier format. WHICH keys are valid is decided by the application's provider registry (the only place that knows which adapters exist);
--    the database just refuses nonsense. Historical rows keep the provider that processed them — nothing is rewritten.
-- 2. Two platform settings carry the business policy: whether online sponsorship payments are on, and which registered provider is active. Secrets are NOT here (they stay in the
--    hosting environment). Changing them needs no deploy and no migration.
-- 3. Switching providers with an open attempt never converts or supersedes it: an open attempt stays with the provider that created it.

alter table public.commercial_payment_attempts drop constraint if exists commercial_payment_attempts_provider_check;
alter table public.commercial_payment_attempts add constraint commercial_payment_attempts_provider_format check (provider ~ '^[A-Z][A-Z0-9_]{1,39}$');

alter table public.platform_settings
  add column sponsorship_online_payments_enabled boolean not null default false,
  add column sponsorship_online_payment_provider text check (sponsorship_online_payment_provider is null or sponsorship_online_payment_provider ~ '^[A-Z][A-Z0-9_]{1,39}$');
comment on column public.platform_settings.sponsorship_online_payments_enabled is 'Online sponsorship payments on/off. Off = no NEW online attempts; existing attempts, webhooks and reconciliation keep working. Manual payment is independent.';
comment on column public.platform_settings.sponsorship_online_payment_provider is 'The active provider key for NEW online sponsorship payments. Must be a provider registered in the application; an unknown key fails closed. No secrets live here.';

-- Super Admin sets the online-payment policy. Audited (provider and on/off only — never a secret). The application validates the key against its registry before calling this.
create or replace function public.admin_set_online_payment_config(p_admin_id uuid, p_enabled boolean, p_provider text)
returns public.platform_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.platform_settings;
  v_after public.platform_settings;
begin
  perform public.require_super_admin(p_admin_id);
  if p_provider is not null and p_provider !~ '^[A-Z][A-Z0-9_]{1,39}$' then raise exception 'invalid_provider'; end if;
  if p_enabled and p_provider is null then raise exception 'provider_required'; end if;
  select * into v_before from public.platform_settings where id = true for update;
  update public.platform_settings set sponsorship_online_payments_enabled = p_enabled, sponsorship_online_payment_provider = p_provider, updated_at = now(), updated_by = p_admin_id
    where id = true returning * into v_after;
  if v_before.sponsorship_online_payments_enabled is distinct from v_after.sponsorship_online_payments_enabled
     or v_before.sponsorship_online_payment_provider is distinct from v_after.sponsorship_online_payment_provider then
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
    values (p_admin_id, 'settings.online_payments_updated', 'platform_settings', null,
      jsonb_build_object('enabled', v_before.sponsorship_online_payments_enabled, 'provider', v_before.sponsorship_online_payment_provider),
      jsonb_build_object('enabled', v_after.sponsorship_online_payments_enabled, 'provider', v_after.sponsorship_online_payment_provider));
  end if;
  return v_after;
end;
$$;
revoke all on function public.admin_set_online_payment_config(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.admin_set_online_payment_config(uuid, boolean, text) to service_role;

-- Starting a payment: an open attempt that belongs to ANOTHER provider is never converted or retired by a provider switch. The new attempt waits until it is terminal
-- (reconciled / expired / failed) or Super Admin cancels it explicitly. (Same provider and a changed price still supersede, exactly as before.)
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
  v_s := public.sponsor_acting_on(p_user_id, p_id);
  if v_s.lifecycle <> 'SUBMITTED' then raise exception 'sponsorship_not_payable'; end if;
  if v_s.payment_status = 'PAID' then raise exception 'already_paid'; end if;
  if v_s.payment_status not in ('PENDING', 'FAILED') then raise exception 'sponsorship_not_payable'; end if;
  if v_s.price_cents is null or v_s.price_cents <= 0 or v_s.currency is null then raise exception 'price_missing'; end if;

  select * into v_a from public.commercial_payment_attempts where sponsorship_id = p_id and status in ('CREATED', 'PENDING') for update;
  if found then
    if v_a.provider <> p_provider then raise exception 'open_attempt_other_provider'; end if;
    if v_a.environment = p_environment and v_a.amount_cents = v_s.price_cents and v_a.currency = v_s.currency then return v_a; end if;
    update public.commercial_payment_attempts set status = 'SUPERSEDED' where id = v_a.id;
  end if;

  insert into public.commercial_payment_attempts (sponsorship_id, sponsor_id, provider, environment, amount_cents, currency, idempotency_key, created_by)
  values (p_id, v_s.sponsor_id, p_provider, p_environment, v_s.price_cents, v_s.currency, p_idempotency_key, p_user_id)
  on conflict (idempotency_key) do nothing
  returning * into v_a;
  if v_a.id is null then select * into v_a from public.commercial_payment_attempts where idempotency_key = p_idempotency_key; end if;
  if v_a.sponsorship_id is distinct from p_id then raise exception 'idempotency_conflict'; end if;
  perform public.sponsorship_audit(p_user_id, 'sponsorship.payment_attempt_created', p_id, null, jsonb_build_object('provider', p_provider, 'environment', p_environment, 'amountCents', v_a.amount_cents, 'currency', v_a.currency, 'attemptId', v_a.id), null);
  return v_a;
end;
$$;

-- Super Admin explicitly closes an open attempt (e.g. to move a Sponsor onto a newly active provider). The attempt stays on record and, if the provider later reports it paid, the
-- success is still recognised (or flagged) — it is never lost.
create or replace function public.commercial_payment_cancel_attempt(p_admin_id uuid, p_attempt_id uuid)
returns public.commercial_payment_attempts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_a public.commercial_payment_attempts;
begin
  perform public.require_super_admin(p_admin_id);
  select * into v_a from public.commercial_payment_attempts where id = p_attempt_id for update;
  if not found then raise exception 'payment_not_found'; end if;
  if v_a.status not in ('CREATED', 'PENDING') then return v_a; end if;
  update public.commercial_payment_attempts set status = 'CANCELLED' where id = p_attempt_id returning * into v_a;
  perform public.sponsorship_audit(p_admin_id, 'sponsorship.payment_attempt_cancelled', v_a.sponsorship_id, null, jsonb_build_object('attemptId', v_a.id, 'provider', v_a.provider), null);
  return v_a;
end;
$$;
revoke all on function public.commercial_payment_cancel_attempt(uuid, uuid) from public, anon, authenticated;
grant execute on function public.commercial_payment_cancel_attempt(uuid, uuid) to service_role;
