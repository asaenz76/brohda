-- Stage 1 of the soccer decommission: disable at the data layer before any
-- runtime code is deleted. Association football / soccer (provider
-- 'api_football') no longer creates new pools — this stops every already-
-- imported soccer competition from continuing to surface in pool creation,
-- without deleting the historical import rows themselves (league_season_
-- imports has no financial data of its own; this is a reversible flag flip,
-- not a delete).
update public.league_season_imports
set pool_creation_enabled = false, is_active = false
where provider = 'api_football';
