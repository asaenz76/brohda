-- Phase 1: append-only audit log (spec §6.1, §19, Appendix Y #33)

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.user_profiles (id),
  action text not null,
  entity_type text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  reason text,
  ip inet,
  created_at timestamptz not null default now()
);

create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_created_at_idx on public.audit_logs (created_at desc);

alter table public.audit_logs enable row level security;

create policy "admins_read_audit_logs"
on public.audit_logs for select
to authenticated
using (public.is_super_admin(auth.uid()));

-- Append-only: no client inserts/updates/deletes. Writes happen exclusively
-- through server actions using the service role.
grant select on public.audit_logs to authenticated;
grant select, insert on public.audit_logs to service_role;

create or replace function public.forbid_audit_log_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_logs is append-only';
end;
$$;

create trigger audit_logs_no_update
before update on public.audit_logs
for each row execute function public.forbid_audit_log_mutation();

create trigger audit_logs_no_delete
before delete on public.audit_logs
for each row execute function public.forbid_audit_log_mutation();
