-- Brohda 2.1 M7 — the activation and return funnel, measured from the rows Brohda already keeps. ONE read-only function; no table, no column, no setting, no trigger and no tracking of any kind.
--
-- The questions (and the canonical rows that answer them — nothing here is a counter or an event log):
--   Activation            registered Members (at least 24 hours old) who made a first Pick within 24 hours   user_profiles.created_at vs min(predictions.created_at)
--   Early retention       activated Members who made a SECOND Pick within 7 days of the first   predictions (the second row by created_at)
--   Result-loop return    Members whose first Pick was graded, who within 48 hours of that result made another Pick or opened their "result is in" notification   predictions.graded_at, predictions.created_at, notifications.read_at
--   Social                Members who ever commented / started a Call BS                post_comments.user_id, challenges.challenger_user_id
--   Competitive           Members ranked on this week's leaderboard                     get_weekly_leaderboard() (the same rule the page uses; the weekly minimum is a setting)
--
-- Only AGGREGATES leave the database: counts, one median, and per-week cohort counts. No Member id, no name, no email, no content. A denominator only counts Members old enough to have had the chance
-- (24 hours / 7 days / 48 hours must have passed), so a fresh signup is never counted as a failure. Signed-out visits and "signup started" are NOT in the database and are deliberately not invented here.
--
-- Service role only (the Super Admin report reads it on the server). Rollback = drop the function; nothing depends on it.

create or replace function public.activation_funnel_summary(p_from timestamptz default now() - interval '30 days', p_to timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_min integer;
  v_ranked bigint;
begin
  select leaderboard_weekly_min_decided_picks into v_min from public.platform_settings where id = true;
  select coalesce((public.get_weekly_leaderboard(null, 1) ->> 'total_ranked')::bigint, 0) into v_ranked;

  with cohort as (
    select up.id, up.created_at from public.user_profiles up
    where up.role = 'player' and up.created_at >= p_from and up.created_at < p_to
  ),
  firsts as (
    select c.id, c.created_at, min(p.created_at) as first_pick
    from cohort c left join public.predictions p on p.user_id = c.id
    group by c.id, c.created_at
  ),
  seconds as (
    select f.id, f.first_pick,
           (select p2.created_at from public.predictions p2 where p2.user_id = f.id order by p2.created_at, p2.id offset 1 limit 1) as second_pick
    from firsts f where f.first_pick is not null
  ),
  graded as (
    select c.id, min(p.graded_at) as first_graded
    from cohort c join public.predictions p on p.user_id = c.id and p.lifecycle_state = 'GRADED' and p.graded_at is not null
    group by c.id
  ),
  returned as (
    select g.id, g.first_graded,
           (exists (select 1 from public.predictions p3 where p3.user_id = g.id and p3.created_at > g.first_graded and p3.created_at <= g.first_graded + interval '48 hours')
            or exists (select 1 from public.notifications n where n.user_id = g.id and n.type = 'prediction_graded' and n.read_at is not null and n.read_at >= n.created_at and n.read_at <= g.first_graded + interval '48 hours')) as came_back
    from graded g
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'registered', (select count(*) from cohort),
    'registered_24h_old', (select count(*) from cohort where created_at <= now() - interval '24 hours'),
    'picked_ever', (select count(*) from firsts where first_pick is not null),
    'picked_within_24h', (select count(*) from firsts where created_at <= now() - interval '24 hours' and first_pick is not null and first_pick <= created_at + interval '24 hours'),
    'median_minutes_to_first_pick', (select round((percentile_cont(0.5) within group (order by extract(epoch from (first_pick - created_at)) / 60))::numeric, 1) from firsts where first_pick is not null),
    'activated_7d_old', (select count(*) from firsts where first_pick is not null and first_pick <= now() - interval '7 days'),
    'second_pick_within_7d', (select count(*) from seconds where first_pick <= now() - interval '7 days' and second_pick is not null and second_pick <= first_pick + interval '7 days'),
    'first_graded_48h_old', (select count(*) from returned where first_graded <= now() - interval '48 hours'),
    'came_back_within_48h', (select count(*) from returned where first_graded <= now() - interval '48 hours' and came_back),
    'commented', (select count(distinct c.id) from cohort c join public.post_comments pc on pc.user_id = c.id),
    'called_bs', (select count(distinct c.id) from cohort c join public.challenges ch on ch.challenger_user_id = c.id),
    'weekly_min_decided', v_min,
    'ranked_this_week', v_ranked,
    'by_week', (select coalesce(jsonb_agg(jsonb_build_object('week', w.week, 'registered', w.registered, 'registered_24h_old', w.aged, 'picked_within_24h', w.picked) order by w.week), '[]'::jsonb)
                from (select date_trunc('week', f.created_at at time zone 'America/Costa_Rica')::date as week, count(*) as registered,
                             count(*) filter (where f.created_at <= now() - interval '24 hours') as aged,
                             count(*) filter (where f.created_at <= now() - interval '24 hours' and f.first_pick is not null and f.first_pick <= f.created_at + interval '24 hours') as picked
                      from firsts f group by 1) w)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.activation_funnel_summary(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.activation_funnel_summary(timestamptz, timestamptz) to service_role;

comment on function public.activation_funnel_summary(timestamptz, timestamptz) is
  'M7: aggregate activation and return funnel for players registered in [p_from, p_to), derived at read time from predictions, notifications, comments and challenges. Counts only (no Member id, name, email or content). Service role only.';
