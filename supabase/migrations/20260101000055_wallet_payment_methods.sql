-- Configurable payment methods for the Add Funds / Transfer Out forms.
-- Mirrors platform_settings' pattern: no client write policy at all,
-- service-role-only mutation via a server action. A fixed set of 6 rows
-- (one per currency/rail) rather than a freeform table, since the admin UI
-- is "toggle each of these on/off and set its destination", not "manage an
-- arbitrary list".
create type public.payment_method_key as enum ('USDC', 'USDT', 'VENMO', 'CASHAPP', 'ZELLE', 'OTHER');

create table public.payment_methods (
  method public.payment_method_key primary key,
  enabled boolean not null default false,
  destination text,
  instructions text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.user_profiles (id)
);

alter table public.payment_methods enable row level security;
grant select on public.payment_methods to authenticated;
grant select, update on public.payment_methods to service_role;

create policy "authenticated can read payment methods"
  on public.payment_methods for select
  to authenticated
  using (true);

insert into public.payment_methods (method) values
  ('USDC'), ('USDT'), ('VENMO'), ('CASHAPP'), ('ZELLE'), ('OTHER');

-- All three nullable: existing wallet_requests rows and the quick-top-up
-- flow (TopUpAndJoinModal, which stays on its own minimal Amount+Note
-- submission) never set these.
alter table public.wallet_requests
  add column payment_method public.payment_method_key,
  add column other_method_note text,
  add column transaction_ref text;
