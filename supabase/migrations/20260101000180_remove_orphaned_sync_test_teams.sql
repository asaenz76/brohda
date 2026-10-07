-- Removes two test teams that leaked into production from an early sync test ("Home Sync Test NFL" external id 9101, "Away Sync Test NFL"
-- external id 9102, provider api_nfl, created 2026-08-14). A read-only dependency audit on production found them FULLY ORPHANED: no Community, no
-- follow, no Game (by external id or by name, under any provider), Post, Market, Pick, Challenge, Proposal, Position, confirmed result,
-- notification or audit row, and no team_players row. (The only foreign key that references `teams` is communities.team_id.)
--
-- Safe by construction, not by assertion: the DELETE matches only these two exact (provider, external_id, name) identities AND only when nothing
-- references them. If anything ever did (a Community, a Game by external id or name), the row simply stays and nothing happens — this never fails a
-- deploy and never removes a team that is in use. Forward-only; touches no other row.
-- A team Community can appear for these two teams between the audit and this migration (the Community job now creates one for every synced team of an
-- active sport). Such a Community is removed first, but ONLY if it is itself unused (no follower, no distributed Post).
delete from public.communities c
using public.teams t
where c.team_id = t.id
  and t.provider = 'api_nfl'
  and (t.external_id, t.name) in (('9101', 'Home Sync Test NFL'), ('9102', 'Away Sync Test NFL'))
  and not exists (select 1 from public.community_follows f where f.community_id = c.id)
  and not exists (select 1 from public.post_communities pc where pc.community_id = c.id);

delete from public.teams t
where t.provider = 'api_nfl'
  and (t.external_id, t.name) in (('9101', 'Home Sync Test NFL'), ('9102', 'Away Sync Test NFL'))
  and not exists (select 1 from public.communities c where c.team_id = t.id)
  and not exists (
    select 1 from public.fixtures f
    where f.home_team_external_id = t.external_id or f.away_team_external_id = t.external_id
       or f.home_team_name = t.name or f.away_team_name = t.name
  )
  and not exists (select 1 from public.nfl_game_results r where r.home_team_external_id = t.external_id or r.away_team_external_id = t.external_id)
  and not exists (select 1 from public.team_players p where p.team_external_id = t.external_id);
