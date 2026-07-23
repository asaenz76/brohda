-- Snapshots a pool's analytics category at creation time, immune to later
-- template-registry changes (rename/recategorize/delete a template must
-- never rewrite the history of pools already created against it).
-- Values mirror lib/pools/templates/category-labels.ts's
-- AnalyticsCategoryCode exactly — keep both in sync if this ever changes.
create type public.analytics_category as enum (
  'MATCH_RESULT',
  'GOALS',
  'TEAM_PROPS',
  'PLAYER_PROPS',
  'MATCH_STATS',
  'DISCIPLINE',
  'COMBO',
  'CUSTOM',
  'UNKNOWN'
);

alter table public.pools
  add column analytics_category public.analytics_category not null default 'UNKNOWN';

-- One-time backfill for every pool created before this column existed —
-- mirrors resolvePoolAnalyticsCategory's exact resolution rules (registry
-- lookup for TEMPLATE_GRADED, legacy pool_type map otherwise). A
-- template_id that no longer resolves against the current registry (a
-- template later removed) is intentionally left UNKNOWN rather than
-- guessed at, and is never dropped from financial totals — analytics
-- queries group by this column, they don't filter it out.
update public.pools set analytics_category = case
  when pool_type in ('WHO_WILL_ADVANCE', 'REGULATION_RESULT') then 'MATCH_RESULT'::public.analytics_category
  when pool_type = 'COMBO' then 'COMBO'::public.analytics_category
  when pool_type = 'CUSTOM' then 'CUSTOM'::public.analytics_category
  when pool_type = 'TEMPLATE_GRADED' and template_id in (
    'HOME_TEAM_TO_WIN', 'AWAY_TEAM_TO_WIN', 'EITHER_TEAM_TO_WIN', 'TEAM_TO_AVOID_DEFEAT'
  ) then 'MATCH_RESULT'::public.analytics_category
  when pool_type = 'TEMPLATE_GRADED' and template_id in (
    'MATCH_TOTAL_GOALS', 'BOTH_TEAMS_TO_SCORE', 'TEAM_TOTAL_GOALS', 'WINNING_MARGIN',
    'CLEAN_SHEET', 'WIN_TO_NIL', 'FIRST_HALF_TOTAL_GOALS',
    'FIRST_TEAM_TO_SCORE', 'PENALTY_AWARDED', 'OWN_GOAL', 'GOAL_AFTER_MINUTE'
  ) then 'GOALS'::public.analytics_category
  when pool_type = 'TEMPLATE_GRADED' and template_id = 'RED_CARD'
    then 'DISCIPLINE'::public.analytics_category
  when pool_type = 'TEMPLATE_GRADED' and template_id = 'PLAYER_TO_SCORE'
    then 'PLAYER_PROPS'::public.analytics_category
  else 'UNKNOWN'::public.analytics_category
end
where analytics_category = 'UNKNOWN';
