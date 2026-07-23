-- Permanent audit trail for template-driven grading (lib/pools/templates/grade.ts).
-- One row per grading attempt: what the template computed, why, and the
-- exact normalized values it read. No FK on pool_id (mirrors
-- audit_logs.entity_id) so delete_terminal_pool hard-deleting a pool never
-- needs to touch or is blocked by this table — evidence survives forever.
create table public.pool_grading_evidence (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null,
  settlement_id uuid references public.settlements (id),
  template_id text not null,
  result text not null check (result in ('YES', 'NO', 'VOID', 'PENDING')),
  reason text not null,
  evidence jsonb not null default '[]',
  graded_at timestamptz not null default now()
);

create index pool_grading_evidence_pool_id_idx on public.pool_grading_evidence (pool_id);

alter table public.pool_grading_evidence enable row level security;

create policy "super_admins_read_pool_grading_evidence"
on public.pool_grading_evidence for select
to authenticated
using (public.is_super_admin(auth.uid()));

-- Append-only: no client inserts/updates/deletes. Writes happen exclusively
-- through gradeTemplatePool using the service role.
grant select on public.pool_grading_evidence to authenticated;
grant select, insert on public.pool_grading_evidence to service_role;

create or replace function public.forbid_pool_grading_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'pool_grading_evidence is append-only';
end;
$$;

create trigger pool_grading_evidence_no_update
before update on public.pool_grading_evidence
for each row execute function public.forbid_pool_grading_evidence_mutation();

create trigger pool_grading_evidence_no_delete
before delete on public.pool_grading_evidence
for each row execute function public.forbid_pool_grading_evidence_mutation();
