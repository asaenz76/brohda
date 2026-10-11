-- Sponsor link fallback + optional destination URL (r68).
--
-- PRODUCT RULE: the campaign destination link is OPTIONAL. Where a sponsored Game Post links is resolved as
--     the sponsorship's own destination_url  ??  the Sponsor profile website (sponsors.website)  ??  no link.
-- The sponsor name/logo attribution is clickable whenever an effective link exists; with none, nothing is clickable (and no broken link or empty click is ever produced).
--
-- What this migration does, and only this:
--  1. Removes ONLY the "destination must exist" requirement from the two submit functions. destination_url keeps its nullable column, its is_safe_http_url check and its place in
--     the material hash (a campaign-specific link change is still a material change that voids approval).
--  2. ONE SQL rule for the fallback: sponsorship_effective_destination(). The sponsors.website value is NOT copied into each sponsorship.
--  3. APPROVAL INTEGRITY. A sponsorship that falls back to the profile website must not silently move when the profile is edited after approval. The effective destination is frozen
--     into sponsorships.approved_destination_url (and the approval snapshot) at approval, cleared with the approval if a material change voids it, and the public click path serves
--     ONLY that frozen value. Before approval the fallback follows the current profile website. Approving can also assert the destination the reviewer saw (p_expected_destination):
--     if the profile website changed since, the approval is refused with destination_changed.
--  4. The public eligibility view gains has_link (a frozen destination exists) so the public line can render without ever reading the profile.
-- Existing approved sponsorships are backfilled with what they already used (their own destination_url), so nothing about live behavior changes. Forward-only, additive.

alter table public.sponsorships
  add column approved_destination_url text check (approved_destination_url is null or public.is_safe_http_url(approved_destination_url));
comment on column public.sponsorships.approved_destination_url is
  'The effective destination (own destination_url, else the Sponsor profile website) frozen at approval. The only value the public click path serves; cleared when a material change voids the approval.';

create or replace function public.sponsorship_effective_destination(s public.sponsorships)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(s.destination_url, (select sp.website from public.sponsors sp where sp.id = s.sponsor_id));
$$;
revoke all on function public.sponsorship_effective_destination(public.sponsorships) from public, anon, authenticated;
grant execute on function public.sponsorship_effective_destination(public.sponsorships) to service_role;

-- Backfill: what an already-approved sponsorship used (its own destination — required before this change).
update public.sponsorships s set approved_destination_url = public.sponsorship_effective_destination(s)
  where s.review_status = 'APPROVED' and s.approved_destination_url is null;

-- The guard also clears the frozen destination when a material change voids an approval.
create or replace function public.sponsorships_guard()
returns trigger
language plpgsql
as $$
begin
  if new.sponsor_id is distinct from old.sponsor_id
     or new.inventory_id is distinct from old.inventory_id
     or new.post_id is distinct from old.post_id
     or new.fixture_id is distinct from old.fixture_id
     or new.market_code is distinct from old.market_code then
    raise exception 'sponsorship identity (sponsor, inventory, post, game, market) is immutable';
  end if;

  if old.payment_status = 'PAID' and (new.price_cents is distinct from old.price_cents or new.currency is distinct from old.currency) then
    raise exception 'the agreed price of a paid sponsorship is immutable';
  end if;

  if old.review_status = 'APPROVED'
     and public.sponsorship_material_hash(new) is distinct from public.sponsorship_material_hash(old) then
    new.review_status := 'PENDING';
    new.approved_hash := null;
    new.approved_by := null;
    new.approved_at := null;
    new.approved_destination_url := null; -- the frozen destination goes with the approval it belonged to
    if new.lifecycle in ('SCHEDULED', 'LIVE') then
      new.lifecycle := 'SUBMITTED';
    end if;
  end if;
  return new;
end;
$$;

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

  if v_s.presented_by is null or v_s.logo_path is null then raise exception 'incomplete_sponsorship'; end if; -- the destination link is OPTIONAL (r68): the Sponsor profile website is the fallback
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

  if v_s.presented_by is null or v_s.logo_path is null then raise exception 'incomplete_sponsorship'; end if; -- the destination link is OPTIONAL (r68): the Sponsor profile website is the fallback
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

drop function if exists public.admin_approve_sponsorship(uuid, uuid, integer);
create or replace function public.admin_approve_sponsorship(p_admin_id uuid, p_id uuid, p_expected_revision integer, p_expected_destination text default null)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_after public.sponsorships;
  v_sponsor_status public.sponsor_status;
  v_post_published boolean;
  v_fixture_status text;
  v_hash text;
  v_effective text;
