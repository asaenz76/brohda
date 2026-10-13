-- Egress / request-volume reduction for the recurring cron jobs (r75).
--
-- Production hit the Supabase Free-plan egress quota (HTTP 402 exceed_egress_quota) because three jobs re-read and re-checked their ENTIRE
-- working set on every tick even when nothing needed doing:
--   * distribute-posts   re-walked every published Post (~14 API requests each) every ~10 minutes and re-inserted the same Post<->Community links,
--                        which Postgres logged as a duplicate-key error each time;
--   * publish-posts      paged every upcoming Game id, then every Post and Market for them in 150-id chunks, every ~5 minutes;
--   * background_jobs    grew without bound (every run inserts a row; nothing ever deletes one).
-- Each fix below moves "what still needs work?" into ONE set-based database call that returns only the remainder. The decision rules are exactly
-- the ones the application code applied before — only where they run changes — so behaviour is identical and the work shrinks to what is left.
--
-- Everything here is forward-only and callable by service_role only (the same posture as every other cron helper: try_acquire_cron_lock,
-- delete_old_provider_request_log_rows).

-- 1. Published Posts that still lack some of the Community links the distribution policy expects. A Post is complete once it has the policy's expected
--    number of links (home + away team, league, sport, each only when its policy flag is on); anything with fewer is returned for the per-Post pass.
create or replace function public.posts_needing_distribution(p_expected_links integer)
returns table (id uuid, fixture_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.fixture_id
  from public.posts p
  where p.published_at is not null
    and (select count(*) from public.post_communities pc where pc.post_id = p.id) < p_expected_links
  order by p.id;
$$;

revoke all on function public.posts_needing_distribution(integer) from public, anon, authenticated;
grant execute on function public.posts_needing_distribution(integer) to service_role;

-- 2. Not-yet-started Games that still need publishing work. Mirrors lib/posts/publication.ts exactly: a Game is a candidate when it is not published
--    AND (the policy does not require an active Market, OR it has an ACTIVE Market, OR it has no Post row yet — the Post is still created unpublished,
--    ready the moment a Market appears).
create or replace function public.fixtures_needing_publication(p_providers text[], p_requires_active_market boolean)
returns table (id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select f.id
  from public.fixtures f
  where f.provider = any (p_providers)
    and f.internal_status = 'NOT_STARTED'
    and f.scheduled_start_utc > now()
    and not exists (select 1 from public.posts p where p.fixture_id = f.id and p.published_at is not null)
    and (
      not p_requires_active_market
      or exists (select 1 from public.markets m where m.fixture_id = f.id and m.status = 'ACTIVE')
      or not exists (select 1 from public.posts p where p.fixture_id = f.id)
    )
  order by f.id;
$$;

revoke all on function public.fixtures_needing_publication(text[], boolean) from public, anon, authenticated;
grant execute on function public.fixtures_needing_publication(text[], boolean) to service_role;

-- 3. background_jobs retention. Every cron run writes one row and nothing deleted any: ~359,000 rows / 220 MB (about two thirds of the whole database)
--    after ~80 days, ~274,000 of them from jobs that no longer exist. Job Health, the readiness loader and the reports only ever read the most recent
--    few hundred rows, so older history is safe to discard.
--
--    The retention window is an operator setting (platform_settings.background_job_retention_days), not a constant in code. Whatever the window, the
--    newest p_keep_latest_per_job rows of EVERY job name are always kept, so a job that runs rarely — or one that was discontinued — still shows its
--    last known runs, and Job Health can never regress to "never run" because of pruning.
alter table public.platform_settings
  add column background_job_retention_days integer not null default 14
    check (background_job_retention_days >= 1 and background_job_retention_days <= 3650);

comment on column public.platform_settings.background_job_retention_days is
  'How many days of cron run history (background_jobs) to keep. Older rows are deleted in small batches by the prune-provider-request-log cron, except that the newest rows of every job name are always kept. Purely housekeeping — no job''s scheduling or correctness depends on it.';

-- Bounded per call (at most p_batch_size rows) so the calling cron can cap the work of one tick and stay under the 8 s statement timeout every
-- PostgREST call runs under (see lib/sports-data/provider-request-log-retention.ts). The per-job cutoff uses idx_background_jobs_name_finished
-- (job_name, finished_at desc): the cutoff for a job is the OLDER of "now - retention" and "the finished_at of its Nth newest row", so the newest
-- rows are never eligible no matter how old they are.
create or replace function public.delete_old_background_jobs_rows(
  p_retention_days integer,
  p_batch_size integer,
  p_keep_latest_per_job integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job text;
  v_cutoff timestamptz;
  v_kept_from timestamptz;
  v_deleted integer := 0;
  v_step integer;
begin
  for v_job in select distinct job_name from public.background_jobs loop
    exit when v_deleted >= p_batch_size;

    select b.finished_at into v_kept_from
    from public.background_jobs b
    where b.job_name = v_job
    order by b.finished_at desc
    offset greatest(p_keep_latest_per_job, 1) - 1 limit 1;

    -- Fewer than p_keep_latest_per_job rows for this job: everything is "newest", nothing to delete.
    continue when v_kept_from is null;

    v_cutoff := least(now() - make_interval(days => p_retention_days), v_kept_from);

    delete from public.background_jobs
    where id in (
      select b.id from public.background_jobs b
      where b.job_name = v_job and b.finished_at < v_cutoff
      order by b.finished_at asc
      limit p_batch_size - v_deleted
    );

    get diagnostics v_step = row_count;
    v_deleted := v_deleted + v_step;
  end loop;

  return v_deleted;
end;
$$;

revoke all on function public.delete_old_background_jobs_rows(integer, integer, integer) from public, anon, authenticated;
grant execute on function public.delete_old_background_jobs_rows(integer, integer, integer) to service_role;
