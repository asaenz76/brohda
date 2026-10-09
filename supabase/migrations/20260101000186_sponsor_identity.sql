-- Sponsor identity (milestone: mutually exclusive MEMBER / SPONSOR accounts).
--
-- THE INVARIANT, enforced here in the database: an auth account is either a MEMBER (it has a `user_profiles` row — the social/prediction identity) or a SPONSOR (it has a
-- `sponsor_accounts` row — the commercial identity), NEVER both, and the type never changes. A Sponsor therefore has no member profile, and because every Member action
-- (Picks, comments, Call BS, monetary P2P, wallet, follows, notifications, reputation) is keyed by a user_profiles row with a real foreign key, a Sponsor account
-- structurally cannot create any of that data — the isolation does not depend on every code path remembering to check.
--
-- Replaces the forbidden model "Sponsor organization -> sponsor_users -> existing Member profile". Production had zero such links (re-verified here: the migration refuses
-- to run if any link exists).

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Account type (server-controlled; no client write path)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table public.account_types (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  account_type text not null check (account_type in ('MEMBER', 'SPONSOR')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger account_types_set_updated_at before update on public.account_types for each row execute function public.set_updated_at();

alter table public.account_types enable row level security;
revoke all on public.account_types from public, anon, authenticated;
grant select on public.account_types to authenticated;       -- a signed-in user may read ONLY their own row (the proxy uses it to route them)
grant all on public.account_types to service_role;
create policy "account_types_read_own" on public.account_types for select to authenticated using (user_id = auth.uid() or public.is_super_admin(auth.uid()));

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Sponsor account: the login <-> sponsor organization link (V1: exactly one organization per account, one account per organization)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.sponsors
  add column website text check (website is null or public.is_safe_http_url(website)),
  add column country text check (country is null or char_length(btrim(country)) between 1 and 80),
  add column contact_name text check (contact_name is null or char_length(btrim(contact_name)) between 1 and 120),
  add column contact_phone text check (contact_phone is null or char_length(btrim(contact_phone)) between 3 and 40),
  -- Super Admin's private note vs the reason a Sponsor is allowed to see.
  add column internal_review_note text check (internal_review_note is null or char_length(internal_review_note) <= 2000),
  add column status_reason text check (status_reason is null or char_length(status_reason) <= 1000),
  add column reviewed_by uuid references public.user_profiles (id),
  add column reviewed_at timestamptz;

-- Fail safe: an organization created by any path that forgets to say otherwise is NOT trusted — it waits for Super Admin.
alter table public.sponsors alter column status set default 'PENDING_REVIEW';

create table public.sponsor_accounts (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  sponsor_id uuid not null unique references public.sponsors (id),
  created_at timestamptz not null default now()
);

alter table public.sponsor_accounts enable row level security;
revoke all on public.sponsor_accounts from public, anon, authenticated;
grant select on public.sponsor_accounts to authenticated;
grant all on public.sponsor_accounts to service_role;
create policy "sponsor_accounts_read_own" on public.sponsor_accounts for select to authenticated using (user_id = auth.uid() or public.is_super_admin(auth.uid()));

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The exclusivity triggers
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.account_types_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    -- A type never changes: there is no Member -> Sponsor or Sponsor -> Member conversion.
    if new.account_type is distinct from old.account_type or new.user_id is distinct from old.user_id then raise exception 'account_type_immutable'; end if;
    return new;
  end if;
  if new.account_type = 'SPONSOR' and exists (select 1 from public.user_profiles where id = new.user_id) then raise exception 'account_type_conflict_member_profile_exists'; end if;
  if new.account_type = 'MEMBER' and exists (select 1 from public.sponsor_accounts where user_id = new.user_id) then raise exception 'account_type_conflict_sponsor_account_exists'; end if;
  return new;
end;
$$;
create trigger account_types_guard before insert or update on public.account_types for each row execute function public.account_types_guard();

-- A member profile can exist only for a MEMBER. Any path that creates one (self-registration, invitation, admin creation, a script) types the account MEMBER here if it
-- has no type yet — and is REFUSED if the account is already a SPONSOR.
create or replace function public.user_profiles_require_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_type text;
begin
  insert into public.account_types (user_id, account_type) values (new.id, 'MEMBER') on conflict (user_id) do nothing;
  select account_type into v_type from public.account_types where user_id = new.id;
  if v_type is distinct from 'MEMBER' then raise exception 'member_profile_requires_member_account'; end if;
  return new;
end;
$$;

-- A sponsor account can exist only for a SPONSOR with no member profile; creating it types the account SPONSOR (or refuses if it is a MEMBER).
create or replace function public.sponsor_accounts_require_sponsor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_type text;
begin
  if exists (select 1 from public.user_profiles where id = new.user_id) then raise exception 'sponsor_account_conflict_member_profile_exists'; end if;
  insert into public.account_types (user_id, account_type) values (new.user_id, 'SPONSOR') on conflict (user_id) do nothing;
  select account_type into v_type from public.account_types where user_id = new.user_id;
  if v_type is distinct from 'SPONSOR' then raise exception 'sponsor_account_requires_sponsor_type'; end if;
  return new;
end;
$$;

-- BACKFILL, deterministic: every existing member profile is a MEMBER (admins and super admins are members of the same identity model). An auth account WITHOUT a profile is
-- deliberately NOT typed — it is reported, not guessed. (Done before the triggers exist so the backfill is a plain insert.)
insert into public.account_types (user_id, account_type)
select id, 'MEMBER' from public.user_profiles
on conflict (user_id) do nothing;

create trigger user_profiles_require_member before insert on public.user_profiles for each row execute function public.user_profiles_require_member();
create trigger sponsor_accounts_require_sponsor before insert on public.sponsor_accounts for each row execute function public.sponsor_accounts_require_sponsor();

-- A profile can never be deleted out from under a typed MEMBER and replaced by a sponsor account for the same login: the type is immutable, and a SPONSOR insert is
-- refused while a MEMBER type exists. (Deleting a profile leaves the MEMBER type, so that login can never become a Sponsor.)

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Retire sponsor_users (member -> sponsor link): ownership now flows through sponsor_accounts.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.sponsor_users) then
    raise exception 'sponsor_users still has links; they must be reviewed by the owner before this migration can run (no automatic conversion)';
  end if;
end $$;

create or replace function public.is_sponsor_member(p_sponsor_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.sponsor_accounts where sponsor_id = p_sponsor_id and user_id = p_user_id);
$$;

drop policy if exists "sponsorship_inventory_read" on public.sponsorship_inventory;
create policy "sponsorship_inventory_read" on public.sponsorship_inventory for select to authenticated
  using (
    public.is_super_admin(auth.uid())
    or (
      is_sponsorable
      and public.sponsorship_capability_on()
      and exists (select 1 from public.sponsor_accounts sa join public.sponsors sp on sp.id = sa.sponsor_id where sa.user_id = auth.uid() and sp.status = 'ACTIVE')
    )
  );
drop table public.sponsor_users;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Columns a SPONSOR account writes can no longer require a member profile
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.sponsorships drop constraint if exists sponsorships_created_by_fkey;
alter table public.sponsorships add constraint sponsorships_created_by_fkey foreign key (created_by) references auth.users (id);
alter table public.sponsorships drop constraint if exists sponsorships_cancelled_by_fkey;
alter table public.sponsorships add constraint sponsorships_cancelled_by_fkey foreign key (cancelled_by) references auth.users (id);
alter table public.sponsorship_payment_events drop constraint if exists sponsorship_payment_events_actor_id_fkey;
alter table public.sponsorship_payment_events add constraint sponsorship_payment_events_actor_id_fkey foreign key (actor_id) references auth.users (id);

-- Audit rows keep their member-actor link; a non-member actor (a Sponsor) is recorded in its own column so every action stays attributable.
alter table public.audit_logs add column actor_account_id uuid references auth.users (id) on delete set null;

create or replace function public.sponsorship_audit(p_actor uuid, p_action text, p_id uuid, p_before jsonb, p_after jsonb, p_reason text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.audit_logs (actor_id, actor_account_id, action, entity_type, entity_id, before, after, reason)
  values (
    case when exists (select 1 from public.user_profiles where id = p_actor) then p_actor else null end,
    case when p_actor is not null and not exists (select 1 from public.user_profiles where id = p_actor) then p_actor else null end,
    p_action, 'sponsorship', p_id::text, p_before, p_after, p_reason);
$$;
revoke all on function public.sponsorship_audit(uuid, text, uuid, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.sponsorship_audit(uuid, text, uuid, jsonb, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Sponsor terms acceptance (the mechanism only — no legal text is invented here)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table public.sponsor_terms_acceptances (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  sponsor_id   uuid not null references public.sponsors (id),
  document_key text not null check (char_length(document_key) between 1 and 60),
  version      text not null check (char_length(version) between 1 and 60),
  source       text not null default 'signup' check (char_length(source) between 1 and 60),
  accepted_at  timestamptz not null default now(),
  constraint sponsor_terms_one_per_version unique (user_id, document_key, version)
);
alter table public.sponsor_terms_acceptances enable row level security;
revoke all on public.sponsor_terms_acceptances from public, anon, authenticated;
grant select on public.sponsor_terms_acceptances to authenticated;
grant all on public.sponsor_terms_acceptances to service_role;
create policy "sponsor_terms_read_own" on public.sponsor_terms_acceptances for select to authenticated using (user_id = auth.uid() or public.is_super_admin(auth.uid()));

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.sponsor_audit(p_actor uuid, p_action text, p_sponsor_id uuid, p_before jsonb, p_after jsonb, p_reason text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.audit_logs (actor_id, actor_account_id, action, entity_type, entity_id, before, after, reason)
  values (
    case when exists (select 1 from public.user_profiles where id = p_actor) then p_actor else null end,
    case when p_actor is not null and not exists (select 1 from public.user_profiles where id = p_actor) then p_actor else null end,
    p_action, 'sponsor', p_sponsor_id::text, p_before, p_after, p_reason);
$$;
revoke all on function public.sponsor_audit(uuid, text, uuid, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.sponsor_audit(uuid, text, uuid, jsonb, jsonb, text) to service_role;

-- Creates the SPONSOR identity for a freshly created (unverified) auth user: type, organization (PENDING_REVIEW) and the one-to-one link, atomically and idempotently.
create or replace function public.create_sponsor_account(p_user_id uuid, p_email text, p_brand text, p_contact_name text, p_website text, p_country text, p_phone text)
returns public.sponsors
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsors;
begin
  -- Two concurrent submissions for the same login serialize here, so the second finds the first's organization instead of racing it.
  perform pg_advisory_xact_lock(hashtextextended('sponsor_account:' || p_user_id::text, 0));
  select sp.* into v_s from public.sponsor_accounts sa join public.sponsors sp on sp.id = sa.sponsor_id where sa.user_id = p_user_id;
  if found then return v_s; end if; -- retry-safe: the same account never gets a second organization

  insert into public.sponsors (display_name, contact_email, contact_name, website, country, contact_phone, status)
  values (btrim(p_brand), nullif(btrim(p_email), ''), nullif(btrim(p_contact_name), ''), nullif(btrim(p_website), ''), nullif(btrim(p_country), ''), nullif(btrim(p_phone), ''), 'PENDING_REVIEW')
  returning * into v_s;
  -- The exclusivity triggers run here: this fails if the login is (or ever becomes) a Member.
  insert into public.sponsor_accounts (user_id, sponsor_id) values (p_user_id, v_s.id);
  perform public.sponsor_audit(p_user_id, 'sponsor.application_submitted', v_s.id, null, jsonb_build_object('status', 'PENDING_REVIEW'), null);
  return v_s;
end;
$$;
revoke all on function public.create_sponsor_account(uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_sponsor_account(uuid, text, text, text, text, text, text) to service_role;

-- The sponsor edits its OWN profile. Identity (the brand name) is editable only while the account is under review — after activation a change needs Super Admin
-- (a materially different business must not slip through an approved account). Everything else is editable while the account is usable at all.
create or replace function public.sponsor_update_profile(p_user_id uuid, p_fields jsonb)
returns public.sponsors
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsors;
  v_after public.sponsors;
begin
  select sp.* into v_s from public.sponsor_accounts sa join public.sponsors sp on sp.id = sa.sponsor_id where sa.user_id = p_user_id for update of sp;
  if not found then raise exception 'not_authorized'; end if;
  if v_s.status not in ('PENDING_REVIEW', 'ACTIVE') then raise exception 'sponsor_not_editable'; end if;
  if p_fields ? 'display_name' and v_s.status <> 'PENDING_REVIEW' and btrim(p_fields->>'display_name') is distinct from v_s.display_name then raise exception 'identity_change_requires_review'; end if;

  update public.sponsors set
    display_name = case when p_fields ? 'display_name' and status = 'PENDING_REVIEW' then coalesce(nullif(btrim(p_fields->>'display_name'), ''), display_name) else display_name end,
    contact_name = case when p_fields ? 'contact_name' then nullif(btrim(p_fields->>'contact_name'), '') else contact_name end,
    website = case when p_fields ? 'website' then nullif(btrim(p_fields->>'website'), '') else website end,
    country = case when p_fields ? 'country' then nullif(btrim(p_fields->>'country'), '') else country end,
    contact_phone = case when p_fields ? 'contact_phone' then nullif(btrim(p_fields->>'contact_phone'), '') else contact_phone end
  where id = v_s.id returning * into v_after;
  perform public.sponsor_audit(p_user_id, 'sponsor.profile_updated', v_s.id, jsonb_build_object('displayName', v_s.display_name), jsonb_build_object('displayName', v_after.display_name), null);
  return v_after;
end;
$$;
revoke all on function public.sponsor_update_profile(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sponsor_update_profile(uuid, jsonb) to service_role;

-- Super Admin decides the Sponsor ACCOUNT's status (a different gate from approving any single sponsorship).
create or replace function public.admin_set_sponsor_status(p_admin_id uuid, p_sponsor_id uuid, p_status text, p_reason text, p_internal_note text)
returns public.sponsors
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsors;
  v_after public.sponsors;
  v_new public.sponsor_status;
begin
  perform public.require_super_admin(p_admin_id);
  if p_status not in ('ACTIVE', 'REJECTED', 'SUSPENDED', 'DISABLED') then raise exception 'invalid_status'; end if;
  v_new := p_status::public.sponsor_status;
  select * into v_s from public.sponsors where id = p_sponsor_id for update;
  if not found then raise exception 'sponsor_not_found'; end if;
  if v_s.status = v_new then return v_s; end if; -- idempotent

  if not (
    (v_new = 'ACTIVE' and v_s.status in ('PENDING_REVIEW', 'REJECTED', 'SUSPENDED', 'DISABLED'))
    or (v_new = 'REJECTED' and v_s.status = 'PENDING_REVIEW')
    or (v_new = 'SUSPENDED' and v_s.status = 'ACTIVE')
    or (v_new = 'DISABLED' and v_s.status in ('PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'REJECTED'))
  ) then raise exception 'invalid_transition'; end if;
  if v_new <> 'ACTIVE' and (p_reason is null or btrim(p_reason) = '') then raise exception 'reason_required'; end if;

  update public.sponsors set status = v_new,
    status_reason = case when v_new = 'ACTIVE' then null else btrim(p_reason) end,
    internal_review_note = coalesce(nullif(btrim(p_internal_note), ''), internal_review_note),
    reviewed_by = p_admin_id, reviewed_at = now()
  where id = p_sponsor_id returning * into v_after;
  perform public.sponsor_audit(p_admin_id, 'sponsor.status_' || lower(p_status), p_sponsor_id, jsonb_build_object('status', v_s.status), jsonb_build_object('status', v_after.status), nullif(btrim(p_reason), ''));
  return v_after;
end;
$$;
revoke all on function public.admin_set_sponsor_status(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_set_sponsor_status(uuid, uuid, text, text, text) to service_role;

-- "What kind of account owns this email?" — MEMBER / SPONSOR / UNCLASSIFIED, or null when no login uses it. Server-side only: it is what lets Member-creating
-- paths refuse an email that already belongs to a Sponsor (and vice versa) without ever telling the visitor which kind it was.
create or replace function public.account_type_for_email(p_email text)
returns text
language sql
security definer
stable
set search_path = public, auth
as $$
  select coalesce(t.account_type, 'UNCLASSIFIED')
  from auth.users u left join public.account_types t on t.user_id = u.id
  where lower(u.email) = lower(btrim(p_email))
  limit 1;
$$;
revoke all on function public.account_type_for_email(text) from public, anon, authenticated;
grant execute on function public.account_type_for_email(text) to service_role;
