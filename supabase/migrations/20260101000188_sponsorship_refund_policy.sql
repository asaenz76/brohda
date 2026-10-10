-- Sponsor refund policy, final V1 (legal closure milestone).
--
-- ONE canonical decision: public.sponsorship_refund_evaluation() answers "is this sponsorship refund-eligible, and why?" for a given cause, from the
-- canonical Game start time and the single configurable cutoff (platform_settings.sponsorship_refund_cutoff_hours, default 12). Nothing else computes it.
-- Eligibility is NEVER a refund: refunds stay explicit, audited Super Admin actions (admin_record_sponsorship_payment_event), provider-neutral.
--
-- Also here: a Sponsor may now cancel a PAID sponsorship (previously only unpaid ones) — the 12-hour rule only means something if they can — and every
-- cancellation writes an immutable decision snapshot (the kickoff and cutoff used, the eligibility result), so a later reschedule or a later change of the
-- cutoff never rewrites a past decision. Cancelling frees the inventory slot (the one-holder index only holds SUBMITTED/SCHEDULED/LIVE/SUSPENDED), whether
-- or not a refund is due; the cancelled sponsorship, its payments, acceptances and audit rows all stay.

alter table public.platform_settings
  add column sponsorship_refund_cutoff_hours integer not null default 12 check (sponsorship_refund_cutoff_hours between 0 and 720);

create table public.sponsorship_cancellations (
  id                uuid primary key default gen_random_uuid(),
  sponsorship_id    uuid not null unique references public.sponsorships (id),
  sponsor_id        uuid not null references public.sponsors (id),
  initiator         text not null check (initiator in ('SPONSOR', 'BROHDA')),
  cancelled_by      uuid not null references auth.users (id) on delete restrict,
  cancelled_at      timestamptz not null default now(),
  -- The decision, frozen at the moment of cancellation.
  kickoff_at        timestamptz not null,
  cutoff_hours      integer not null,
  cutoff_at         timestamptz not null,
  reason_code       text not null,
  refund_eligible   boolean not null,
  money_received    boolean not null,
  payment_status    text not null,
  lifecycle_before  text not null,
  review_status     text not null
);
create trigger sponsorship_cancellations_immutable before update or delete on public.sponsorship_cancellations for each row execute function public.forbid_legal_record_mutation();

alter table public.sponsorship_cancellations enable row level security;
revoke all on public.sponsorship_cancellations from public, anon, authenticated;
grant select on public.sponsorship_cancellations to authenticated;
grant all on public.sponsorship_cancellations to service_role;
create policy "sponsorship_cancellations_read" on public.sponsorship_cancellations for select to authenticated
  using (public.is_super_admin(auth.uid()) or public.is_sponsor_member(sponsor_id, auth.uid()));

