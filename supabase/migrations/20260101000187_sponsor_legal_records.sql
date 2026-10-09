-- Sponsor legal records (Sponsor public surface + legal closure milestone).
--
-- 1. A Sponsor Terms acceptance is IMMUTABLE evidence: it can't be edited or deleted, and an account that has one can't be deleted out from under it
--    (ON DELETE RESTRICT, the same protection Member legal acceptances have).
-- 2. The per-campaign Media and Advertising Agreement acceptance: an append-only record that points at the CANONICAL sponsorship (and the revision and
--    content hash it had) rather than copying the commercial truth into a second place — price, window and payment state are captured only as the
--    values in force at the moment of acceptance, read by the database itself, never supplied by the browser. The full content of what was agreed is
--    the existing immutable approval snapshot (sponsorship_approvals) plus these rows.
-- Nothing here makes any draft text binding: the application only records an acceptance when a document is APPROVED (lib/sponsor/terms.ts).

create or replace function public.forbid_legal_record_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'legal acceptance records are immutable';
end;
$$;

alter table public.sponsor_terms_acceptances drop constraint if exists sponsor_terms_acceptances_user_id_fkey;
alter table public.sponsor_terms_acceptances add constraint sponsor_terms_acceptances_user_id_fkey foreign key (user_id) references auth.users (id) on delete restrict;
create trigger sponsor_terms_acceptances_immutable before update or delete on public.sponsor_terms_acceptances for each row execute function public.forbid_legal_record_mutation();

create table public.sponsorship_agreement_acceptances (
  id                  uuid primary key default gen_random_uuid(),
  sponsorship_id      uuid not null references public.sponsorships (id),
  sponsor_id          uuid not null references public.sponsors (id),
  accepted_by         uuid not null references auth.users (id) on delete restrict,
  -- What the agreement was about, as it stood: which version of the content (revision + the material hash the approval flow already uses).
  revision            integer not null,
  content_hash        text not null,
  -- Which texts were accepted.
  agreement_key       text not null check (char_length(agreement_key) between 1 and 60),
  agreement_version   text not null check (char_length(agreement_version) between 1 and 60),
  terms_key           text check (terms_key is null or char_length(terms_key) between 1 and 60),
  terms_version       text check (terms_version is null or char_length(terms_version) between 1 and 60),
  -- The commercial terms in force at that moment (read from the sponsorship by the database).
  price_cents         integer,
  currency            text,
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  payment_status      text not null,
  accepted_at         timestamptz not null default now(),
  constraint sponsorship_agreement_one_per_revision unique (sponsorship_id, revision, agreement_key, agreement_version)
);
create index sponsorship_agreement_acceptances_sponsorship_idx on public.sponsorship_agreement_acceptances (sponsorship_id);
create trigger sponsorship_agreement_acceptances_immutable before update or delete on public.sponsorship_agreement_acceptances for each row execute function public.forbid_legal_record_mutation();

alter table public.sponsorship_agreement_acceptances enable row level security;
revoke all on public.sponsorship_agreement_acceptances from public, anon, authenticated;
grant select on public.sponsorship_agreement_acceptances to authenticated;
grant all on public.sponsorship_agreement_acceptances to service_role;
-- The Sponsor that owns the campaign and Super Admin can read it; nobody else (other Sponsors, Members, the public).
create policy "agreement_acceptances_read" on public.sponsorship_agreement_acceptances for select to authenticated
  using (public.is_super_admin(auth.uid()) or public.is_sponsor_member(sponsor_id, auth.uid()));

-- Submit a sponsorship AND record the Sponsor's acceptance of the agreement in ONE transaction: either both happen or neither does. The existing submit
-- function does every check (ownership, ACTIVE sponsor, capability, content, exclusivity); this only adds the record, reading the revision, hash, price,
-- window and payment state from the submitted row itself.
create or replace function public.sponsor_submit_with_agreement(p_user_id uuid, p_id uuid, p_agreement_key text, p_agreement_version text, p_terms_key text, p_terms_version text)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
begin
  v_s := public.sponsor_submit_sponsorship(p_user_id, p_id);
  insert into public.sponsorship_agreement_acceptances (sponsorship_id, sponsor_id, accepted_by, revision, content_hash, agreement_key, agreement_version, terms_key, terms_version, price_cents, currency, starts_at, ends_at, payment_status)
  values (v_s.id, v_s.sponsor_id, p_user_id, v_s.revision, public.sponsorship_material_hash(v_s), p_agreement_key, p_agreement_version, p_terms_key, p_terms_version, v_s.price_cents, v_s.currency, v_s.starts_at, v_s.ends_at, v_s.payment_status::text)
  on conflict (sponsorship_id, revision, agreement_key, agreement_version) do nothing;
  perform public.sponsorship_audit(p_user_id, 'sponsorship.agreement_accepted', v_s.id, null, jsonb_build_object('agreementVersion', p_agreement_version, 'termsVersion', p_terms_version, 'revision', v_s.revision), null);
  return v_s;
end;
$$;
revoke all on function public.sponsor_submit_with_agreement(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.sponsor_submit_with_agreement(uuid, uuid, text, text, text, text) to service_role;
