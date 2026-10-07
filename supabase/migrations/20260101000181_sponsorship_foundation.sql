-- Sponsorship foundation (milestone 1): PAID + SUPER-ADMIN-APPROVED sponsored Game Posts.
--
-- Sponsorship is MEDIA INVENTORY layered on the canonical Game Post (one Game, one Post, one conversation). It never touches Markets, Picks,
-- grading, Call BS, reputation, the wallet or monetary P2P. A sponsor buys presentation around a Post; it creates nothing canonical.
--
-- The one publication invariant is enforced HERE, in the database, not only in the UI:
--   lifecycle SCHEDULED/LIVE  =>  payment_status = PAID  AND  review_status = APPROVED  AND  an approval hash that still matches the content.
-- (the sponsorships_public_state_requires_paid_and_approved check, plus the material-edit trigger that voids an approval when approved content changes).
--
-- Three orthogonal state columns (not one giant enum, not loose booleans): lifecycle, review_status, payment_status. Every transition goes through
-- one of the security-definer functions below, each of which re-checks the actor, the capability, the ownership and the current state, writes the
-- audit_logs row in the same transaction, and is idempotent on retry. Everything is service_role-only; RLS gives sponsors read access to their own
-- rows and Super Admin read access to all.
--
-- Fail closed: sponsorship_enabled defaults to false and every sponsor-facing function refuses when it is not exactly true.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Settings (platform_settings is the one settings system)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.platform_settings
  add column sponsorship_enabled boolean not null default false,
  add column sponsorship_default_currency text not null default 'USD' check (sponsorship_default_currency ~ '^[A-Z]{3}$'),
  add column sponsorship_logo_max_bytes integer not null default 524288 check (sponsorship_logo_max_bytes between 10240 and 5242880),
  add column sponsorship_end_after_kickoff_hours integer not null default 6 check (sponsorship_end_after_kickoff_hours between 0 and 168),
  add column sponsorship_reservation_hours integer not null default 72 check (sponsorship_reservation_hours between 0 and 720),
  add column sponsorship_payment_instructions text not null default '' check (char_length(sponsorship_payment_instructions) <= 2000);

comment on column public.platform_settings.sponsorship_enabled is
  'Master switch for Sponsored Game Posts. OFF (or unreadable) = nothing sponsored is publicly visible and sponsors cannot create/submit; existing records stay intact.';
comment on column public.platform_settings.sponsorship_reservation_hours is
  'How long a SUBMITTED, not-yet-paid sponsorship holds its inventory before it is released back to DRAFT. 0 = never expires.';

create or replace function public.update_sponsorship_settings(
  p_admin_id uuid,
  p_expected_updated_at timestamptz,
  p_sponsorship_enabled boolean,
  p_default_currency text,
  p_logo_max_bytes integer,
  p_end_after_kickoff_hours integer,
  p_reservation_hours integer,
  p_payment_instructions text
)
returns public.admin_settings_update_result
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.platform_settings;
  v_after public.platform_settings;
begin
  if not public.is_super_admin(p_admin_id) then
    raise exception 'not_authorized';
  end if;

  select * into v_before from public.platform_settings where id = true for update;
  if v_before.updated_at <> p_expected_updated_at then
    return (v_before, 'conflict')::public.admin_settings_update_result;
  end if;

  update public.platform_settings set
    sponsorship_enabled = p_sponsorship_enabled,
    sponsorship_default_currency = p_default_currency,
    sponsorship_logo_max_bytes = p_logo_max_bytes,
    sponsorship_end_after_kickoff_hours = p_end_after_kickoff_hours,
    sponsorship_reservation_hours = p_reservation_hours,
    sponsorship_payment_instructions = p_payment_instructions,
    updated_at = now(),
    updated_by = p_admin_id
  where id = true
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (
    p_admin_id, 'settings.sponsorship_updated', 'platform_settings', null,
    jsonb_build_object(
      'sponsorshipEnabled', v_before.sponsorship_enabled,
      'sponsorshipDefaultCurrency', v_before.sponsorship_default_currency,
      'sponsorshipLogoMaxBytes', v_before.sponsorship_logo_max_bytes,
      'sponsorshipEndAfterKickoffHours', v_before.sponsorship_end_after_kickoff_hours,
      'sponsorshipReservationHours', v_before.sponsorship_reservation_hours,
      'sponsorshipPaymentInstructions', v_before.sponsorship_payment_instructions
    ),
    jsonb_build_object(
      'sponsorshipEnabled', v_after.sponsorship_enabled,
      'sponsorshipDefaultCurrency', v_after.sponsorship_default_currency,
      'sponsorshipLogoMaxBytes', v_after.sponsorship_logo_max_bytes,
      'sponsorshipEndAfterKickoffHours', v_after.sponsorship_end_after_kickoff_hours,
      'sponsorshipReservationHours', v_after.sponsorship_reservation_hours,
      'sponsorshipPaymentInstructions', v_after.sponsorship_payment_instructions
    )
  );

  return (v_after, 'updated')::public.admin_settings_update_result;
end;
$$;

revoke all on function public.update_sponsorship_settings(uuid, timestamptz, boolean, text, integer, integer, integer, text) from public, anon, authenticated;
grant execute on function public.update_sponsorship_settings(uuid, timestamptz, boolean, text, integer, integer, integer, text) to service_role;

-- The capability, fail-closed: anything other than a readable, exactly-true value is OFF.
create or replace function public.sponsorship_capability_on()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select sponsorship_enabled from public.platform_settings where id = true), false);
$$;
revoke all on function public.sponsorship_capability_on() from public, anon, authenticated;
-- (authenticated too: the inventory RLS policy evaluates it as the caller; it only ever returns a boolean.)
grant execute on function public.sponsorship_capability_on() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create type public.sponsor_status as enum ('ACTIVE', 'SUSPENDED', 'DISABLED');
create type public.sponsorship_lifecycle as enum ('DRAFT', 'SUBMITTED', 'SCHEDULED', 'LIVE', 'SUSPENDED', 'COMPLETED', 'REJECTED', 'CANCELLED');
create type public.sponsorship_review_status as enum ('PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED');
create type public.sponsorship_payment_status as enum ('UNPAID', 'PENDING', 'PAID', 'FAILED', 'REFUND_PENDING', 'REFUNDED', 'CANCELLED');