begin
  perform public.require_super_admin(p_admin_id);
  v_s := public.sponsorship_lock(p_id);
  v_hash := public.sponsorship_material_hash(v_s);
  -- Double-click / retry: already approved as currently written -> nothing changes, nothing is audited twice.
  if v_s.review_status = 'APPROVED' and v_s.approved_hash = v_hash then return v_s; end if;
  if v_s.revision <> p_expected_revision then raise exception 'stale_revision'; end if; -- the sponsor changed it while it was being reviewed
  -- Where members will be sent is part of what is being approved. When the reviewer says what they saw ('' = no link), it must still be what applies now: a Sponsor profile edit
  -- between the review screen and the click cannot slip a different destination through.
  v_effective := public.sponsorship_effective_destination(v_s);
  if p_expected_destination is not null and coalesce(v_effective, '') <> p_expected_destination then raise exception 'destination_changed'; end if;
  if v_s.lifecycle <> 'SUBMITTED' or v_s.review_status <> 'PENDING' then raise exception 'invalid_transition'; end if;
  if v_s.ends_at <= now() then raise exception 'campaign_window_passed'; end if;

  select status into v_sponsor_status from public.sponsors where id = v_s.sponsor_id;
  if v_sponsor_status <> 'ACTIVE' then raise exception 'sponsor_not_active'; end if;
  select (p.published_at is not null), f.internal_status::text into v_post_published, v_fixture_status
    from public.posts p join public.fixtures f on f.id = p.fixture_id where p.id = v_s.post_id;
  if not coalesce(v_post_published, false) or v_fixture_status in ('CANCELLED', 'ABANDONED') then raise exception 'post_not_valid'; end if;

  update public.sponsorships set review_status = 'APPROVED', approved_by = p_admin_id, approved_at = now(), approved_hash = v_hash, approved_destination_url = v_effective,
    rejected_by = null, rejected_at = null, rejection_reason = null, review_note = null
  where id = p_id returning * into v_after;

  insert into public.sponsorship_approvals (sponsorship_id, revision, content_hash, snapshot, approved_by)
  values (p_id, v_after.revision, v_hash, jsonb_build_object(
    'sponsorId', v_after.sponsor_id, 'postId', v_after.post_id, 'fixtureId', v_after.fixture_id, 'marketCode', v_after.market_code,
    'presentedBy', v_after.presented_by, 'tagline', v_after.tagline, 'ctaText', v_after.cta_text, 'destinationUrl', v_after.destination_url, 'effectiveDestinationUrl', v_effective, 'destinationSource', case when v_after.destination_url is not null then 'CAMPAIGN' when v_effective is not null then 'SPONSOR_PROFILE' else 'NONE' end, 'logoPath', v_after.logo_path,
    'hasPromotion', v_after.has_promotion, 'promotionTitle', v_after.promotion_title, 'promotionDescription', v_after.promotion_description,
    'prizeDescription', v_after.prize_description, 'officialRulesUrl', v_after.official_rules_url, 'promotionDestinationUrl', v_after.promotion_destination_url,
    'promotionFulfillmentName', v_after.promotion_fulfillment_name, 'promotionEligibilitySummary', v_after.promotion_eligibility_summary,
    'promotionStartsAt', v_after.promotion_starts_at, 'promotionEndsAt', v_after.promotion_ends_at,
    'priceCents', v_after.price_cents, 'currency', v_after.currency, 'startsAt', v_after.starts_at, 'endsAt', v_after.ends_at
  ), p_admin_id)
  on conflict (sponsorship_id, revision) do nothing;

  -- Approval alone never publishes: it needs payment too. If payment already stands, the sponsorship moves onto the clock.
  if v_after.payment_status = 'PAID' then
    update public.sponsorships set lifecycle = public.sponsorship_scheduled_lifecycle(v_after, now()),
      completed_at = case when now() >= v_after.ends_at then now() else completed_at end
    where id = p_id returning * into v_after;
  end if;
  perform public.sponsorship_audit(p_admin_id, 'sponsorship.approved', p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), null);
  return v_after;
end;
$$;
revoke all on function public.admin_approve_sponsorship(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.admin_approve_sponsorship(uuid, uuid, integer, text) to service_role;

create or replace view public.sponsorship_eligibility_inputs as
select
  s.id,
  s.post_id,
  s.market_code,
  s.lifecycle,
  s.payment_status,
  s.review_status,
  s.starts_at,
  s.ends_at,
  (s.approved_hash is not null and s.approved_hash = public.sponsorship_material_hash(s)) as approval_intact,
  sp.status as sponsor_status,
  (p.published_at is not null) as post_published,
  f.internal_status::text as fixture_status,
  s.presented_by,
  s.tagline,
  s.cta_text,
  (s.destination_url is not null) as has_destination,
  s.logo_path,
  s.has_promotion,
  s.promotion_title,
  s.promotion_description,
  s.prize_description,
  s.official_rules_url,
  s.promotion_destination_url,
  s.promotion_fulfillment_name,
  s.promotion_eligibility_summary,
  s.promotion_starts_at,
  s.promotion_ends_at,
  (s.approved_destination_url is not null) as has_link
from public.sponsorships s
join public.sponsors sp on sp.id = s.sponsor_id
join public.posts p on p.id = s.post_id
join public.fixtures f on f.id = s.fixture_id;
revoke all on public.sponsorship_eligibility_inputs from public, anon, authenticated;
grant select on public.sponsorship_eligibility_inputs to service_role;
