-- wallet_requests (20260101000013_wallet_requests.sql) granted service_role
-- only select/insert/update, no delete — same bug class already fixed for
-- provider_request_log (20260101000099) and fixture_odds_cache
-- (20260101000100). Flagged during the payment-reference validation pass
-- (Phase 5) and deferred here per the founder's own instruction, rather than
-- fixed ad hoc. tests/integration/wallet-requests.test.ts's cleanup code
-- worked around this by nulling FKs instead of deleting rows, under the
-- (incorrect) assumption the missing grant was intentional "by design."
grant delete on public.wallet_requests to service_role;
