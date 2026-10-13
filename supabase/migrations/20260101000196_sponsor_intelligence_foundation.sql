-- Sponsor Intelligence foundation (r77): aggregate-only campaign reporting for Sponsors, with exact numbers for Super Admin.
--
-- What already existed and is REUSED, not duplicated: `sponsorship_exposure_events` (signed-in-Member impressions, one per member per UTC day, and first-party link clicks —
-- INTERNAL, Super-Admin-read-only by RLS) plus the ordinary prediction / comment / Call BS / community-follow tables. Nothing here adds a second measurement store.
--
-- What is new:
--   1. Three platform settings. The capability is its own switch (`sponsor_intelligence_enabled`, default OFF, separate from `sponsorship_enabled`). The privacy threshold and the
--      affinity look-back are policy, so they are settings, not constants. The only hard rule in the database is that a threshold below 2 is meaningless (a count of 1 IS one person).
--   2. One audited, Super-Admin-only function to change those settings.
--   3. One aggregate function. It is callable ONLY by service_role (the server), returns exact counts as a single JSON document, and by construction never contains a Member id,
--      name, e-mail or any per-Member row. Small-cohort suppression is applied by the application (lib/sponsor-intelligence/suppression.ts) when the Sponsor view is built; Super Admin
--      sees the exact numbers.
--   Only Members count: `user_profiles.role = 'player'`. Staff accounts (admins testing a campaign) never inflate a Sponsor's numbers, and Sponsor logins have no profile at all.

alter table public.platform_settings
  add column sponsor_intelligence_enabled boolean not null default false,
  add column sponsor_intelligence_min_cohort integer not null default 10 check (sponsor_intelligence_min_cohort >= 2 and sponsor_intelligence_min_cohort <= 10000),
  add column sponsor_intelligence_affinity_lookback_days integer not null default 90 check (sponsor_intelligence_affinity_lookback_days >= 1 and sponsor_intelligence_affinity_lookback_days <= 730);

comment on column public.platform_settings.sponsor_intelligence_enabled is
  'Sponsor Intelligence capability. OFF (default, and on any unreadable value) = Sponsors see no analytics at all. Separate from sponsorship_enabled. Super Admin and internal measurement are unaffected.';
comment on column public.platform_settings.sponsor_intelligence_min_cohort is
  'Privacy threshold for Sponsor-facing analytics: any figure based on fewer than this many Members (or events) is suppressed. The database floor is 2, because a count of 1 identifies a person.';
comment on column public.platform_settings.sponsor_intelligence_affinity_lookback_days is
  'How many days of Pick history the sport-affinity breakdown looks back over, for the Members a campaign reached.';

-- Super Admin sets the Sponsor Intelligence policy. Audited (on/off, threshold, look-back only).
create or replace function public.admin_set_sponsor_intelligence_config(p_admin_id uuid, p_enabled boolean, p_min_cohort integer, p_lookback_days integer)
returns public.platform_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.platform_settings;
  v_after public.platform_settings;
begin
  perform public.require_super_admin(p_admin_id);
  if p_enabled is null then raise exception 'invalid_enabled'; end if;
  if p_min_cohort is null or p_min_cohort < 2 or p_min_cohort > 10000 then raise exception 'invalid_min_cohort'; end if;
  if p_lookback_days is null or p_lookback_days < 1 or p_lookback_days > 730 then raise exception 'invalid_lookback_days'; end if;
  select * into v_before from public.platform_settings where id = true for update;
  update public.platform_settings
    set sponsor_intelligence_enabled = p_enabled, sponsor_intelligence_min_cohort = p_min_cohort, sponsor_intelligence_affinity_lookback_days = p_lookback_days,
        updated_at = now(), updated_by = p_admin_id
    where id = true returning * into v_after;
  if v_before.sponsor_intelligence_enabled is distinct from v_after.sponsor_intelligence_enabled
     or v_before.sponsor_intelligence_min_cohort is distinct from v_after.sponsor_intelligence_min_cohort
     or v_before.sponsor_intelligence_affinity_lookback_days is distinct from v_after.sponsor_intelligence_affinity_lookback_days then
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after)
    values (p_admin_id, 'settings.sponsor_intelligence_updated', 'platform_settings', null,
      jsonb_build_object('enabled', v_before.sponsor_intelligence_enabled, 'minCohort', v_before.sponsor_intelligence_min_cohort, 'affinityLookbackDays', v_before.sponsor_intelligence_affinity_lookback_days),
      jsonb_build_object('enabled', v_after.sponsor_intelligence_enabled, 'minCohort', v_after.sponsor_intelligence_min_cohort, 'affinityLookbackDays', v_after.sponsor_intelligence_affinity_lookback_days));
  end if;
  return v_after;
