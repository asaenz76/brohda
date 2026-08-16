-- provider_request_log has no retention policy and grew to 908MB / 3.87M
-- rows (86% of total DB size) at ~56,000 rows/day since 2026-07-23,
-- pushing the project over its Supabase Free-tier storage and egress
-- quota. This table is a debug/observability log of outbound provider API
-- calls (see lib/sports-data/http.ts) — nothing in the app reads rows
-- older than a few days, so bounded deletion is safe.
--
-- Bounded per call (order by created_at, limit p_batch_size) rather than
-- one unbounded delete: the existing idx_provider_request_log_created_at
-- index (20260101000008_fixtures.sql) makes this an efficient oldest-first
-- scan, and it lets the calling cron job (lib/sports-data/
-- provider-request-log-retention.ts) cap how much work a single tick does
-- — same "bounded work per cron tick" convention as
-- IMPORT_CHUNKS_PER_CRON_TICK (lib/competitions/constants.ts).
create or replace function public.delete_old_provider_request_log_rows(
  p_retention_days integer,
  p_batch_size integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted_count integer;
begin
  delete from public.provider_request_log
  where id in (
    select id from public.provider_request_log
    where created_at < now() - (p_retention_days || ' days')::interval
    order by created_at asc
    limit p_batch_size
  );

  get diagnostics v_deleted_count = row_count;
  return v_deleted_count;
end;
$$;

revoke all on function public.delete_old_provider_request_log_rows(integer, integer) from public;

grant execute on function public.delete_old_provider_request_log_rows(integer, integer) to service_role;
