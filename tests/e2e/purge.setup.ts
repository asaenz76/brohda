/**
 * Between the big parallel project and the serial projects chained after it: clear the Game, prediction and related rows the earlier specs left behind.
 *
 * Why: a Member's prediction now carries a Confidence stake and its immutable ledger entry, and neither can be deleted through the API (by design — a stake is never deleted). So a spec's own cleanup can no longer remove its
 * Game once someone predicted on it, and leftover Games pile up. The home feed lists the first 50 Games by kickoff, so after enough of them a later spec's Game falls off the first page and its card is simply not there.
 * Production never deletes Games this way; this is test housekeeping on the disposable local database, guarded by the same loopback allowlist as every other raw connection. Users, wallets, Sponsors and settings are untouched.
 */
import { test } from "@playwright/test";
import { Client } from "pg";
import { getTestDatabaseUrl } from "./helpers/test-env";

// Children before parents is not required under session_replication_role = replica, but is kept for readability.
const TABLES = [
  "sponsorship_exposure_events",
  "sponsorship_approvals",
  "sponsorship_payment_events",
  "sponsorships",
  "sponsorship_inventory",
  "confidence_ledger_entries",
  "confidence_prediction_stakes",
  "confidence_accounts",
  "monetary_position_settlements",
  "monetary_positions",
  "monetary_proposals",
  "wallet_reservations",
  "challenges",
  "prediction_revisions",
  "predictions",
  "post_comments",
  "post_communities",
  "posts",
  "nfl_game_results",
  "markets",
  "fixtures",
] as const;

test("clear the Games and predictions earlier specs left behind", async () => {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    for (const table of TABLES) await client.query(`delete from public.${table}`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
});
