-- Phase 1: invite-only registration (spec §7, §18)

create type public.invitation_status as enum ('pending', 'accepted', 'expired', 'revoked');

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  token uuid not null unique default gen_random_uuid(),
  email text not null,
  status public.invitation_status not null default 'pending',
  invited_by uuid not null references public.user_profiles (id),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index invitations_status_idx on public.invitations (status);
create index invitations_email_idx on public.invitations (email);

alter table public.invitations enable row level security;

-- Admin-only via RLS. The public accept-invitation flow (unauthenticated,
-- token in URL) is looked up server-side with the service role and never
-- reads this table through the client/anon key.
create policy "admins_manage_invitations"
on public.invitations for all
to authenticated
using (public.is_super_admin(auth.uid()))
with check (public.is_super_admin(auth.uid()));

grant select, insert, update, delete on public.invitations to authenticated;
grant select, insert, update, delete on public.invitations to service_role;
