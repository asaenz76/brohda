-- Pricing is Super Admin's, end to end.
--
-- A sponsor already cannot set or change a price: the sponsor-facing functions take no price, the edit whitelist excludes it, and the tables grant sponsors SELECT only.
-- What was missing is that a price a Super Admin deliberately set on a sponsorship BEFORE it was submitted (a negotiated price on an assigned draft) was thrown away at
-- submission, which re-snapshots the inventory price for anything not yet paid. This records that the Super Admin set the price (`price_overridden`) and makes both submit
-- functions keep it; absent an override the price is still the inventory's, snapshotted at submission. Once paid, the price stays frozen exactly as before.
alter table public.sponsorships add column price_overridden boolean not null default false;
comment on column public.sponsorships.price_overridden is
  'True when a Super Admin set this sponsorship''s price (and currency) explicitly; submission then keeps it instead of re-snapshotting the inventory price. Only admin_set_sponsorship_price writes it.';

create or replace function public.admin_set_sponsorship_price(p_admin_id uuid, p_id uuid, p_price_cents integer)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_inv_currency text;
  v_after public.sponsorships;
begin
  perform public.require_super_admin(p_admin_id);
  v_s := public.sponsorship_lock(p_id);
  if v_s.price_cents is not distinct from p_price_cents and v_s.price_overridden then return v_s; end if; -- idempotent
  -- Only before commercial commitment: once paid the agreed price is a frozen snapshot.
  if v_s.payment_status not in ('UNPAID', 'PENDING', 'FAILED') or v_s.lifecycle not in ('DRAFT', 'SUBMITTED') then raise exception 'price_locked'; end if;
  select currency into v_inv_currency from public.sponsorship_inventory where id = v_s.inventory_id;
  update public.sponsorships set price_cents = p_price_cents, currency = coalesce(currency, v_inv_currency), price_overridden = true where id = p_id returning * into v_after;
  perform public.sponsorship_audit(p_admin_id, 'sponsorship.price_set', p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), null);
  return v_after;
end;
$$;
revoke all on function public.admin_set_sponsorship_price(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.admin_set_sponsorship_price(uuid, uuid, integer) to service_role;

create or replace function public.sponsor_submit_sponsorship(p_user_id uuid, p_id uuid)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_inv public.sponsorship_inventory;
  v_after public.sponsorships;
  v_resubmit boolean;
begin
  v_s := public.sponsor_acting_on(p_user_id, p_id);
  v_resubmit := (v_s.lifecycle = 'SUBMITTED' and v_s.review_status = 'CHANGES_REQUESTED');
  if not (v_s.lifecycle = 'DRAFT' or v_resubmit) then raise exception 'invalid_transition'; end if;

  if v_s.presented_by is null or v_s.destination_url is null or v_s.logo_path is null then raise exception 'incomplete_sponsorship'; end if;
  if v_s.has_promotion and (v_s.promotion_title is null or v_s.promotion_description is null or v_s.official_rules_url is null or v_s.promotion_fulfillment_name is null) then
    raise exception 'incomplete_promotion';
  end if;

  select * into v_inv from public.sponsorship_inventory where id = v_s.inventory_id for update;
  if not found or not v_inv.is_sponsorable or v_inv.ends_at <= now() then raise exception 'inventory_unavailable'; end if;
  perform public.release_stale_sponsorship_reservations(now(), v_inv.id);

  begin
    update public.sponsorships set
      lifecycle = 'SUBMITTED',
      review_status = 'PENDING',
      payment_status = case when payment_status = 'PAID' then payment_status else 'PENDING' end,
      -- the price is never the sponsor's: a Super Admin's explicit price (or a paid one) is kept; otherwise the inventory's price is snapshotted
      price_cents = case when payment_status = 'PAID' or price_overridden then price_cents else v_inv.price_cents end,
      currency = case when payment_status = 'PAID' or price_overridden then coalesce(currency, v_inv.currency) else v_inv.currency end,
      starts_at = v_inv.starts_at,
      ends_at = v_inv.ends_at,
      revision = revision + 1,
      submitted_at = now(),
      review_note = null
    where id = p_id
    returning * into v_after;
  exception when unique_violation then
    raise exception 'inventory_unavailable';
  end;

  if v_s.payment_status <> 'PAID' then
    insert into public.sponsorship_payment_events (sponsorship_id, event_type, amount_cents, currency, actor_id, idempotency_key)
    values (p_id, 'PAYMENT_PENDING', v_after.price_cents, v_after.currency, p_user_id, 'submit:' || p_id::text || ':' || v_after.revision::text)
    on conflict (idempotency_key) do nothing;
  end if;
  perform public.sponsorship_audit(p_user_id, case when v_resubmit then 'sponsorship.resubmitted' else 'sponsorship.submitted' end, p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), null);
  return v_after;
