-- Super Admin can assign a sponsorable Game to a sponsor (the manual-sales path: Brohda agrees the deal off-platform, then sets it up).
--
-- It creates the same DRAFT sponsorship a sponsor would create for themselves — owned by the sponsor, who then completes the details and submits it —
-- so every later rule is unchanged: nothing is public until it is PAID and approved by a Super Admin, the price comes from the inventory snapshot at
-- submission, one sponsor holds a slot, and the audit log records who assigned it. A draft holds no inventory; it only appears in the sponsor's own list.
-- Unlike the sponsor-facing create, this is an operator action, so it does not depend on the Sponsored Game Posts switch (a sponsor still cannot edit or submit
-- while the switch is OFF).
create or replace function public.admin_assign_sponsorship(p_admin_id uuid, p_sponsor_id uuid, p_inventory_id uuid, p_campaign_name text)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sponsor public.sponsors;
  v_inv public.sponsorship_inventory;
  v_s public.sponsorships;
begin
  perform public.require_super_admin(p_admin_id);
  select * into v_sponsor from public.sponsors where id = p_sponsor_id;
  if not found or v_sponsor.status <> 'ACTIVE' then raise exception 'sponsor_not_active'; end if;
  -- Serialise concurrent assignments of the same slot (a double click, or two operators): the second waits, then sees the first's draft.
  select * into v_inv from public.sponsorship_inventory where id = p_inventory_id for update;
  if not found or not v_inv.is_sponsorable or v_inv.ends_at <= now() then raise exception 'inventory_unavailable'; end if;
  -- Already held by a submitted / scheduled / live / suspended sponsorship: nothing to assign.
  if exists (select 1 from public.sponsorships where inventory_id = p_inventory_id and lifecycle in ('SUBMITTED', 'SCHEDULED', 'LIVE', 'SUSPENDED')) then
    raise exception 'inventory_unavailable';
  end if;
  -- Idempotent: this sponsor already has an open draft for this slot -> return it instead of creating a second.
  select * into v_s from public.sponsorships where inventory_id = p_inventory_id and sponsor_id = p_sponsor_id and lifecycle = 'DRAFT' order by created_at limit 1;
  if found then return v_s; end if;

  insert into public.sponsorships (sponsor_id, inventory_id, post_id, fixture_id, market_code, created_by, campaign_name, presented_by, logo_path, starts_at, ends_at)
  values (p_sponsor_id, v_inv.id, v_inv.post_id, v_inv.fixture_id, v_inv.market_code, p_admin_id, left(btrim(coalesce(nullif(p_campaign_name, ''), 'Sponsorship')), 120), v_sponsor.display_name, v_sponsor.logo_path, v_inv.starts_at, v_inv.ends_at)
  returning * into v_s;

  perform public.sponsorship_audit(p_admin_id, 'sponsorship.assigned', v_s.id, null, public.sponsorship_state_json(v_s) || jsonb_build_object('sponsorId', p_sponsor_id), 'assigned by Super Admin');
  return v_s;
end;
$$;
revoke all on function public.admin_assign_sponsorship(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_assign_sponsorship(uuid, uuid, uuid, text) to service_role;