-- A conservative http(s) URL check (no credentials, no whitespace, no angle brackets/quotes). The application validates more strictly first; this is the
-- database's own backstop so no code path can store a javascript:/data: link.
create or replace function public.is_safe_http_url(p_url text)
returns boolean
language sql
immutable
as $$
  select p_url is not null
    and char_length(p_url) <= 2048
    and p_url ~* '^https?://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?(/[^[:space:]<>"]*)?$';
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Sponsors (the organization) and their members
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table public.sponsors (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null check (char_length(btrim(display_name)) between 1 and 80),
  legal_name    text check (legal_name is null or char_length(legal_name) <= 160),
  contact_email text check (contact_email is null or char_length(contact_email) <= 254),
  -- Object path inside the public `sponsor-logos` bucket (unguessable uuid name); null until a logo is uploaded.
  logo_path     text,
  status        public.sponsor_status not null default 'ACTIVE',
  created_by    uuid references public.user_profiles (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger sponsors_set_updated_at before update on public.sponsors for each row execute function public.set_updated_at();

-- Membership: which authenticated users act for a sponsor. Many-to-many on purpose (a future multi-user organization needs no schema change); V1 uses one.
create table public.sponsor_users (
  sponsor_id uuid not null references public.sponsors (id),
  user_id    uuid not null references public.user_profiles (id),
  created_at timestamptz not null default now(),
  primary key (sponsor_id, user_id)
);
create index sponsor_users_user_idx on public.sponsor_users (user_id);

create or replace function public.is_sponsor_member(p_sponsor_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.sponsor_users where sponsor_id = p_sponsor_id and user_id = p_user_id);
$$;
revoke all on function public.is_sponsor_member(uuid, uuid) from public;
grant execute on function public.is_sponsor_member(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Inventory: which Game Posts may be sponsored, at what price, in which market, for which window. The Games schedule IS the calendar — no second one.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table public.sponsorship_inventory (
  id             uuid primary key default gen_random_uuid(),
  post_id        uuid not null references public.posts (id),
  fixture_id     uuid not null references public.fixtures (id),
  -- GLOBAL today: Brohda has no trustworthy per-viewer location signal, so only GLOBAL inventory can render. Country-level codes are accepted as data
  -- (and sold/reviewed) but are never shown until a reliable signal exists — see lib/sponsorship/geography.ts.
  market_code    text not null default 'GLOBAL' check (market_code ~ '^[A-Z0-9_-]{2,16}$'),
  is_sponsorable boolean not null default false,
  price_cents    integer not null check (price_cents >= 0),
  currency       text not null check (currency ~ '^[A-Z]{3}$'),
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  created_by     uuid references public.user_profiles (id),
  updated_by     uuid references public.user_profiles (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint sponsorship_inventory_one_per_post_market unique (post_id, market_code),
  constraint sponsorship_inventory_window check (ends_at > starts_at)
);
create index sponsorship_inventory_fixture_idx on public.sponsorship_inventory (fixture_id);
create trigger sponsorship_inventory_set_updated_at before update on public.sponsorship_inventory for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Sponsorship
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table public.sponsorships (
  id            uuid primary key default gen_random_uuid(),
  sponsor_id    uuid not null references public.sponsors (id),
  inventory_id  uuid not null references public.sponsorship_inventory (id),
  post_id       uuid not null references public.posts (id),
  fixture_id    uuid not null references public.fixtures (id),
  market_code   text not null,
  created_by    uuid references public.user_profiles (id),

  -- Internal campaign name (never rendered publicly).
  campaign_name text not null check (char_length(btrim(campaign_name)) between 1 and 120),

  -- Material presentation content (what Super Admin approves).
  presented_by    text check (presented_by is null or char_length(btrim(presented_by)) between 1 and 80),
  tagline         text check (tagline is null or char_length(tagline) <= 140),
  cta_text        text check (cta_text is null or char_length(cta_text) <= 30),
  destination_url text check (destination_url is null or public.is_safe_http_url(destination_url)),
  logo_path       text,

  -- Optional SPONSOR-RUN promotion: metadata + link + disclosure only. Brohda runs no entries, qualification, draws, winners, custody or fulfillment.
  has_promotion                   boolean not null default false,
  promotion_title                 text check (promotion_title is null or char_length(promotion_title) <= 120),
  promotion_description           text check (promotion_description is null or char_length(promotion_description) <= 600),
  prize_description               text check (prize_description is null or char_length(prize_description) <= 300),
  official_rules_url              text check (official_rules_url is null or public.is_safe_http_url(official_rules_url)),
  promotion_destination_url       text check (promotion_destination_url is null or public.is_safe_http_url(promotion_destination_url)),
  promotion_fulfillment_name      text check (promotion_fulfillment_name is null or char_length(promotion_fulfillment_name) <= 160),
  promotion_eligibility_summary   text check (promotion_eligibility_summary is null or char_length(promotion_eligibility_summary) <= 300),
  promotion_starts_at             timestamptz,
  promotion_ends_at               timestamptz,

  -- Commercial snapshot (set at submission from the inventory; immutable once PAID).
  price_cents   integer check (price_cents is null or price_cents >= 0),
  currency      text check (currency is null or currency ~ '^[A-Z]{3}$'),
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,

  lifecycle       public.sponsorship_lifecycle not null default 'DRAFT',
  review_status   public.sponsorship_review_status not null default 'PENDING',
  payment_status  public.sponsorship_payment_status not null default 'UNPAID',
  revision        integer not null default 1,

  submitted_at     timestamptz,
  approved_by      uuid references public.user_profiles (id),
  approved_at      timestamptz,
  -- Hash of the material content at the moment of approval; public eligibility requires it to still match (approve-then-swap is impossible).
  approved_hash    text,
  rejected_by      uuid references public.user_profiles (id),
  rejected_at      timestamptz,
  rejection_reason text,
  review_note      text,
  suspended_by     uuid references public.user_profiles (id),
  suspended_at     timestamptz,
  suspension_reason text,
  cancelled_by     uuid references public.user_profiles (id),
  cancelled_at     timestamptz,
  cancellation_reason text,
  completed_at     timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint sponsorships_window check (ends_at > starts_at),
  constraint sponsorships_promotion_window check (promotion_ends_at is null or promotion_starts_at is null or promotion_ends_at > promotion_starts_at),
  -- THE invariant: a sponsorship the public can see is paid, approved, and approved-as-currently-written. Payment alone or approval alone can never do it.
  constraint sponsorships_public_state_requires_paid_and_approved check (
    lifecycle not in ('SCHEDULED', 'LIVE')
    or (payment_status = 'PAID' and review_status = 'APPROVED' and approved_hash is not null and price_cents is not null and approved_by is not null)
  )
);
create index sponsorships_sponsor_idx on public.sponsorships (sponsor_id, created_at desc);
create index sponsorships_post_idx on public.sponsorships (post_id);
create index sponsorships_queue_idx on public.sponsorships (lifecycle, review_status, payment_status);
create index sponsorships_window_idx on public.sponsorships (starts_at, ends_at) where lifecycle in ('SCHEDULED', 'LIVE');
-- Exclusivity (V1: ONE sponsor per Post + market + period): inventory is one slot per (post, market) with one window, and at most one sponsorship may
-- hold a slot. Two sponsors racing for it: the second insert/transition hits this index and fails.
create unique index sponsorships_one_holder_per_inventory on public.sponsorships (inventory_id) where lifecycle in ('SUBMITTED', 'SCHEDULED', 'LIVE', 'SUSPENDED');
create trigger sponsorships_set_updated_at before update on public.sponsorships for each row execute function public.set_updated_at();

-- The content a reviewer approves. campaign_name (internal) and bookkeeping columns are deliberately not part of it.
create or replace function public.sponsorship_material_hash(s public.sponsorships)
returns text
language sql
immutable
as $$
  select md5(jsonb_build_array(
    s.sponsor_id, s.post_id, s.market_code, s.presented_by, s.tagline, s.cta_text, s.destination_url, s.logo_path,
    s.has_promotion, s.promotion_title, s.promotion_description, s.prize_description, s.official_rules_url, s.promotion_destination_url,
    s.promotion_fulfillment_name, s.promotion_eligibility_summary, s.promotion_starts_at, s.promotion_ends_at,
    s.price_cents, s.currency, s.starts_at, s.ends_at
  )::text);
$$;

-- Identity and ownership never change; the agreed price is frozen once paid; a material edit to approved content voids the approval on the spot —
-- whichever code path made the edit.
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
    if new.lifecycle in ('SCHEDULED', 'LIVE') then
      new.lifecycle := 'SUBMITTED';
    end if;
  end if;
  return new;
end;
$$;
create trigger sponsorships_guard before update on public.sponsorships for each row execute function public.sponsorships_guard();

-- The commercial record: append-only payment events (provider-neutral; MANUAL today). Never card data or provider secrets — references only.
create table public.sponsorship_payment_events (
  id                 uuid primary key default gen_random_uuid(),
  sponsorship_id     uuid not null references public.sponsorships (id),
  event_type         text not null check (event_type in ('PAYMENT_PENDING', 'PAID', 'FAILED', 'REFUND_PENDING', 'REFUNDED', 'CANCELLED')),
  amount_cents       integer check (amount_cents is null or amount_cents >= 0),
  currency           text check (currency is null or currency ~ '^[A-Z]{3}$'),
  provider           text not null default 'MANUAL' check (char_length(provider) between 1 and 40),
  provider_reference text check (provider_reference is null or char_length(provider_reference) <= 200),
  note               text check (note is null or char_length(note) <= 1000),
  actor_id           uuid references public.user_profiles (id),
  idempotency_key    text not null check (char_length(idempotency_key) between 1 and 200),
  created_at         timestamptz not null default now(),
  constraint sponsorship_payment_events_idempotent unique (idempotency_key)
);
create index sponsorship_payment_events_sponsorship_idx on public.sponsorship_payment_events (sponsorship_id, created_at);

-- What Super Admin actually approved, immutable: the proof of Game/Post, sponsor, price, copy, destination, geography, promotion, approver and time.
create table public.sponsorship_approvals (
  id             uuid primary key default gen_random_uuid(),
  sponsorship_id uuid not null references public.sponsorships (id),
  revision       integer not null,
  content_hash   text not null,
  snapshot       jsonb not null,
  approved_by    uuid not null references public.user_profiles (id),
  approved_at    timestamptz not null default now(),
  constraint sponsorship_approvals_one_per_revision unique (sponsorship_id, revision)
);

create or replace function public.forbid_sponsorship_approval_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'sponsorship approval snapshots are immutable';
end;
$$;
create trigger sponsorship_approvals_immutable before update or delete on public.sponsorship_approvals for each row execute function public.forbid_sponsorship_approval_mutation();

-- Measurement hooks for the later Sponsor Intelligence milestone. INTERNAL ONLY — never exposed to sponsors. Definitions:
--   IMPRESSION: a signed-in member's browser reported the sponsored label on a Game Post as at least half visible for at least one second; one per
--               (sponsorship, member, UTC day), so re-renders and re-scrolls never inflate it. Anonymous visitors are not recorded.
--   CLICK:      a member (or visitor) followed the first-party /sponsorship/click redirect to the approved destination.
create table public.sponsorship_exposure_events (
  id             bigint generated always as identity primary key,
  sponsorship_id uuid not null references public.sponsorships (id),
  post_id        uuid not null references public.posts (id),
  event_type     text not null check (event_type in ('IMPRESSION', 'CLICK')),
  user_id        uuid references public.user_profiles (id),
  day_utc        date not null default ((now() at time zone 'utc')::date),
  occurred_at    timestamptz not null default now()
);
create unique index sponsorship_exposure_one_impression_per_day on public.sponsorship_exposure_events (sponsorship_id, user_id, day_utc) where event_type = 'IMPRESSION' and user_id is not null;
create index sponsorship_exposure_sponsorship_idx on public.sponsorship_exposure_events (sponsorship_id, event_type, occurred_at);

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- RLS / grants: deny by default; sponsors read their own, Super Admin reads all; every write is a service-role function.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.sponsors enable row level security;
alter table public.sponsor_users enable row level security;
alter table public.sponsorship_inventory enable row level security;
alter table public.sponsorships enable row level security;
alter table public.sponsorship_payment_events enable row level security;
alter table public.sponsorship_approvals enable row level security;
alter table public.sponsorship_exposure_events enable row level security;

revoke all on public.sponsors, public.sponsor_users, public.sponsorship_inventory, public.sponsorships, public.sponsorship_payment_events,
  public.sponsorship_approvals, public.sponsorship_exposure_events from public, anon, authenticated;
grant select on public.sponsors, public.sponsor_users, public.sponsorship_inventory, public.sponsorships, public.sponsorship_payment_events,
  public.sponsorship_approvals, public.sponsorship_exposure_events to authenticated;
grant all on public.sponsors, public.sponsor_users, public.sponsorship_inventory, public.sponsorships, public.sponsorship_payment_events,
  public.sponsorship_approvals, public.sponsorship_exposure_events to service_role;
grant usage, select on sequence public.sponsorship_exposure_events_id_seq to service_role;

create policy "sponsors_read" on public.sponsors for select to authenticated
  using (public.is_super_admin(auth.uid()) or public.is_sponsor_member(id, auth.uid()));
create policy "sponsor_users_read" on public.sponsor_users for select to authenticated
  using (public.is_super_admin(auth.uid()) or user_id = auth.uid());
create policy "sponsorships_read" on public.sponsorships for select to authenticated
  using (public.is_super_admin(auth.uid()) or public.is_sponsor_member(sponsor_id, auth.uid()));
create policy "sponsorship_payment_events_read" on public.sponsorship_payment_events for select to authenticated
  using (public.is_super_admin(auth.uid()) or exists (
    select 1 from public.sponsorships s where s.id = sponsorship_id and public.is_sponsor_member(s.sponsor_id, auth.uid())));
-- Inventory is visible to a member of an ACTIVE sponsor, only for sponsorable rows, only while the capability is on.
create policy "sponsorship_inventory_read" on public.sponsorship_inventory for select to authenticated
  using (
    public.is_super_admin(auth.uid())
    or (
      is_sponsorable
      and public.sponsorship_capability_on()
      and exists (select 1 from public.sponsor_users su join public.sponsors sp on sp.id = su.sponsor_id where su.user_id = auth.uid() and sp.status = 'ACTIVE')
    )
  );
create policy "sponsorship_approvals_read" on public.sponsorship_approvals for select to authenticated using (public.is_super_admin(auth.uid()));
create policy "sponsorship_exposure_events_read" on public.sponsorship_exposure_events for select to authenticated using (public.is_super_admin(auth.uid()));

-- Logo storage: a public-read bucket (the logo of an APPROVED, live sponsorship is public by nature); object names are unguessable uuids and writes happen
-- only through the server-side upload route with the service role, after size/type/ownership validation.
insert into storage.buckets (id, name, public) values ('sponsor-logos', 'sponsor-logos', true) on conflict (id) do nothing;
create policy "sponsor_logos_public_read" on storage.objects for select to anon, authenticated using (bucket_id = 'sponsor-logos');

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Public eligibility INPUTS (service-role only). The policy itself lives in one place in application code (lib/sponsorship/eligibility.ts);
-- this view only supplies the facts it needs, including whether the approved content still matches what is stored.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create view public.sponsorship_eligibility_inputs as
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
  s.promotion_ends_at
from public.sponsorships s
join public.sponsors sp on sp.id = s.sponsor_id
join public.posts p on p.id = s.post_id
join public.fixtures f on f.id = s.fixture_id;
revoke all on public.sponsorship_eligibility_inputs from public, anon, authenticated;
grant select on public.sponsorship_eligibility_inputs to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.sponsorship_state_json(s public.sponsorships)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('lifecycle', s.lifecycle, 'reviewStatus', s.review_status, 'paymentStatus', s.payment_status, 'priceCents', s.price_cents, 'currency', s.currency, 'revision', s.revision);
$$;

create or replace function public.sponsorship_audit(p_actor uuid, p_action text, p_id uuid, p_before jsonb, p_after jsonb, p_reason text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after, reason)
  values (p_actor, p_action, 'sponsorship', p_id::text, p_before, p_after, p_reason);
$$;
revoke all on function public.sponsorship_audit(uuid, text, uuid, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.sponsorship_audit(uuid, text, uuid, jsonb, jsonb, text) to service_role;

-- Where a paid + approved sponsorship sits on the clock.
create or replace function public.sponsorship_scheduled_lifecycle(s public.sponsorships, p_now timestamptz)
returns public.sponsorship_lifecycle
language sql
immutable
as $$
  select case
    when p_now >= s.ends_at then 'COMPLETED'::public.sponsorship_lifecycle
    when p_now >= s.starts_at then 'LIVE'::public.sponsorship_lifecycle
    else 'SCHEDULED'::public.sponsorship_lifecycle
  end;
$$;

create or replace function public.sponsorship_lock(p_id uuid)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare v_s public.sponsorships;
begin
  select * into v_s from public.sponsorships where id = p_id for update;
  if not found then raise exception 'sponsorship_not_found'; end if;
  return v_s;
end;
$$;
revoke all on function public.sponsorship_lock(uuid) from public, anon, authenticated;
grant execute on function public.sponsorship_lock(uuid) to service_role;

-- A sponsor's own sponsorship, locked, with the sponsor-facing preconditions (capability ON, member, sponsor ACTIVE).
create or replace function public.sponsor_acting_on(p_user_id uuid, p_id uuid)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_status public.sponsor_status;
begin
  if not public.sponsorship_capability_on() then raise exception 'sponsorship_disabled'; end if;
  v_s := public.sponsorship_lock(p_id);
  if not public.is_sponsor_member(v_s.sponsor_id, p_user_id) then raise exception 'not_authorized'; end if;
  select status into v_status from public.sponsors where id = v_s.sponsor_id;
  if v_status <> 'ACTIVE' then raise exception 'sponsor_not_active'; end if;
  return v_s;
end;
$$;
revoke all on function public.sponsor_acting_on(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sponsor_acting_on(uuid, uuid) to service_role;

create or replace function public.require_super_admin(p_admin_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_admin_id is null or not public.is_super_admin(p_admin_id) then raise exception 'not_authorized'; end if;
end;
$$;
revoke all on function public.require_super_admin(uuid) from public, anon, authenticated;
grant execute on function public.require_super_admin(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Super Admin: inventory
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_set_sponsorship_inventory(
  p_admin_id uuid, p_post_id uuid, p_market_code text, p_is_sponsorable boolean, p_price_cents integer, p_currency text, p_starts_at timestamptz, p_ends_at timestamptz
)
returns public.sponsorship_inventory
language plpgsql
security definer
set search_path = public
as $$
declare
  v_post public.posts;
  v_before public.sponsorship_inventory;
  v_after public.sponsorship_inventory;
begin
  perform public.require_super_admin(p_admin_id);
  select * into v_post from public.posts where id = p_post_id;
  if not found then raise exception 'post_not_found'; end if;
  select * into v_before from public.sponsorship_inventory where post_id = p_post_id and market_code = p_market_code for update;

  insert into public.sponsorship_inventory (post_id, fixture_id, market_code, is_sponsorable, price_cents, currency, starts_at, ends_at, created_by, updated_by)
  values (p_post_id, v_post.fixture_id, p_market_code, p_is_sponsorable, p_price_cents, p_currency, p_starts_at, p_ends_at, p_admin_id, p_admin_id)
  on conflict (post_id, market_code) do update set
    is_sponsorable = excluded.is_sponsorable, price_cents = excluded.price_cents, currency = excluded.currency,
    starts_at = excluded.starts_at, ends_at = excluded.ends_at, updated_by = p_admin_id
  returning * into v_after;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
  values (p_admin_id, 'sponsorship.inventory_set', 'sponsorship_inventory', v_after.id::text,
    case when v_before.id is null then null else jsonb_build_object('isSponsorable', v_before.is_sponsorable, 'priceCents', v_before.price_cents, 'currency', v_before.currency, 'startsAt', v_before.starts_at, 'endsAt', v_before.ends_at) end,
    jsonb_build_object('postId', v_after.post_id, 'marketCode', v_after.market_code, 'isSponsorable', v_after.is_sponsorable, 'priceCents', v_after.price_cents, 'currency', v_after.currency, 'startsAt', v_after.starts_at, 'endsAt', v_after.ends_at));
  return v_after;
end;
$$;
revoke all on function public.admin_set_sponsorship_inventory(uuid, uuid, text, boolean, integer, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_set_sponsorship_inventory(uuid, uuid, text, boolean, integer, text, timestamptz, timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Sponsor: create / edit / submit / cancel
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.sponsor_create_sponsorship(p_user_id uuid, p_sponsor_id uuid, p_inventory_id uuid, p_campaign_name text)
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
  if not public.sponsorship_capability_on() then raise exception 'sponsorship_disabled'; end if;
  if not public.is_sponsor_member(p_sponsor_id, p_user_id) then raise exception 'not_authorized'; end if;
  select * into v_sponsor from public.sponsors where id = p_sponsor_id;
  if not found or v_sponsor.status <> 'ACTIVE' then raise exception 'sponsor_not_active'; end if;
  select * into v_inv from public.sponsorship_inventory where id = p_inventory_id;
  if not found or not v_inv.is_sponsorable then raise exception 'inventory_unavailable'; end if;
  if v_inv.ends_at <= now() then raise exception 'inventory_unavailable'; end if;

  insert into public.sponsorships (sponsor_id, inventory_id, post_id, fixture_id, market_code, created_by, campaign_name, presented_by, logo_path, starts_at, ends_at)
  values (p_sponsor_id, v_inv.id, v_inv.post_id, v_inv.fixture_id, v_inv.market_code, p_user_id, p_campaign_name, v_sponsor.display_name, v_sponsor.logo_path, v_inv.starts_at, v_inv.ends_at)
  returning * into v_s;

  perform public.sponsorship_audit(p_user_id, 'sponsorship.created', v_s.id, null, public.sponsorship_state_json(v_s), null);
  return v_s;
end;
$$;
revoke all on function public.sponsor_create_sponsorship(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.sponsor_create_sponsorship(uuid, uuid, uuid, text) to service_role;

create or replace function public.sponsor_update_sponsorship(p_user_id uuid, p_id uuid, p_fields jsonb)
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
  v_s := public.sponsor_acting_on(p_user_id, p_id);
  -- Editable only before review is final: a DRAFT, or a submission Super Admin sent back for changes. Never once submitted/approved/live.
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

  perform public.sponsorship_audit(p_user_id, 'sponsorship.updated', p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), null);
  return v_after;
end;
$$;
revoke all on function public.sponsor_update_sponsorship(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sponsor_update_sponsorship(uuid, uuid, jsonb) to service_role;

-- Frees inventory held by submissions that never got paid within the configured hold. Called by the advance job and lazily at submit time.
create or replace function public.release_stale_sponsorship_reservations(p_now timestamptz default now(), p_inventory_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hours integer;
  v_row public.sponsorships;
  v_count integer := 0;
begin
  select sponsorship_reservation_hours into v_hours from public.platform_settings where id = true;
  if coalesce(v_hours, 0) <= 0 then return 0; end if;
  for v_row in
    select * from public.sponsorships
    where lifecycle = 'SUBMITTED' and payment_status in ('UNPAID', 'PENDING', 'FAILED')
      and submitted_at is not null and submitted_at + make_interval(hours => v_hours) <= p_now
      and (p_inventory_id is null or inventory_id = p_inventory_id)
    for update skip locked
  loop
    update public.sponsorships set lifecycle = 'DRAFT', payment_status = 'UNPAID', review_status = 'PENDING', approved_hash = null, approved_by = null, approved_at = null
      where id = v_row.id;
    perform public.sponsorship_audit(null, 'sponsorship.reservation_expired', v_row.id, public.sponsorship_state_json(v_row), jsonb_build_object('lifecycle', 'DRAFT', 'paymentStatus', 'UNPAID'), 'unpaid hold expired');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.release_stale_sponsorship_reservations(timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.release_stale_sponsorship_reservations(timestamptz, uuid) to service_role;

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
    values (p_id, 'PAYMENT_PENDING', v_after.price_cents, v_after.currency, p_user_id, 'submit:' || p_id::text || ':' || v_after.revision::text)
    on conflict (idempotency_key) do nothing;
  end if;
  perform public.sponsorship_audit(p_user_id, case when v_resubmit then 'sponsorship.resubmitted' else 'sponsorship.submitted' end, p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), null);
  return v_after;
end;
$$;
revoke all on function public.sponsor_submit_sponsorship(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sponsor_submit_sponsorship(uuid, uuid) to service_role;

create or replace function public.sponsor_cancel_sponsorship(p_user_id uuid, p_id uuid)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_after public.sponsorships;
begin
  v_s := public.sponsor_acting_on(p_user_id, p_id);
  if v_s.lifecycle = 'CANCELLED' then return v_s; end if; -- idempotent
  -- A sponsor may withdraw only what money has not touched; anything paid is resolved by Super Admin (refund policy is operational).
  if not (v_s.lifecycle in ('DRAFT', 'SUBMITTED') and v_s.payment_status in ('UNPAID', 'PENDING', 'FAILED')) then raise exception 'invalid_transition'; end if;
  update public.sponsorships set lifecycle = 'CANCELLED', payment_status = case when payment_status in ('PENDING') then 'CANCELLED' else payment_status end,
    cancelled_by = p_user_id, cancelled_at = now(), cancellation_reason = 'cancelled by sponsor'
  where id = p_id returning * into v_after;
  perform public.sponsorship_audit(p_user_id, 'sponsorship.cancelled', p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), 'cancelled by sponsor');
  return v_after;
end;
$$;
revoke all on function public.sponsor_cancel_sponsorship(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sponsor_cancel_sponsorship(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Super Admin: price, payment, review, suspension, cancellation
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_set_sponsorship_price(p_admin_id uuid, p_id uuid, p_price_cents integer)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_after public.sponsorships;
begin
  perform public.require_super_admin(p_admin_id);
  v_s := public.sponsorship_lock(p_id);
  if v_s.price_cents is not distinct from p_price_cents then return v_s; end if; -- idempotent
  -- Only before commercial commitment: once paid the agreed price is a frozen snapshot.
  if v_s.payment_status not in ('UNPAID', 'PENDING', 'FAILED') or v_s.lifecycle not in ('DRAFT', 'SUBMITTED') then raise exception 'price_locked'; end if;
  update public.sponsorships set price_cents = p_price_cents where id = p_id returning * into v_after;
  perform public.sponsorship_audit(p_admin_id, 'sponsorship.price_set', p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), null);
  return v_after;
end;
$$;
revoke all on function public.admin_set_sponsorship_price(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.admin_set_sponsorship_price(uuid, uuid, integer) to service_role;

create or replace function public.admin_mark_sponsorship_paid(p_admin_id uuid, p_id uuid, p_reference text, p_note text, p_idempotency_key text)
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
  perform public.require_super_admin(p_admin_id);
  v_s := public.sponsorship_lock(p_id);
  -- A retry with the same key (or an already-paid sponsorship) is a no-op: never a second payment event, audit row or activation.
  if exists (select 1 from public.sponsorship_payment_events where idempotency_key = p_idempotency_key) or v_s.payment_status = 'PAID' then return v_s; end if;
  if v_s.lifecycle <> 'SUBMITTED' or v_s.payment_status not in ('UNPAID', 'PENDING', 'FAILED') then raise exception 'invalid_transition'; end if;
  if v_s.price_cents is null then raise exception 'price_missing'; end if;

  insert into public.sponsorship_payment_events (sponsorship_id, event_type, amount_cents, currency, provider, provider_reference, note, actor_id, idempotency_key)
  values (p_id, 'PAID', v_s.price_cents, v_s.currency, 'MANUAL', nullif(btrim(p_reference), ''), nullif(btrim(p_note), ''), p_admin_id, p_idempotency_key);

  update public.sponsorships set payment_status = 'PAID' where id = p_id returning * into v_after;
  -- Payment never activates by itself. It only completes the "paid" half; if (and only if) an approval already stands, the sponsorship moves onto the clock.
  v_intact := v_after.review_status = 'APPROVED' and v_after.approved_hash is not null and v_after.approved_hash = public.sponsorship_material_hash(v_after);
  if v_intact then
    update public.sponsorships set lifecycle = public.sponsorship_scheduled_lifecycle(v_after, now()),
      completed_at = case when now() >= v_after.ends_at then now() else completed_at end
    where id = p_id returning * into v_after;
  end if;
  perform public.sponsorship_audit(p_admin_id, 'sponsorship.payment_confirmed', p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), nullif(btrim(p_note), ''));
  return v_after;
end;
$$;
revoke all on function public.admin_mark_sponsorship_paid(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_mark_sponsorship_paid(uuid, uuid, text, text, text) to service_role;

create or replace function public.admin_record_sponsorship_payment_event(p_admin_id uuid, p_id uuid, p_event text, p_reference text, p_note text, p_idempotency_key text)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_after public.sponsorships;
  v_new public.sponsorship_payment_status;
begin
  perform public.require_super_admin(p_admin_id);
  if p_event not in ('FAILED', 'REFUND_PENDING', 'REFUNDED', 'CANCELLED') then raise exception 'invalid_event'; end if;
  v_new := p_event::public.sponsorship_payment_status;
  v_s := public.sponsorship_lock(p_id);
  if exists (select 1 from public.sponsorship_payment_events where idempotency_key = p_idempotency_key) or v_s.payment_status = v_new then return v_s; end if;

  if not (
    (p_event = 'FAILED' and v_s.payment_status = 'PENDING')
    or (p_event = 'REFUND_PENDING' and v_s.payment_status = 'PAID')
    or (p_event = 'REFUNDED' and v_s.payment_status in ('PAID', 'REFUND_PENDING'))
    or (p_event = 'CANCELLED' and v_s.payment_status in ('UNPAID', 'PENDING', 'FAILED'))
  ) then raise exception 'invalid_transition'; end if;

  insert into public.sponsorship_payment_events (sponsorship_id, event_type, amount_cents, currency, provider, provider_reference, note, actor_id, idempotency_key)
  values (p_id, p_event, v_s.price_cents, v_s.currency, 'MANUAL', nullif(btrim(p_reference), ''), nullif(btrim(p_note), ''), p_admin_id, p_idempotency_key);

  -- Money going back ends the campaign: nothing refunded may stay on the schedule or in public. (Refund POLICY is operational — never automatic.)
  if p_event in ('REFUND_PENDING', 'REFUNDED') and v_s.lifecycle in ('SUBMITTED', 'SCHEDULED', 'LIVE', 'SUSPENDED') then
    update public.sponsorships set payment_status = v_new, lifecycle = 'CANCELLED', cancelled_by = p_admin_id, cancelled_at = now(), cancellation_reason = 'refund: ' || p_event
      where id = p_id returning * into v_after;
  else
    update public.sponsorships set payment_status = v_new where id = p_id returning * into v_after;
  end if;
  perform public.sponsorship_audit(p_admin_id, 'sponsorship.payment_' || lower(p_event), p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), nullif(btrim(p_note), ''));
  return v_after;
end;
$$;
revoke all on function public.admin_record_sponsorship_payment_event(uuid, uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.admin_record_sponsorship_payment_event(uuid, uuid, text, text, text, text) to service_role;

create or replace function public.admin_approve_sponsorship(p_admin_id uuid, p_id uuid, p_expected_revision integer)
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
begin
  perform public.require_super_admin(p_admin_id);
  v_s := public.sponsorship_lock(p_id);
  v_hash := public.sponsorship_material_hash(v_s);
  -- Double-click / retry: already approved as currently written -> nothing changes, nothing is audited twice.
  if v_s.review_status = 'APPROVED' and v_s.approved_hash = v_hash then return v_s; end if;
  if v_s.revision <> p_expected_revision then raise exception 'stale_revision'; end if; -- the sponsor changed it while it was being reviewed
  if v_s.lifecycle <> 'SUBMITTED' or v_s.review_status <> 'PENDING' then raise exception 'invalid_transition'; end if;
  if v_s.ends_at <= now() then raise exception 'campaign_window_passed'; end if;

  select status into v_sponsor_status from public.sponsors where id = v_s.sponsor_id;
  if v_sponsor_status <> 'ACTIVE' then raise exception 'sponsor_not_active'; end if;
  select (p.published_at is not null), f.internal_status::text into v_post_published, v_fixture_status
    from public.posts p join public.fixtures f on f.id = p.fixture_id where p.id = v_s.post_id;
  if not coalesce(v_post_published, false) or v_fixture_status in ('CANCELLED', 'ABANDONED') then raise exception 'post_not_valid'; end if;

  update public.sponsorships set review_status = 'APPROVED', approved_by = p_admin_id, approved_at = now(), approved_hash = v_hash,
    rejected_by = null, rejected_at = null, rejection_reason = null, review_note = null
  where id = p_id returning * into v_after;

  insert into public.sponsorship_approvals (sponsorship_id, revision, content_hash, snapshot, approved_by)
  values (p_id, v_after.revision, v_hash, jsonb_build_object(
    'sponsorId', v_after.sponsor_id, 'postId', v_after.post_id, 'fixtureId', v_after.fixture_id, 'marketCode', v_after.market_code,
    'presentedBy', v_after.presented_by, 'tagline', v_after.tagline, 'ctaText', v_after.cta_text, 'destinationUrl', v_after.destination_url, 'logoPath', v_after.logo_path,
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
revoke all on function public.admin_approve_sponsorship(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.admin_approve_sponsorship(uuid, uuid, integer) to service_role;

create or replace function public.admin_reject_sponsorship(p_admin_id uuid, p_id uuid, p_reason text)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_after public.sponsorships;
begin
  perform public.require_super_admin(p_admin_id);
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason_required'; end if;
  v_s := public.sponsorship_lock(p_id);
  if v_s.lifecycle = 'REJECTED' then return v_s; end if; -- idempotent
  if v_s.lifecycle <> 'SUBMITTED' then raise exception 'invalid_transition'; end if;
  -- Payment is untouched and never silently deleted: the paid-then-rejected case is resolved explicitly through the payment events (refund is operational).
  update public.sponsorships set lifecycle = 'REJECTED', review_status = 'REJECTED', rejected_by = p_admin_id, rejected_at = now(), rejection_reason = btrim(p_reason),
    approved_hash = null, approved_by = null, approved_at = null
  where id = p_id returning * into v_after;
  perform public.sponsorship_audit(p_admin_id, 'sponsorship.rejected', p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), btrim(p_reason));
  return v_after;
end;
$$;
revoke all on function public.admin_reject_sponsorship(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_reject_sponsorship(uuid, uuid, text) to service_role;

create or replace function public.admin_request_sponsorship_changes(p_admin_id uuid, p_id uuid, p_note text)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_after public.sponsorships;
begin
  perform public.require_super_admin(p_admin_id);
  if p_note is null or btrim(p_note) = '' then raise exception 'reason_required'; end if;
  v_s := public.sponsorship_lock(p_id);
  if v_s.review_status = 'CHANGES_REQUESTED' and v_s.lifecycle = 'SUBMITTED' then return v_s; end if; -- idempotent
  if v_s.lifecycle <> 'SUBMITTED' or v_s.review_status <> 'PENDING' then raise exception 'invalid_transition'; end if;
  update public.sponsorships set review_status = 'CHANGES_REQUESTED', review_note = btrim(p_note) where id = p_id returning * into v_after;
  perform public.sponsorship_audit(p_admin_id, 'sponsorship.changes_requested', p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), btrim(p_note));
  return v_after;
end;
$$;
revoke all on function public.admin_request_sponsorship_changes(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_request_sponsorship_changes(uuid, uuid, text) to service_role;

create or replace function public.admin_suspend_sponsorship(p_admin_id uuid, p_id uuid, p_reason text)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_after public.sponsorships;
begin
  perform public.require_super_admin(p_admin_id);
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason_required'; end if;
  v_s := public.sponsorship_lock(p_id);
  if v_s.lifecycle = 'SUSPENDED' then return v_s; end if; -- idempotent
  if v_s.lifecycle not in ('SCHEDULED', 'LIVE') then raise exception 'invalid_transition'; end if;
  update public.sponsorships set lifecycle = 'SUSPENDED', suspended_by = p_admin_id, suspended_at = now(), suspension_reason = btrim(p_reason) where id = p_id returning * into v_after;
  perform public.sponsorship_audit(p_admin_id, 'sponsorship.suspended', p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), btrim(p_reason));
  return v_after;
end;
$$;
revoke all on function public.admin_suspend_sponsorship(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_suspend_sponsorship(uuid, uuid, text) to service_role;

create or replace function public.admin_unsuspend_sponsorship(p_admin_id uuid, p_id uuid)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_after public.sponsorships;
begin
  perform public.require_super_admin(p_admin_id);
  v_s := public.sponsorship_lock(p_id);
  if v_s.lifecycle in ('SCHEDULED', 'LIVE') then return v_s; end if; -- idempotent
  if v_s.lifecycle <> 'SUSPENDED' then raise exception 'invalid_transition'; end if;
  if v_s.payment_status = 'PAID' and v_s.review_status = 'APPROVED' and v_s.approved_hash = public.sponsorship_material_hash(v_s) then
    update public.sponsorships set lifecycle = public.sponsorship_scheduled_lifecycle(v_s, now()), suspended_by = null, suspended_at = null, suspension_reason = null,
      completed_at = case when now() >= v_s.ends_at then now() else completed_at end
    where id = p_id returning * into v_after;
  else
    update public.sponsorships set lifecycle = 'SUBMITTED', suspended_by = null, suspended_at = null, suspension_reason = null where id = p_id returning * into v_after;
  end if;
  perform public.sponsorship_audit(p_admin_id, 'sponsorship.unsuspended', p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), null);
  return v_after;
end;
$$;
revoke all on function public.admin_unsuspend_sponsorship(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_unsuspend_sponsorship(uuid, uuid) to service_role;

create or replace function public.admin_cancel_sponsorship(p_admin_id uuid, p_id uuid, p_reason text)
returns public.sponsorships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.sponsorships;
  v_after public.sponsorships;
begin
  perform public.require_super_admin(p_admin_id);
  if p_reason is null or btrim(p_reason) = '' then raise exception 'reason_required'; end if;
  v_s := public.sponsorship_lock(p_id);
  if v_s.lifecycle = 'CANCELLED' then return v_s; end if; -- idempotent
  if v_s.lifecycle in ('COMPLETED', 'REJECTED') then raise exception 'invalid_transition'; end if;
  -- History is kept: the payment status is NOT rewritten for money that was received (that is resolved through payment events); only unpaid ones close out.
  update public.sponsorships set lifecycle = 'CANCELLED', cancelled_by = p_admin_id, cancelled_at = now(), cancellation_reason = btrim(p_reason),
    payment_status = case when payment_status in ('UNPAID', 'PENDING', 'FAILED') then 'CANCELLED' else payment_status end
  where id = p_id returning * into v_after;
  perform public.sponsorship_audit(p_admin_id, 'sponsorship.cancelled', p_id, public.sponsorship_state_json(v_s), public.sponsorship_state_json(v_after), btrim(p_reason));
  return v_after;
end;
$$;
revoke all on function public.admin_cancel_sponsorship(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_cancel_sponsorship(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Background advance (cron). Public rendering NEVER trusts these transitions: it re-checks eligibility on every read.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.advance_sponsorships(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.sponsorships;
  v_to_live integer := 0;
  v_completed integer := 0;
  v_released integer;
begin
  v_released := public.release_stale_sponsorship_reservations(p_now, null);

  for v_row in select * from public.sponsorships where lifecycle in ('SCHEDULED', 'LIVE') for update skip locked loop
    if p_now >= v_row.ends_at then
      update public.sponsorships set lifecycle = 'COMPLETED', completed_at = p_now where id = v_row.id;
      perform public.sponsorship_audit(null, 'sponsorship.completed', v_row.id, jsonb_build_object('lifecycle', v_row.lifecycle), jsonb_build_object('lifecycle', 'COMPLETED'), null);
      v_completed := v_completed + 1;
    elsif v_row.lifecycle = 'SCHEDULED' and p_now >= v_row.starts_at then
      update public.sponsorships set lifecycle = 'LIVE' where id = v_row.id;
      perform public.sponsorship_audit(null, 'sponsorship.live', v_row.id, jsonb_build_object('lifecycle', 'SCHEDULED'), jsonb_build_object('lifecycle', 'LIVE'), null);
      v_to_live := v_to_live + 1;
    end if;
  end loop;

  return jsonb_build_object('ranAt', p_now, 'wentLive', v_to_live, 'completed', v_completed, 'reservationsReleased', v_released);
end;
$$;
revoke all on function public.advance_sponsorships(timestamptz) from public, anon, authenticated;
grant execute on function public.advance_sponsorships(timestamptz) to service_role;
