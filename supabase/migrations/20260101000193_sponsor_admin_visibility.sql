-- Sponsor hide / archive (r72): ADMIN LIST VISIBILITY, separate from account status.
--
--   status     (sponsors.status)           answers "can this Sponsor operate?"       — unchanged by anything here
--   visibility (sponsor_admin_hidden)      answers "does it appear in the normal admin Sponsors list?"
--
-- Hiding changes nothing else: the Sponsor, its status, login, sponsorships, payments, legal acceptances, audit history, impressions and clicks all stay exactly as they were, and
-- hidden-ness is not part of any eligibility rule (a Sponsor's public campaigns follow sponsorship state, payment, approval, window, Sponsor status and the capability — never this).
-- Nothing is ever deleted.
--
-- Why its own table and not a column on sponsors: `sponsors` is readable by the Sponsor's own login (table-level grant + a row policy), and an ADMIN-ONLY flag must not be. This table is
-- service-role only (RLS on, no policy, no grants), and it is additive — no prior Sponsor migration or column is touched. A row exists exactly while the Sponsor is hidden
-- (`hidden_at` says since when); unhiding removes it. Every Sponsor starts visible (no row), including Berria Bikes: nothing is auto-hidden.

create table public.sponsor_admin_hidden (
  sponsor_id uuid primary key references public.sponsors (id),
  hidden_at  timestamptz not null default now()
);
alter table public.sponsor_admin_hidden enable row level security;
revoke all on public.sponsor_admin_hidden from public, anon, authenticated;
grant all on public.sponsor_admin_hidden to service_role;

-- Hide or unhide one Sponsor. Super Admin only. Idempotent: repeating a request changes and audits nothing. The audit records WHICH Sponsor, WHO and WHEN (audit_logs.created_at) —
-- no copy of the Sponsor's data. It never touches the Sponsor's status.
create or replace function public.admin_set_sponsor_hidden(p_admin_id uuid, p_sponsor_id uuid, p_hidden boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed integer;
begin
  perform public.require_super_admin(p_admin_id);
  if not exists (select 1 from public.sponsors where id = p_sponsor_id) then raise exception 'sponsor_not_found'; end if;
  if p_hidden then
    insert into public.sponsor_admin_hidden (sponsor_id) values (p_sponsor_id) on conflict (sponsor_id) do nothing;
    get diagnostics v_changed = row_count;
    if v_changed > 0 then perform public.sponsor_audit(p_admin_id, 'sponsor.hidden', p_sponsor_id, null, null, null); end if;
  else
    delete from public.sponsor_admin_hidden where sponsor_id = p_sponsor_id;
    get diagnostics v_changed = row_count;
    if v_changed > 0 then perform public.sponsor_audit(p_admin_id, 'sponsor.unhidden', p_sponsor_id, null, null, null); end if;
  end if;
  return p_hidden;
end;
$$;
revoke all on function public.admin_set_sponsor_hidden(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.admin_set_sponsor_hidden(uuid, uuid, boolean) to service_role;
