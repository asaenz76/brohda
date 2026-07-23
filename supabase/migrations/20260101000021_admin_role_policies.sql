-- Continuation of 20260101000020_admin_role.sql: the broader read/
-- moderation gates that use the 'admin' enum value added there. Split out
-- because the enum value must commit in its own transaction before it can
-- be referenced (see that file's header comment).

-- Mirrors is_super_admin(uid) (20260101000002_user_profiles.sql) exactly,
-- just with a wider role set. Kept as a separate function rather than
-- changing is_super_admin itself, since every wallet/settlement/
-- reversal/reporting gate must keep meaning "super_admin, and only
-- super_admin".
create or replace function public.is_admin_or_above(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.user_profiles
    where id = uid and role in ('super_admin', 'admin') and is_active = true
  );
$$;

revoke all on function public.is_admin_or_above(uuid) from public;
grant execute on function public.is_admin_or_above(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Broaden to is_admin_or_above: pure admin-panel visibility/management,
-- nothing money- or account-related. RLS policies have no CREATE OR
-- REPLACE, so each is dropped and recreated.
-- ---------------------------------------------------------------------

drop policy "select_all_profiles_as_admin" on public.user_profiles;
create policy "select_all_profiles_as_admin"
on public.user_profiles for select
to authenticated
using (public.is_admin_or_above(auth.uid()));

drop policy "admins_manage_invitations" on public.invitations;
create policy "admins_manage_invitations"
on public.invitations for all
to authenticated
using (public.is_admin_or_above(auth.uid()))
with check (public.is_admin_or_above(auth.uid()));

drop policy "admins_read_provider_request_log" on public.provider_request_log;
create policy "admins_read_provider_request_log"
on public.provider_request_log for select
to authenticated
using (public.is_admin_or_above(auth.uid()));

drop policy "admins_can_read_all_pools" on public.pools;
create policy "admins_can_read_all_pools"
on public.pools for select
to authenticated
using (public.is_admin_or_above(auth.uid()));

drop policy "admins_can_read_all_entries" on public.entries;
create policy "admins_can_read_all_entries"
on public.entries for select
to authenticated
using (public.is_admin_or_above(auth.uid()));

drop policy "admins_read_background_jobs" on public.background_jobs;
create policy "admins_read_background_jobs"
on public.background_jobs for select
to authenticated
using (public.is_admin_or_above(auth.uid()));

drop policy "read_comments_on_readable_pools" on public.pool_comments;
create policy "read_comments_on_readable_pools"
on public.pool_comments for select
to authenticated
using (
  exists (
    select 1 from public.pools p
    where p.id = pool_comments.pool_id
      and (p.status != 'DRAFT' or public.is_admin_or_above(auth.uid()))
  )
);

-- settlements_visible_with_pool's USING clause references is_super_admin
-- inside an exists(...) over pools, not as its own top-level policy
-- condition — same drop/recreate shape either way.
drop policy "settlements_visible_with_pool" on public.settlements;
create policy "settlements_visible_with_pool"
on public.settlements for select
to authenticated
using (
  exists (
    select 1 from public.pools p
    where p.id = settlements.pool_id
      and (p.status != 'DRAFT' or public.is_admin_or_above(auth.uid()))
  )
);

-- Views support CREATE OR REPLACE directly.
create or replace view public.pool_options_public as
select
  po.id,
  po.pool_id,
  po.label,
  po.external_team_id,
  po.team_name,
  po.logo_url,
  po.sort_order,
  po.is_winning_option,
  po.created_at,
  case when public.can_view_pool_distribution(po.pool_id) then po.entry_count else null end
    as entry_count,
  case when public.can_view_pool_distribution(po.pool_id) then po.total_entry_amount else null end
    as total_entry_amount
from public.pool_options po
join public.pools p on p.id = po.pool_id
where p.status != 'DRAFT' or public.is_admin_or_above(auth.uid());

-- The actual comment-moderation gate the 'admin' role exists partly for:
-- delete any user's comment, not just your own.
create or replace function public.delete_pool_comment(p_comment_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_comment public.pool_comments;
begin
  select * into v_comment from public.pool_comments where id = p_comment_id;
  if not found then
    return;
  end if;

  if v_comment.user_id != p_user_id and not public.is_admin_or_above(p_user_id) then
    raise exception 'not_authorized';
  end if;

  delete from public.pool_comments where id = p_comment_id;
  update public.pools set comment_count = greatest(comment_count - 1, 0) where id = v_comment.pool_id;
end;
$$;

revoke all on function public.delete_pool_comment(uuid, uuid) from public;
grant execute on function public.delete_pool_comment(uuid, uuid) to service_role;

-- Story-eligibility check (not an authorization gate) — a literal
-- `role = 'super_admin'` comparison, not routed through is_super_admin,
-- so broadening the helper above doesn't affect it. Since 'admin' can now
-- publish pools too, their publishes should also be story-worthy.
create or replace function public.get_stories_row(p_viewer_id uuid, p_since timestamptz)
returns table (user_id uuid, display_name text, username text, avatar_url text)
language sql
security definer
set search_path = public
stable
as $$
  select distinct up.id, up.display_name, up.username, up.avatar_url
  from public.user_profiles up
  where up.is_active = true
    and up.id in (select f.followee_id from public.follows f where f.follower_id = p_viewer_id)
    and (
      exists (
        select 1 from public.entries e
        where e.user_id = up.id and e.status = 'ACTIVE' and e.created_at > p_since
      )
      or (
        up.role in ('super_admin', 'admin')
        and exists (
          select 1 from public.pools p
          where p.created_by = up.id and p.status != 'DRAFT' and p.created_at > p_since
        )
      )
    );
$$;

revoke all on function public.get_stories_row(uuid, timestamptz) from public;
grant execute on function public.get_stories_row(uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Deliberately left unchanged (still is_super_admin-only): money
-- movement and raw dollar visibility (wallet_balances, wallet_transactions,
-- wallet_requests, settlement_payouts' per-user payout amounts), audit_logs
-- (embeds wallet/settlement before/after payloads), and
-- admin_update_any_profile (writing another user's role/is_active is
-- already excluded from authenticated's column grant regardless — the
-- real boundary for role/account changes is the service-role-only server
-- action in lib/actions/users.ts, not this RLS policy).
-- ---------------------------------------------------------------------
