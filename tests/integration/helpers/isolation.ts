/**
 * Integration-test isolation — every test FILE starts in a pristine world and leaves one behind.
 *
 * Why this exists. The integration suite shares one real database, and several domain tables can't be cleaned through the API a test
 * normally uses: `challenges` rows are "never deleted" (service-role DELETE is refused), and Markets / Picks / Positions / Fixtures hang off
 * them by real foreign keys, so a test's own `afterEach` cleanup silently failed and left rows behind. Measured after a green full run: 21
 * challenges (10 ACCEPTED, 1 PENDING), 52 monetary Positions (25 still COMMITTED), 59 Markets, 214 Picks, 67 Fixtures. The grading, Call BS
 * resolution and settlement jobs are GLOBAL (they process every pending row), and reconciliation checks read the whole database, so a
 * later file's assertions ("no job failures", "reconciliation is clean") were at the mercy of whichever files ran before it — which is why
 * results changed with file order (Vitest runs previously-failed files first) and why CI's fixed order differed from a local run.
 *
 * What it does. Before and after every test file it (1) deletes every row of the transient domain tables in one transaction using the
 * local superuser connection with `session_replication_role = replica` (so FK order and append-only triggers don't matter — this is a
 * disposable local database, guarded by the same loopback allowlist as every other raw connection), and (2) resets `platform_settings` to
 * the schema defaults — verified identical to the pristine post-`db reset` row — so no file depends on another having left a policy,
 * fee, limit, capability flag or notification setting as it expected. Reference data (communities, teams, leagues, categories, payment
 * methods, user accounts) is untouched. A file that needs a non-default value sets it itself, which is the point.
 */
import { afterAll, beforeAll } from "vitest";
import { Client } from "pg";
import { getTestDatabaseUrl } from "./test-env";

// Transient domain state created by tests. (Order is irrelevant under session_replication_role = replica.)
const TRANSIENT_TABLES = [
  "notifications",
  "monetary_position_settlements",
  "monetary_positions",
  "monetary_proposals",
  "wallet_reservations",
  "wallet_requests",
  "challenges",
  "prediction_revisions",
  "predictions",
  "post_comments",
  "post_communities",
  "posts",
  "nfl_game_results",
  "markets",
  "fixtures",
  "background_jobs",
  "rate_limits",
  "cron_job_locks",
] as const;

export async function resetIntegrationWorld(): Promise<void> {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    for (const table of TRANSIENT_TABLES) {
      // A table that doesn't exist in this schema would be a typo here, not something to skip silently.
      await client.query(`delete from public.${table}`);
    }
    await client.query(`
      do $$
      declare cols text;
      begin
        select string_agg(format('%I = default', column_name), ', ')
          into cols
          from information_schema.columns
          where table_schema = 'public' and table_name = 'platform_settings' and column_default is not null and column_name <> 'id';
        execute 'update public.platform_settings set ' || cols || ' where id = true';
      end $$;
    `);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  await resetIntegrationWorld();
});

afterAll(async () => {
  await resetIntegrationWorld();
});