end;
$$;
revoke all on function public.sponsor_submit_sponsorship(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sponsor_submit_sponsorship(uuid, uuid) to service_role;

create or replace function public.admin_submit_sponsorship(p_admin_id uuid, p_id uuid)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_inv public.sponsorship_inventory;
  v_sponsor_status public.sponsor_status;
  v_after public.sponsorships;
  v_resubmit boolean;
begin
  perform public.require_super_admin(p_admin_id);
  v_s := public.sponsorship_lock(p_id);
  select status into v_sponsor_status from public.sponsors where id = v_s.sponsor_id;
  if v_sponsor_status <> 'ACTIVE' then raise exception 'sponsor_not_active'; end if;
  v_resubmit := (v_s.lifecycle = 'SUBMITTED' and v_s.review_status = 'CHANGES_REQUESTED');
  if not (v_s.lifecycle = 'DRAFT' or v_resubmit) then raise exception 'invalid_transition'; end if;

  if v_s.presented_by is null or v_s.destination_url is null or v_s.logo_path is null then raise exception 'incomplete_sponsorship'; end if;
  if v_s.has_promotion and (v_s.promotion_title is null or v_s.promotion_description is null or v_s.official_rules_url is null or v_s.promotion_fulfillment_name is null) then
    raise exception 'incomplete_promotion';
  end if;

  select * into v_inv from public.sponsorship_inventory where id = v_s.inventory_id for update;
  if not found or not v_inv.is_sponsorable or v_inv.ends_at <= now() then raise exception 'inventory_unavailable'; end if;
  perform public.release_stale_sponsorship_reservations(now(), v_inv.id);

  begin
    update public.sponsorships set
      lifecycle = 'SUBMITTED',
      review_status = 'PENDING',
      payment_status = case when payment_status = 'PAID' then payment_status else 'PENDING' end,
      price_cents = case when payment_status = 'PAID' or price_overridden then price_cents else v_inv.price_cents end,
      currency = case when payment_status = 'PAID' or price_overridden then coalesce(currency, v_inv.currency) else v_inv.currency end,
      starts_at = v_inv.starts_at,
      ends_at = v_inv.ends_at,
      revision = revision + 1,
      submitted_at = now(),
      review_note = null
    where id = p_id
    returning * into v_after;
  exception when unique_violation then
    raise exception 'inventory_unavailable';
  end;

  if v_s.payment_status <> 'PAID' then
    insert into public.sponsorship_payment_events (sponsorship_id, event_type, amount_cents, currency, actor_id, idempotency_key)
    values (p_id, 'PAYMENT_PENDING', v_after.price_cents, v_after.currency, p_admin_id, 'submit:' || p_id::text || ':' || v_after.revision::text)
    on conflict (idempotency_key) do nothing;
  end if;
  perform public.sponsorship_audit(p_admin_id, case when v_resubmit then 'sponsorship.resubmitted_by_admin' else 'sponsorship.submitted_by_admin' end, p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), 'submitted by Super Admin on behalf of the sponsor');
  return v_after;
end;
$$;
revoke all on function public.admin_submit_sponsorship(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_submit_sponsorship(uuid, uuid) to service_role;