end;
$$;
revoke all on function public.admin_set_sponsor_intelligence_config(uuid, boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_set_sponsor_intelligence_config(uuid, boolean, integer, integer) to service_role;

-- Exact campaign aggregates, as ONE json document. service_role only; the caller (server code) decides who may see which view of it. Definitions:
--   window            the campaign's presentation window: starts_at until the earlier of ends_at and now. Nothing before it counts.
--   uniqueViewers     distinct Members with an IMPRESSION (the label was at least half visible for at least a second). impressions = those events (one per Member per day).
--   clicks            first-party link clicks by Members or anonymous visitors (a click needs no login); staff clicks are excluded.
--   picks / pickMembers   distinct (Member, Market) Picks, and distinct Members, on any Market of the sponsored Game, made inside the window.
--   comments / commenters  non-deleted Post comments inside the window.
--   callBsChallenges / callBsMembers   Call BS challenges on the sponsored Game's Markets created inside the window; Members on either side.
--   returningMembers  Members who picked in this campaign AND on another LIVE/COMPLETED campaign of the same Sponsor.
--   repeatViewers     Members with an impression on at least two different UTC days (impressions are stored once per Member per day, so this is directly measurable).
--   viewersWhoPicked  Members reached (unique viewers) who also made a Pick on the sponsored Game inside the window — the numerator of the participation rate, whose denominator is uniqueViewers.
--   replies           replies to comments (comments counts top-level comments only); commenters counts Members who wrote either.
--   callBsAccepted    Call BS challenges (inside the window) that the recipient accepted at some point; callBsPickers = Members in a Call BS who also picked inside the window.
--   markets           per Market of the sponsored Game with at least one in-window Pick: how many Members picked it and how they split YES/NO (counts only).
--   game              the Game's team names and sport, so the application can label each Market's sides with the shared label helper.
--   sportAffinity     for the Members reached (unique viewers): how many of them made a Pick on each sport within the look-back.
--   teamAffinity      for the Members reached: how many follow each Team community (an explicit opt-in).
-- No geography is reported: the platform holds no trustworthy location data.
create or replace function public.sponsor_intelligence_aggregates(p_sponsorship_id uuid, p_lookback_days integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s public.sponsorships;
  v_start timestamptz;
  v_end timestamptz;
  v_started boolean;
  v_impressions bigint := 0;
  v_viewers bigint := 0;
  v_clicks bigint := 0;
  v_picks bigint := 0;
  v_pick_members bigint := 0;
  v_comments bigint := 0;
  v_replies bigint := 0;
  v_commenters bigint := 0;
  v_repeat bigint := 0;
  v_viewers_picked bigint := 0;
  v_callbs_accepted bigint := 0;
  v_callbs_pickers bigint := 0;
  v_markets jsonb := '[]'::jsonb;
  v_game jsonb;
  v_callbs bigint := 0;
  v_callbs_members bigint := 0;
  v_returning bigint := 0;
  v_sport jsonb := '[]'::jsonb;
  v_team jsonb := '[]'::jsonb;
begin
  select * into s from public.sponsorships where id = p_sponsorship_id;
  if not found then return null; end if;

  v_start := s.starts_at;
  v_end := least(coalesce(s.ends_at, now()), now());
  v_started := v_start is not null and v_start <= now();

  select count(*), count(distinct e.user_id) into v_impressions, v_viewers
    from public.sponsorship_exposure_events e
    join public.user_profiles up on up.id = e.user_id and up.role = 'player'
    where e.sponsorship_id = s.id and e.event_type = 'IMPRESSION';

  select count(*) into v_repeat
    from (
      select e.user_id
        from public.sponsorship_exposure_events e
        join public.user_profiles up on up.id = e.user_id and up.role = 'player'
        where e.sponsorship_id = s.id and e.event_type = 'IMPRESSION'
        group by e.user_id
        having count(distinct e.day_utc) >= 2
    ) r;

  select jsonb_build_object('homeTeamName', f.home_team_name, 'awayTeamName', f.away_team_name, 'sport', f.sport) into v_game
    from public.fixtures f where f.id = s.fixture_id;

  select count(*) into v_clicks
    from public.sponsorship_exposure_events e
    left join public.user_profiles up on up.id = e.user_id
    where e.sponsorship_id = s.id and e.event_type = 'CLICK' and (e.user_id is null or up.role = 'player');

  if v_started then
    select count(distinct (p.user_id, p.market_id)), count(distinct p.user_id) into v_picks, v_pick_members
      from public.predictions p
      join public.markets mk on mk.id = p.market_id
      join public.user_profiles up on up.id = p.user_id and up.role = 'player'
      where mk.fixture_id = s.fixture_id and p.created_at >= v_start and p.created_at < v_end;

    select count(*) filter (where c.parent_comment_id is null), count(*) filter (where c.parent_comment_id is not null), count(distinct c.user_id)
      into v_comments, v_replies, v_commenters
      from public.post_comments c
      join public.user_profiles up on up.id = c.user_id and up.role = 'player'
      where c.post_id = s.post_id and c.deleted_at is null and c.created_at >= v_start and c.created_at < v_end;

    select count(*), count(*) filter (where ch.accepted_at is not null) into v_callbs, v_callbs_accepted
      from public.challenges ch
      join public.markets mk on mk.id = ch.market_id
      where mk.fixture_id = s.fixture_id and ch.created_at >= v_start and ch.created_at < v_end;

    select count(distinct u.user_id) into v_callbs_members
      from (
        select ch.challenger_user_id as user_id from public.challenges ch join public.markets mk on mk.id = ch.market_id
          where mk.fixture_id = s.fixture_id and ch.created_at >= v_start and ch.created_at < v_end
        union
        select ch.recipient_user_id from public.challenges ch join public.markets mk on mk.id = ch.market_id
          where mk.fixture_id = s.fixture_id and ch.created_at >= v_start and ch.created_at < v_end
      ) u
      join public.user_profiles up on up.id = u.user_id and up.role = 'player';

    select count(*) into v_viewers_picked
      from (
        select distinct e.user_id
          from public.sponsorship_exposure_events e
          join public.user_profiles up on up.id = e.user_id and up.role = 'player'
          where e.sponsorship_id = s.id and e.event_type = 'IMPRESSION'
      ) v
      where exists (
        select 1 from public.predictions p join public.markets mk on mk.id = p.market_id
          where p.user_id = v.user_id and mk.fixture_id = s.fixture_id and p.created_at >= v_start and p.created_at < v_end
      );

    select count(distinct u.user_id) into v_callbs_pickers
      from (
        select ch.challenger_user_id as user_id from public.challenges ch join public.markets mk on mk.id = ch.market_id
          where mk.fixture_id = s.fixture_id and ch.created_at >= v_start and ch.created_at < v_end
        union
        select ch.recipient_user_id from public.challenges ch join public.markets mk on mk.id = ch.market_id
          where mk.fixture_id = s.fixture_id and ch.created_at >= v_start and ch.created_at < v_end
      ) u
      join public.user_profiles up on up.id = u.user_id and up.role = 'player'
      where exists (
        select 1 from public.predictions p join public.markets mk on mk.id = p.market_id
          where p.user_id = u.user_id and mk.fixture_id = s.fixture_id and p.created_at >= v_start and p.created_at < v_end
      );

    select coalesce(jsonb_agg(jsonb_build_object('marketId', m.id, 'template', m.market_template, 'lineValue', m.line_value, 'yesSide', m.yes_side,
                                                 'members', m.members, 'yesCount', m.yes_count, 'noCount', m.no_count) order by m.id), '[]'::jsonb) into v_markets
      from (
        select mk.id, mk.market_template, mk.line_value, mk.yes_side,
               count(distinct p.user_id) as members,
               count(*) filter (where p.selected_outcome = 'YES') as yes_count,
               count(*) filter (where p.selected_outcome = 'NO') as no_count
          from public.markets mk
          join public.predictions p on p.market_id = mk.id
          join public.user_profiles up on up.id = p.user_id and up.role = 'player'
          where mk.fixture_id = s.fixture_id and p.created_at >= v_start and p.created_at < v_end
          group by mk.id
      ) m;

    select count(*) into v_returning
      from (
        select distinct p.user_id
          from public.predictions p
          join public.markets mk on mk.id = p.market_id
          join public.user_profiles up on up.id = p.user_id and up.role = 'player'
          where mk.fixture_id = s.fixture_id and p.created_at >= v_start and p.created_at < v_end
      ) cur
      where exists (
        select 1
          from public.sponsorships s2
          join public.markets mk2 on mk2.fixture_id = s2.fixture_id
          join public.predictions p2 on p2.market_id = mk2.id and p2.user_id = cur.user_id
          where s2.sponsor_id = s.sponsor_id and s2.id <> s.id and s2.lifecycle in ('LIVE', 'COMPLETED') and s2.starts_at is not null
            and p2.created_at >= s2.starts_at and p2.created_at < least(coalesce(s2.ends_at, now()), now())
      );
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('key', t.sport, 'count', t.n) order by t.n desc, t.sport), '[]'::jsonb) into v_sport
    from (
      select f.sport as sport, count(distinct p.user_id) as n
        from (
          select distinct e.user_id from public.sponsorship_exposure_events e
            join public.user_profiles up on up.id = e.user_id and up.role = 'player'
            where e.sponsorship_id = s.id and e.event_type = 'IMPRESSION'
        ) v
        join public.predictions p on p.user_id = v.user_id and p.created_at >= now() - make_interval(days => p_lookback_days)
        join public.markets mk on mk.id = p.market_id
        join public.fixtures f on f.id = mk.fixture_id
        group by f.sport
    ) t;

  select coalesce(jsonb_agg(jsonb_build_object('key', x.team_id::text, 'label', tm.name, 'count', x.n) order by x.n desc, tm.name), '[]'::jsonb) into v_team
    from (
      select c.team_id, count(distinct cf.user_id) as n
        from (
          select distinct e.user_id from public.sponsorship_exposure_events e
            join public.user_profiles up on up.id = e.user_id and up.role = 'player'
            where e.sponsorship_id = s.id and e.event_type = 'IMPRESSION'
        ) v
        join public.community_follows cf on cf.user_id = v.user_id
        join public.communities c on c.id = cf.community_id and c.type = 'TEAM' and c.team_id is not null
        group by c.team_id
    ) x
    join public.teams tm on tm.id = x.team_id;

  return jsonb_build_object(
    'sponsorshipId', s.id,
    'windowStart', v_start,
    'windowEnd', case when v_started then v_end else null end,
    'started', v_started,
    'impressions', v_impressions,
    'uniqueViewers', v_viewers,
    'clicks', v_clicks,
    'picks', v_picks,
    'pickMembers', v_pick_members,
    'comments', v_comments,
    'replies', v_replies,
    'commenters', v_commenters,
    'callBsChallenges', v_callbs,
    'callBsMembers', v_callbs_members,
    'callBsAccepted', v_callbs_accepted,
    'callBsPickers', v_callbs_pickers,
    'returningMembers', v_returning,
    'repeatViewers', v_repeat,
    'viewersWhoPicked', v_viewers_picked,
    'markets', v_markets,
    'game', v_game,
    'sportAffinity', v_sport,
    'teamAffinity', v_team,
    'affinityLookbackDays', p_lookback_days
  );
end;
$$;
revoke all on function public.sponsor_intelligence_aggregates(uuid, integer) from public, anon, authenticated;
grant execute on function public.sponsor_intelligence_aggregates(uuid, integer) to service_role;
