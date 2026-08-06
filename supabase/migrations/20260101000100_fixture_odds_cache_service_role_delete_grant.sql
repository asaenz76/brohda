-- fixture_odds_cache (20260101000091_odds_recommendation_evidence.sql) was
-- granted select/insert/update to service_role but not delete, same class
-- of gap as provider_request_log (20260101000099) — any server-side admin
-- client call that deletes a stale/superseded cache row fails silently
-- with "permission denied for table fixture_odds_cache".
grant delete on public.fixture_odds_cache to service_role;
