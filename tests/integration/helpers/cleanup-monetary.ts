import { Client } from "pg";
import { getTestDatabaseUrl } from "./test-env";

/**
 * Deletes every monetary proposal, Position and settlement (and their
 * notifications) for the given Markets, in one transaction.
 *
 * Why this exists: monetary_proposals.position_id and
 * monetary_positions.proposal_id reference each other, so no ordering of two
 * plain DELETEs can ever succeed for an ACCEPTED proposal — the first one
 * always violates a foreign key. Supabase returns that as `{ error }` rather
 * than throwing, so a test cleanup written as two deletes fails silently and
 * leaves the rows (and any ACTIVE reservations they own) behind, which then
 * shows up as reconciliation anomalies and stale funded users in later runs.
 * Local-only: getTestDatabaseUrl() is allowlist-guarded to the local stack, and
 * session_replication_role = replica (superuser) is scoped to this transaction
 * so the mutually-referencing rows can be removed together.
 */
export async function deleteMonetaryRowsForMarkets(marketIds: string[]): Promise<void> {
  if (marketIds.length === 0) return;
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await client.query("delete from notifications where monetary_proposal_id in (select id from monetary_proposals where market_id = any($1))", [marketIds]);
    await client.query("delete from monetary_position_settlements where market_id = any($1)", [marketIds]);
    await client.query("delete from monetary_positions where market_id = any($1)", [marketIds]);
    await client.query("delete from monetary_proposals where market_id = any($1)", [marketIds]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
