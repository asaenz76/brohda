-- Defense in depth for the money tables. Audit (production, effective
-- privileges): `anon` and `authenticated` both held SELECT/INSERT/UPDATE/DELETE
-- on all seven wallet/monetary tables. Row-level security made the write grants
-- inert (every table has SELECT-only policies, and `anon` has none at all), but
-- a grant is a second lock that should not depend on the first one being
-- configured correctly forever — one mistaken policy would otherwise expose
-- money tables to direct client writes.
--
-- Nothing in the application writes these tables through a user-scoped client:
-- every write is a SECURITY DEFINER RPC or a service-role call, and the
-- user-scoped client only SELECTs (wallet page, app shell balance, ledger).
-- So this revokes what is not needed and changes no behavior:
--   * INSERT/UPDATE/DELETE from anon and authenticated, and
--   * SELECT from anon (no anonymous surface reads any of them).
-- `authenticated` keeps SELECT (still filtered by the existing RLS policies);
-- `service_role` and the table owner (the SECURITY DEFINER functions) are
-- untouched. Forward-only, revoke-only: nothing here broadens any privilege.

revoke insert, update, delete on
  public.wallet_balances,
  public.wallet_transactions,
  public.wallet_reservations,
  public.wallet_requests,
  public.monetary_proposals,
  public.monetary_positions,
  public.monetary_position_settlements
from anon, authenticated;

revoke select on
  public.wallet_balances,
  public.wallet_transactions,
  public.wallet_reservations,
  public.wallet_requests,
  public.monetary_proposals,
  public.monetary_positions,
  public.monetary_position_settlements
from anon;
