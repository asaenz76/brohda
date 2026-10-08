-- Super Admin can complete and submit a sponsorship ON BEHALF of a sponsor (manual sales: Brohda agrees the deal off-platform and may set the whole thing up, including
-- when the sponsor has no member account yet). Until it is SUBMITTED a sponsorship has no price snapshot, no hold and no payment record, so "mark payment received" and
-- "approve" are impossible by design (admin_mark_sponsorship_paid / admin_approve_sponsorship require SUBMITTED); these two functions are the missing step.
--
-- Same rules as the sponsor's own functions, with the actor being a Super Admin instead of a member: the same editable states (DRAFT, or a submission sent back for changes),
-- the same completeness checks, the same price snapshot from the inventory, the same one-sponsor-per-slot hold, the same audit. They do NOT approve, mark paid or publish —
-- those stay separate, explicit Super Admin actions, and the CHECK constraint still requires PAID + APPROVED for anything public.
create or replace function public.admin_update_sponsorship(p_admin_id uuid, p_id uuid, p_fields jsonb)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_logo text;
  v_after public.sponsorships;
begin
  perform public.require_super_admin(p_admin_id);
  v_s := public.sponsorship_lock(p_id);
  if not (v_s.lifecycle = 'DRAFT' or (v_s.lifecycle = 'SUBMITTED' and v_s.review_status = 'CHANGES_REQUESTED')) then
    raise exception 'not_editable';
  end if;
  select logo_path into v_logo from public.sponsors where id = v_s.sponsor_id;

  update public.sponsorships set
    campaign_name = case when p_fields ? 'campaign_name' then coalesce(nullif(btrim(p_fields->>'campaign_name'), ''), campaign_name) else campaign_name end,
    presented_by = case when p_fields ? 'presented_by' then nullif(btrim(p_fields->>'presented_by'), '') else presented_by end,
    tagline = case when p_fields ? 'tagline' then nullif(btrim(p_fields->>'tagline'), '') else tagline end,
    cta_text = case when p_fields ? 'cta_text' then nullif(btrim(p_fields->>'cta_text'), '') else cta_text end,
    destination_url = case when p_fields ? 'destination_url' then nullif(btrim(p_fields->>'destination_url'), '') else destination_url end,
    logo_path = v_logo,
    has_promotion = case when p_fields ? 'has_promotion' then coalesce((p_fields->>'has_promotion')::boolean, false) else has_promotion end,
    promotion_title = case when p_fields ? 'promotion_title' then nullif(btrim(p_fields->>'promotion_title'), '') else promotion_title end,
    promotion_description = case when p_fields ? 'promotion_description' then nullif(btrim(p_fields->>'promotion_description'), '') else promotion_description end,
    prize_description = case when p_fields ? 'prize_description' then nullif(btrim(p_fields->>'prize_description'), '') else prize_description end,
    official_rules_url = case when p_fields ? 'official_rules_url' then nullif(btrim(p_fields->>'official_rules_url'), '') else official_rules_url end,
    promotion_destination_url = case when p_fields ? 'promotion_destination_url' then nullif(btrim(p_fields->>'promotion_destination_url'), '') else promotion_destination_url end,
    promotion_fulfillment_name = case when p_fields ? 'promotion_fulfillment_name' then nullif(btrim(p_fields->>'promotion_fulfillment_name'), '') else promotion_fulfillment_name end,
    promotion_eligibility_summary = case when p_fields ? 'promotion_eligibility_summary' then nullif(btrim(p_fields->>'promotion_eligibility_summary'), '') else promotion_eligibility_summary end,
    promotion_starts_at = case when p_fields ? 'promotion_starts_at' then nullif(p_fields->>'promotion_starts_at', '')::timestamptz else promotion_starts_at end,
    promotion_ends_at = case when p_fields ? 'promotion_ends_at' then nullif(p_fields->>'promotion_ends_at', '')::timestamptz else promotion_ends_at end
  where id = p_id
  returning * into v_after;

  perform public.sponsorship_audit(p_admin_id, 'sponsorship.updated_by_admin', p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), 'edited by Super Admin on behalf of the sponsor');
  return v_after;
end;
$$;
revoke all on function public.admin_update_sponsorship(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_update_sponsorship(uuid, uuid, jsonb) to service_role;

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
      price_cents = case when payment_status = 'PAID' then price_cents else v_inv.price_cents end,
      currency = case when payment_status = 'PAID' then currency else v_inv.currency end,
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
