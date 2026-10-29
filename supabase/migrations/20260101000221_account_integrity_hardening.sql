-- M9 — Account integrity & abuse hardening (additive; no data is changed or removed).
--
-- 1. check_and_increment_rate_limit: the old body read the row FOR UPDATE and inserted when none was found. Two first requests for the same key both saw "no row", both inserted, and the loser raised a
--    unique violation — which the application (which fails open on any error) counted as ALLOWED, so every fresh key let one extra request through. It is now ONE atomic INSERT … ON CONFLICT DO UPDATE:
--    exactly p_max_attempts calls per window succeed, whatever the concurrency, and a denied call never raises. The counter is capped at max + 1 (the old function also stopped counting once the limit was reached).
--    The function was also executable by `anon` and `authenticated` with ANY identifier, so anybody holding the public anon key could spend another person's bucket (`login:<their email>` locks them out of
--    signing in for the window). Every caller now goes through the service role (lib/rate-limit/check.ts), so the execute grant is narrowed to service_role — like messaging_rate_limit, which already is.
-- 2. prune_rate_limits: the table gained a row for every distinct key ever seen and never lost one; the 5-minute housekeeping job now prunes expired rows.
-- 3. reclaimable_orphan_auth_user: a login created straight through the public Auth API (anyone with the anon key can do it) for somebody else's address — never confirmed, never signed in, no account type, no profile —
--    blocks that person's Member sign-up ("already registered") and can be used to pre-set the password on the address. Registration may replace such an orphan, never anything that has been used.
-- 4. reserved_usernames: a small, data-driven list of handles that could impersonate the platform. Enforced for player profiles by a trigger so no code path can bypass it; staff profiles are exempt.

create or replace function public.check_and_increment_rate_limit(
  p_identifier text,
  p_window_seconds integer,
  p_max_attempts integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.rate_limits as r (identifier, window_start, attempt_count)
  values (p_identifier, now(), 1)
  on conflict (identifier) do update
    set window_start  = case when now() - r.window_start > make_interval(secs => p_window_seconds) then now() else r.window_start end,
        attempt_count = case when now() - r.window_start > make_interval(secs => p_window_seconds) then 1 else least(r.attempt_count + 1, p_max_attempts + 1) end
  returning attempt_count into v_count;

  return v_count <= p_max_attempts;
end;
$$;

revoke all on function public.check_and_increment_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_and_increment_rate_limit(text, integer, integer) to service_role;

create index if not exists rate_limits_window_start_idx on public.rate_limits (window_start);

create or replace function public.prune_rate_limits(p_older_than interval default interval '2 days', p_batch integer default 5000)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  with doomed as (
    select identifier from public.rate_limits where window_start < now() - p_older_than order by window_start limit greatest(p_batch, 1) for update skip locked
  )
  delete from public.rate_limits r using doomed d where r.identifier = d.identifier;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.prune_rate_limits(interval, integer) from public, anon, authenticated;
grant execute on function public.prune_rate_limits(interval, integer) to service_role;

create or replace function public.reclaimable_orphan_auth_user(p_email text, p_min_age interval default interval '10 minutes')
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select u.id
  from auth.users u
  where lower(u.email) = lower(btrim(p_email))
    and u.email_confirmed_at is null
    and u.last_sign_in_at is null
    and u.created_at < now() - p_min_age
    and not exists (select 1 from public.account_types t where t.user_id = u.id)
    and not exists (select 1 from public.user_profiles p where p.id = u.id)
  limit 1;
$$;

revoke all on function public.reclaimable_orphan_auth_user(text, interval) from public, anon, authenticated;
grant execute on function public.reclaimable_orphan_auth_user(text, interval) to service_role;

create table public.reserved_usernames (
  username   text primary key check (username = lower(username) and username ~ '^[a-z0-9_]{3,24}$'),
  reason     text not null default 'platform identity',
  created_at timestamptz not null default now()
);

comment on table public.reserved_usernames is 'Handles a Member may not take because they could pass for the platform or its staff. Edited with SQL for now; keep it short — profanity and other product policy do not belong here.';

alter table public.reserved_usernames enable row level security;
revoke all on public.reserved_usernames from public, anon, authenticated;
grant select, insert, update, delete on public.reserved_usernames to service_role;

insert into public.reserved_usernames (username) values
  ('admin'), ('administrator'), ('brohda'), ('moderator'), ('official'), ('root'), ('security'), ('staff'), ('support'), ('system');

create or replace function public.enforce_username_not_reserved()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.username is not null
     and new.role = 'player'
     and (tg_op = 'INSERT' or new.username is distinct from old.username)
     and exists (select 1 from public.reserved_usernames r where r.username = lower(new.username)) then
    raise exception 'reserved_username' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger user_profiles_username_not_reserved
  before insert or update of username on public.user_profiles
  for each row execute function public.enforce_username_not_reserved();
