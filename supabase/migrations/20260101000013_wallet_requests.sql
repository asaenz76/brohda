-- Player-facing wallet requests: a player asks for a deposit or withdrawal;
-- an admin approves (which credits/debits via the existing
-- apply_wallet_transaction RPC, unchanged) or rejects (no money movement).
-- Separate from wallet_transactions — a request is not itself a financial
-- event, only its approval is.

create type public.wallet_request_type as enum ('deposit', 'withdrawal');
create type public.wallet_request_status as enum ('pending', 'approved', 'rejected');

create table public.wallet_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles (id) on delete cascade,
  type public.wallet_request_type not null,
  amount bigint not null check (amount > 0),
  status public.wallet_request_status not null default 'pending',
  note text,
  admin_id uuid references public.user_profiles (id),
  admin_note text,
  reviewed_at timestamptz,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create index wallet_requests_user_idx on public.wallet_requests (user_id, created_at desc);
create index wallet_requests_status_idx on public.wallet_requests (status, created_at desc);

alter table public.wallet_requests enable row level security;

create policy "select_own_wallet_requests"
on public.wallet_requests for select
to authenticated
using (user_id = auth.uid());

create policy "select_all_wallet_requests_as_admin"
on public.wallet_requests for select
to authenticated
using (public.is_super_admin(auth.uid()));

-- No INSERT/UPDATE grant to authenticated — even the player's own "submit a
-- request" action goes through the service role (requireUser() scopes it
-- to the caller's own id server-side), matching every other wallet-adjacent
-- write in this codebase.
grant select on public.wallet_requests to authenticated;
grant select, insert, update on public.wallet_requests to service_role;
