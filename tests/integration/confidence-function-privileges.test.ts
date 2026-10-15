/**
 * Migration 202: the Confidence trigger functions and the stake-ladder helper are not executable by PUBLIC, anon or authenticated (and the trigger functions by nobody who calls them directly) — while every
 * trigger, constraint and function that depends on them keeps working. Also a drift guard: any FUTURE confidence_* function must be closed to application roles unless it is on the explicit allowlist.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl } from "./helpers/test-env";
import { seedUser } from "./helpers/game-seed";

const admin = getTestAdminClient();
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TRIGGER_FUNCTIONS = ["confidence_accounts_guard", "confidence_apply_ledger_entry", "confidence_bootstrap_new_profile", "confidence_ledger_immutable", "confidence_stamp_ledger_entry"];
/** The only Confidence function application roles may execute: the one-boolean helper the read policies evaluate as the querying Member. */
const APP_EXECUTABLE_ALLOWLIST = ["confidence_enabled_flag"];

let saved: Row | null = null;
beforeEach(async () => {
  saved = (await admin.from("platform_settings").select("confidence_enabled").eq("id", true).single()).data as Row;
  await admin.from("platform_settings").update({ confidence_enabled: true }).eq("id", true);
});
afterEach(async () => {
  if (saved) await admin.from("platform_settings").update(saved).eq("id", true);
});

async function sql<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

describe("function privileges", () => {
  it("the five trigger functions and the helper exist, and none is executable by PUBLIC, anon or authenticated", async () => {
    const rows = await sql<Row>(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') anon_x,
              has_function_privilege('authenticated', p.oid, 'execute') authed_x,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') public_x,
              has_function_privilege('service_role', p.oid, 'execute') service_x
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1)`,
      [[...TRIGGER_FUNCTIONS, "confidence_stakes_valid"]],
    );
    expect(rows.map((r) => r.proname).sort()).toEqual([...TRIGGER_FUNCTIONS, "confidence_stakes_valid"].sort());
    for (const r of rows) {
      expect(r.anon_x, `${r.proname} anon`).toBe(false);
      expect(r.authed_x, `${r.proname} authenticated`).toBe(false);
      expect(r.public_x, `${r.proname} PUBLIC`).toBe(false);
      // Trigger functions are never called directly, so even the service role needs no grant; the helper is used by a CHECK constraint evaluated as the service role.
      expect(r.service_x, `${r.proname} service_role`).toBe(r.proname === "confidence_stakes_valid");
    }
  });

  it("the expected trigger bindings still exist", async () => {
    const rows = await sql<Row>(
      `select tgname, tgrelid::regclass::text tbl from pg_trigger where not tgisinternal and tgname = any($1)`,
      [["confidence_accounts_guard_insert", "confidence_accounts_guard_update", "confidence_stamp_entry", "confidence_apply_entry", "confidence_ledger_no_update", "confidence_ledger_no_delete", "user_profiles_confidence_bootstrap"]],
    );
    expect(rows).toHaveLength(7);
  });

  it("Members and the public cannot call the helper or any trigger function directly", async () => {
    const id = await seedUser("priv-member");
    const { data } = await admin.auth.admin.getUserById(id);
    const member = getTestAnonClient();
    expect((await member.auth.signInWithPassword({ email: data.user!.email!, password: "integration-test-password-123" })).error).toBeNull();
    for (const client of [member, getTestAnonClient()]) {
      expect((await client.rpc("confidence_stakes_valid", { p_stakes: [1, 2, 3] })).error).not.toBeNull();
      for (const fn of TRIGGER_FUNCTIONS) expect((await client.rpc(fn, {})).error, fn).not.toBeNull();
    }
  });

  it("drift guard: every confidence_* / admin_confidence_* function is closed to PUBLIC, anon and authenticated except the one-boolean policy helper", async () => {
    const rows = await sql<Row>(
      `select p.proname,
              has_function_privilege('anon', p.oid, 'execute') anon_x,
              has_function_privilege('authenticated', p.oid, 'execute') authed_x,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') public_x
         from pg_proc p where p.pronamespace = 'public'::regnamespace and (p.proname like 'confidence\\_%' or p.proname like 'admin\\_confidence\\_%')`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(15);
    for (const r of rows) {
      if (APP_EXECUTABLE_ALLOWLIST.includes(r.proname)) {
        expect(r.anon_x, `${r.proname} anon`).toBe(false);
        expect(r.public_x, `${r.proname} PUBLIC`).toBe(false);
        continue;
      }
      expect(r.anon_x, `${r.proname} anon`).toBe(false);
      expect(r.authed_x, `${r.proname} authenticated`).toBe(false);
      expect(r.public_x, `${r.proname} PUBLIC`).toBe(false);
    }
  });
});

describe("behaviour is unchanged", () => {
  it("a new profile still gets its account and grant through the trigger, with the trigger functions closed", async () => {
    const id = await seedUser("priv-new");
    const account = (await admin.from("confidence_accounts").select("available").eq("member_id", id).maybeSingle()).data;
    expect(Number(account?.available)).toBe(50);
    expect((await admin.from("confidence_ledger_entries").select("id").eq("member_id", id).eq("entry_type", "INITIAL_GRANT")).data).toHaveLength(1);
  });

  it("the ledger stamp/apply triggers, the balance guard and the immutability guards still do their jobs", async () => {
    const id = await seedUser("priv-ledger");
    const sa = await seedUser("priv-admin");
    await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", sa);
    try {
      const adj = await admin.rpc("admin_confidence_adjust", { p_admin_id: sa, p_member_id: id, p_amount: -7, p_reason_code: "CORRECTION", p_note: "hardening check", p_idempotency_key: randomUUID() });
      expect(adj.error).toBeNull();
      expect(Number((await admin.from("confidence_accounts").select("available").eq("member_id", id).single()).data!.available)).toBe(43);
      const [entry] = ((await admin.from("confidence_ledger_entries").select("id, available_after").eq("member_id", id).eq("entry_type", "ADMIN_ADJUSTMENT")).data ?? []) as Row[];
      expect(Number(entry.available_after)).toBe(43); // stamped by the BEFORE trigger
      expect((await admin.from("confidence_ledger_entries").update({ note: "rewritten" }).eq("id", entry.id)).error?.message ?? "").toContain("append-only");
      expect((await admin.from("confidence_ledger_entries").delete().eq("id", entry.id)).error?.message ?? "").toContain("append-only");
      expect((await admin.from("confidence_accounts").update({ available: 999 }).eq("member_id", id)).error?.message ?? "").toContain("through the ledger");
      expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);
    } finally {
      await admin.from("user_profiles").update({ role: "player" }).eq("id", sa);
    }
  });

  it("the stake-ladder CHECK still validates writes made as the service role and through the audited function", async () => {
    expect((await admin.from("platform_settings").update({ confidence_allowed_stakes: [5, 1] }).eq("id", true)).error).not.toBeNull();
    expect((await admin.from("platform_settings").update({ confidence_allowed_stakes: [] }).eq("id", true)).error).not.toBeNull();
    const ok = await admin.from("platform_settings").update({ confidence_allowed_stakes: [1, 2, 3, 4, 5] }).eq("id", true);
    expect(ok.error).toBeNull();
  });
});
