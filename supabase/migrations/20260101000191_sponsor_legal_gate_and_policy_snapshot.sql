-- Sponsor legal activation support (r67). Two things the legal gates need from the database, and nothing else:
--
-- 1. THE REFUND POLICY IN FORCE IS FROZEN ON EACH SPONSORSHIP. The refund cutoff (platform_settings.sponsorship_refund_cutoff_hours) is operational configuration, but the
--    cutoff a Sponsor was told about when it submitted is part of what it agreed to. Before this migration, changing the setting would silently re-decide every existing
--    Sponsorship (an eligibility check reads the setting live). Now the value in force is copied onto the sponsorship the first time it leaves DRAFT (or is created outside
--    DRAFT), is immutable afterwards, and `sponsorship_refund_evaluation` uses it. A later change of the setting only affects Sponsorships submitted AFTER it. Existing
--    non-draft rows are backfilled with the value in force today (12) — the only value that was ever in force, so no past decision changes.
--
-- 2. A SPONSOR CAN ACCEPT THE MEDIA AGREEMENT FOR AN ALREADY-SUBMITTED CAMPAIGN. Acceptance at submit already exists (sponsor_submit_with_agreement). A campaign submitted
--    before an agreement was approved, or whose content changed after it was accepted (a new revision), needs a way to accept without being forced to resubmit. The
--    server records the acceptance for the CURRENT revision and content hash, exactly like the submit path; nothing about the document comes from the browser.
--
-- Provider-neutral. No payment behaviour changes here.

alter table public.sponsorships
  add column refund_cutoff_hours_agreed integer check (refund_cutoff_hours_agreed is null or refund_cutoff_hours_agreed between 0 and 720);

comment on column public.sponsorships.refund_cutoff_hours_agreed is
  'The Sponsor refund cutoff (hours before kickoff) in force when this sponsorship first left DRAFT. Frozen: a later change of platform_settings.sponsorship_refund_cutoff_hours never re-decides it.';

create or replace function public.sponsorships_policy_snapshot()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and old.refund_cutoff_hours_agreed is not null and new.refund_cutoff_hours_agreed is distinct from old.refund_cutoff_hours_agreed then
    raise exception 'the refund policy in force for a sponsorship is immutable';
  end if;
  if new.refund_cutoff_hours_agreed is null and new.lifecycle <> 'DRAFT' then
    select sponsorship_refund_cutoff_hours into new.refund_cutoff_hours_agreed from public.platform_settings where id = true;
  end if;
  return new;
end;
$$;
create trigger sponsorships_policy_snapshot before insert or update on public.sponsorships for each row execute function public.sponsorships_policy_snapshot();

-- Backfill (fires the trigger above, which fills the value from the setting in force today).
update public.sponsorships set updated_at = updated_at where lifecycle <> 'DRAFT' and refund_cutoff_hours_agreed is null;

-- The one canonical eligibility decision, now reading the sponsorship's own frozen cutoff (the live setting only for a still-DRAFT sponsorship, which has promised nothing).
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
  v_hours := coalesce(v_s.refund_cutoff_hours_agreed, (select sponsorship_refund_cutoff_hours from public.platform_settings where id = true));
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

-- Accept the media agreement for an already-submitted campaign (the current revision). Ownership, ACTIVE Sponsor and capability are checked by sponsor_acting_on, exactly as
-- for every other Sponsor action; the revision, content hash, price, window and payment state are read from the row itself. A repeat for the same revision/version is a no-op.
create or replace function public.sponsor_accept_agreement(p_user_id uuid, p_id uuid, p_agreement_key text, p_agreement_version text, p_terms_key text, p_terms_version text)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_inserted integer;
begin
  v_s := public.sponsor_acting_on(p_user_id, p_id);
  if v_s.lifecycle <> 'SUBMITTED' then raise exception 'invalid_transition'; end if;
  insert into public.sponsorship_agreement_acceptances (sponsorship_id, sponsor_id, accepted_by, revision, content_hash, agreement_key, agreement_version, terms_key, terms_version, price_cents, currency, starts_at, ends_at, payment_status)
  values (v_s.id, v_s.sponsor_id, p_user_id, v_s.revision, public.sponsorship_material_hash(v_s), p_agreement_key, p_agreement_version, p_terms_key, p_terms_version, v_s.price_cents, v_s.currency, v_s.starts_at, v_s.ends_at, v_s.payment_status::text)
  on conflict (sponsorship_id, revision, agreement_key, agreement_version) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted > 0 then
    perform public.sponsorship_audit(p_user_id, 'sponsorship.agreement_accepted', v_s.id, null, jsonb_build_object('agreementVersion', p_agreement_version, 'termsVersion', p_terms_version, 'revision', v_s.revision), null);
  end if;
  return v_s;
end;
$$;
revoke all on function public.sponsor_accept_agreement(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.sponsor_accept_agreement(uuid, uuid, text, text, text, text) to service_role;
