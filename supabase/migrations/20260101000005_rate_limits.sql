-- Phase 1: login rate limiting (spec §19), implemented in Postgres so no
-- extra infra (e.g. Redis) is required beyond the existing Supabase stack.

create table public.rate_limits (
  identifier text primary key,
  window_start timestamptz not null default now(),
  attempt_count integer not null default 0
);

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
  v_row public.rate_limits;
begin
  select * into v_row from public.rate_limits where identifier = p_identifier for update;

  if not found then
    insert into public.rate_limits (identifier, window_start, attempt_count)
    values (p_identifier, now(), 1);
    return true;
  end if;

  if now() - v_row.window_start > (p_window_seconds || ' seconds')::interval then
    update public.rate_limits
      set window_start = now(), attempt_count = 1
      where identifier = p_identifier;
    return true;
  end if;

  if v_row.attempt_count >= p_max_attempts then
    return false;
  end if;

  update public.rate_limits
    set attempt_count = attempt_count + 1
    where identifier = p_identifier;
  return true;
end;
$$;

revoke all on function public.check_and_increment_rate_limit(text, integer, integer) from public;
grant execute on function public.check_and_increment_rate_limit(text, integer, integer)
  to anon, authenticated, service_role;

alter table public.rate_limits enable row level security;

-- No direct table access for anon/authenticated: only reachable via the
-- SECURITY DEFINER function above.
grant all on public.rate_limits to service_role;