-- p_reason: SPONSOR_CANCELLATION | BROHDA_REJECTED | BROHDA_CANCELLED_NO_BREACH | GAME_UNDELIVERABLE | SPONSOR_BREACH | BROHDA_LIVE_INTERRUPTION | COMPLETED_DELIVERED | BROHDA_NON_DELIVERY
create or replace function public.sponsorship_refund_evaluation(p_id uuid, p_reason text, p_now timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_kickoff timestamptz;
  v_hours integer;
  v_cutoff timestamptz;
  v_money boolean;
  v_eligible boolean;
  v_code text;
  v_choice boolean := false;
  v_options jsonb := '[]'::jsonb;
begin
  select * into v_s from public.sponsorships where id = p_id;
  if not found then raise exception 'sponsorship_not_found'; end if;
  select f.scheduled_start_utc into v_kickoff from public.fixtures f where f.id = v_s.fixture_id;
  select sponsorship_refund_cutoff_hours into v_hours from public.platform_settings where id = true;
  v_cutoff := v_kickoff - make_interval(hours => v_hours);
  v_money := v_s.payment_status in ('PAID', 'REFUND_PENDING', 'REFUNDED');

  case p_reason
    when 'SPONSOR_CANCELLATION' then
      -- The ONLY place the cutoff is applied: completed at or before kickoff minus the cutoff (so exactly T-cutoff is still eligible).
      v_eligible := p_now <= v_cutoff;
      v_code := case when v_eligible then 'SPONSOR_CANCELLED_BEFORE_CUTOFF' else 'SPONSOR_CANCELLED_INSIDE_CUTOFF' end;
    when 'BROHDA_REJECTED' then v_eligible := true; v_code := 'BROHDA_REJECTED';
    when 'BROHDA_CANCELLED_NO_BREACH' then v_eligible := true; v_choice := true; v_code := 'BROHDA_CANCELLED_NO_BREACH'; v_options := '["FULL_REFUND", "REPLACEMENT_INVENTORY"]';
    when 'GAME_UNDELIVERABLE' then v_eligible := true; v_choice := true; v_code := 'GAME_UNDELIVERABLE'; v_options := '["FULL_REFUND", "REPLACEMENT_GAME", "PRESERVE_OR_RESCHEDULE"]';
    when 'SPONSOR_BREACH' then v_eligible := false; v_code := 'SPONSOR_BREACH_NO_AUTOMATIC_REFUND';
    when 'BROHDA_LIVE_INTERRUPTION' then v_eligible := true; v_choice := true; v_code := 'BROHDA_LIVE_INTERRUPTION_UNDELIVERED_PORTION'; v_options := '["UNDELIVERED_PORTION_REFUND"]';
    when 'COMPLETED_DELIVERED' then v_eligible := false; v_code := 'COMPLETED_DELIVERED';
    when 'BROHDA_NON_DELIVERY' then v_eligible := true; v_choice := true; v_code := 'BROHDA_NON_DELIVERY'; v_options := '["FULL_REFUND", "REPLACEMENT_INVENTORY"]';
    else raise exception 'invalid_reason';
  end case;

  return jsonb_build_object(
    'eligible', v_eligible, 'reasonCode', v_code, 'reason', p_reason, 'moneyReceived', v_money,
    'kickoffAt', v_kickoff, 'cutoffHours', v_hours, 'cutoffAt', v_cutoff, 'evaluatedAt', p_now,
    'requiresChoice', v_choice, 'options', v_options);
end;
$$;
revoke all on function public.sponsorship_refund_evaluation(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.sponsorship_refund_evaluation(uuid, text, timestamptz) to service_role;

-- Records the frozen decision for a cancellation. Internal helper for the two cancel functions below.
create or replace function public.record_sponsorship_cancellation(p_s public.sponsorships, p_initiator text, p_by uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_eval jsonb;
begin
  v_eval := public.sponsorship_refund_evaluation(p_s.id, p_reason, now());
  insert into public.sponsorship_cancellations (sponsorship_id, sponsor_id, initiator, cancelled_by, kickoff_at, cutoff_hours, cutoff_at, reason_code, refund_eligible, money_received, payment_status, lifecycle_before, review_status)
  values (p_s.id, p_s.sponsor_id, p_initiator, p_by, (v_eval->>'kickoffAt')::timestamptz, (v_eval->>'cutoffHours')::integer, (v_eval->>'cutoffAt')::timestamptz, v_eval->>'reasonCode', (v_eval->>'eligible')::boolean, (v_eval->>'moneyReceived')::boolean, p_s.payment_status::text, p_s.lifecycle::text, p_s.review_status::text)
  on conflict (sponsorship_id) do nothing;
  return v_eval;
end;
$$;
revoke all on function public.record_sponsorship_cancellation(public.sponsorships, text, uuid, text) from public, anon, authenticated;
grant execute on function public.record_sponsorship_cancellation(public.sponsorships, text, uuid, text) to service_role;

-- A Sponsor cancels its own sponsorship — now including one it has PAID for. Payment is never touched here (a refund is a separate explicit action); the slot is
-- freed; the eligibility decision is frozen as of this moment.
create or replace function public.sponsor_cancel_sponsorship(p_user_id uuid, p_id uuid)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_after public.sponsorships;
  v_eval jsonb;
begin
  v_s := public.sponsor_acting_on(p_user_id, p_id);
  if v_s.lifecycle = 'CANCELLED' then return v_s; end if; -- idempotent
  if v_s.lifecycle not in ('DRAFT', 'SUBMITTED', 'SCHEDULED', 'LIVE') then raise exception 'invalid_transition'; end if;
  if v_s.lifecycle <> 'DRAFT' then v_eval := public.record_sponsorship_cancellation(v_s, 'SPONSOR', p_user_id, 'SPONSOR_CANCELLATION'); end if;
  update public.sponsorships set lifecycle = 'CANCELLED', payment_status = case when payment_status in ('PENDING') then 'CANCELLED' else payment_status end,
    cancelled_by = p_user_id, cancelled_at = now(), cancellation_reason = 'cancelled by sponsor'
  where id = p_id returning * into v_after;
  perform public.sponsorship_audit(p_user_id, 'sponsorship.cancelled', p_id, public.sponsorship_state_json(v_s),
    public.sponsorship_state_json(v_after) || coalesce(jsonb_build_object('refundDecision', v_eval), '{}'::jsonb), 'cancelled by sponsor');
  if v_eval is not null then
    perform public.sponsorship_audit(p_user_id, 'sponsorship.refund_eligibility_decided', p_id, null, v_eval, v_eval->>'reasonCode');
  end if;
  return v_after;
end;
$$;

-- Brohda cancels: Super Admin states the CAUSE (it decides eligibility; the Sponsor's 12-hour rule never applies to a Brohda-caused cancellation).
drop function if exists public.admin_cancel_sponsorship(uuid, uuid, text);
create or replace function public.admin_cancel_sponsorship(p_admin_id uuid, p_id uuid, p_reason text, p_cause text default 'BROHDA_CANCELLED_NO_BREACH')
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_after public.sponsorships;
  v_eval jsonb;
begin
  perform public.require_super_admin(p_admin_id);
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason_required'; end if;
  if p_cause not in ('BROHDA_CANCELLED_NO_BREACH', 'SPONSOR_BREACH', 'GAME_UNDELIVERABLE', 'BROHDA_NON_DELIVERY') then raise exception 'invalid_reason'; end if;
  v_s := public.sponsorship_lock(p_id);
  if v_s.lifecycle = 'CANCELLED' then return v_s; end if; -- idempotent
  if v_s.lifecycle in ('COMPLETED', 'REJECTED') then raise exception 'invalid_transition'; end if;
  if v_s.lifecycle <> 'DRAFT' then v_eval := public.record_sponsorship_cancellation(v_s, 'BROHDA', p_admin_id, p_cause); end if;
  -- History is kept: the payment status is NOT rewritten for money that was received (that is resolved through payment events); only unpaid ones close out.
  update public.sponsorships set lifecycle = 'CANCELLED', cancelled_by = p_admin_id, cancelled_at = now(), cancellation_reason = btrim(p_reason),
    payment_status = case when payment_status in ('UNPAID', 'PENDING', 'FAILED') then 'CANCELLED' else payment_status end
  where id = p_id returning * into v_after;
  perform public.sponsorship_audit(p_admin_id, 'sponsorship.cancelled', p_id, public.sponsorship_state_json(v_s),
    public.sponsorship_state_json(v_after) || coalesce(jsonb_build_object('refundDecision', v_eval), '{}'::jsonb), btrim(p_reason));
  if v_eval is not null then
    perform public.sponsorship_audit(p_admin_id, 'sponsorship.refund_eligibility_decided', p_id, null, v_eval, v_eval->>'reasonCode');
  end if;
  return v_after;
end;
$$;
revoke all on function public.admin_cancel_sponsorship(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_cancel_sponsorship(uuid, uuid, text, text) to service_role;
