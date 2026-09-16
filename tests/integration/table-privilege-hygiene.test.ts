/**
 * Security Remediation Gate 1A regression protection
 * (supabase/migrations/20260101000136_revoke_client_ddl_table_privileges.sql).
 *
 * Verifies ACTUAL EFFECTIVE privilege via `has_table_privilege`/
 * `has_schema_privilege` against a real local Postgres connection — not
 * migration text, not `information_schema` alone (which can show grants
 * that don't reflect resolved role-membership effects). This is the same
 * verification method used to discover and confirm the original finding:
 * `anon`/`authenticated` held TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on
 * every table in `public`, inherited from a schema-level default privilege
 * entry owned by role `postgres` (every Brohda table's owner) that no
 * migration ever set explicitly.
 *
 * Uses local Supabase only (getTestDatabaseUrl(), same allowlist-guarded
 * helper the FREE-mode row-lock test already uses for a direct Postgres
 * connection).
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTestDatabaseUrl } from "./helpers/test-env";

const DANGEROUS_PRIVILEGES = ["TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"] as const;
const CLIENT_ROLES = ["anon", "authenticated"] as const;

// Representative sensitive tables spanning: the Milestone 1 table, the
// Milestone 2 discovery-taxonomy tables, the append-only audit/ledger
// tables, and a core identity table — not exhaustive, but enough to catch a
// regression of the default-ACL mechanism without hard-coding all tables
// (which would make this test a maintenance burden rather than a real
// guardrail).
const REPRESENTATIVE_TABLES = [
  "markets",
  "discovery_categories",
  "discovery_category_provider_mappings",
  "discovery_sort_policy",
  "capability_policies",
  "audit_logs",
  "wallet_balances",
  "wallet_transactions",
  "user_profiles",
];

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe("client-facing roles never hold DDL-adjacent table privileges", () => {
  for (const table of REPRESENTATIVE_TABLES) {
    for (const role of CLIENT_ROLES) {
      for (const privilege of DANGEROUS_PRIVILEGES) {
        it(`${role} does not have ${privilege} on public.${table}`, async () => {
          const { rows } = await client.query<{ has: boolean }>(
            `select has_table_privilege($1, $2, $3) as has`,
            [role, `public.${table}`, privilege],
          );
          expect(rows[0].has).toBe(false);
        });
      }
    }
  }
});

describe("service_role's trusted-backend privileges are unaffected", () => {
  it("service_role retains its intended CRUD on markets (this remediation must not narrow the trusted role)", async () => {
    const { rows } = await client.query<{ has: boolean }>(
      `select has_table_privilege('service_role', 'public.markets', 'SELECT') as has`,
    );
    expect(rows[0].has).toBe(true);
  });
});

describe("REFERENCES is inert regardless — neither client role can create a table to exploit it", () => {
  for (const role of CLIENT_ROLES) {
    it(`${role} cannot CREATE in schema public`, async () => {
      const { rows } = await client.query<{ has: boolean }>(
        `select has_schema_privilege($1, 'public', 'CREATE') as has`,
        [role],
      );
      expect(rows[0].has).toBe(false);
    });
  }
});

describe("no SECURITY INVOKER function is exposed to client roles (the only path that could make the above privileges reachable)", () => {
  it("every function granted EXECUTE to anon/authenticated is SECURITY DEFINER", async () => {
    const { rows } = await client.query<{ proname: string }>(`
      select distinct p.proname
      from information_schema.routine_privileges r
      join pg_proc p on p.proname = r.routine_name and p.pronamespace = 'public'::regnamespace
      where r.routine_schema = 'public'
        and r.grantee in ('anon', 'authenticated')
        and r.privilege_type = 'EXECUTE'
        and p.prosecdef = false
    `);
    expect(rows).toEqual([]);
  });
});

describe("newly-created tables no longer inherit the revoked defaults", () => {
  it("a table created after this remediation grants no dangerous privilege to anon/authenticated by default", async () => {
    await client.query("begin");
    try {
      await client.query("create table public._privilege_regression_probe (id int)");
      for (const role of CLIENT_ROLES) {
        for (const privilege of DANGEROUS_PRIVILEGES) {
          const { rows } = await client.query<{ has: boolean }>(
            `select has_table_privilege($1, 'public._privilege_regression_probe', $2) as has`,
            [role, privilege],
          );
          expect(rows[0].has).toBe(false);
        }
      }
    } finally {
      await client.query("rollback");
    }
  });
});
