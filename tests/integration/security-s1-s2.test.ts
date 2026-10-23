/**
 * Security hardening S1 + S2 (migration 212): client roles hold no base-table WRITE privileges beyond the two documented exceptions, future tables do not inherit them, and the only
 * thing a visitor or Member session can read of platform_settings is the one-column public view. Effective privileges are checked with has_table_privilege against a real local Postgres, and
 * behaviour with real anonymous / signed-in / service-role sessions. Real local Supabase only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl } from "./helpers/test-env";
import { seedUser } from "./helpers/game-seed";

const admin = getTestAdminClient();
const PASSWORD = "integration-test-password-123";
const WRITE = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;
const PROFILE_COLUMNS = ["avatar_url", "bio", "display_name", "gender", "pronouns", "show_bio", "show_gender", "show_pronouns", "username"];

let pg: Client;
beforeAll(async () => {
  pg = new Client({ connectionString: getTestDatabaseUrl() });
  await pg.connect();
});
afterAll(async () => {
  await pg.end();
});

async function sessionFor(userId: string) {
  const { data } = await admin.auth.admin.getUserById(userId);
  const c = getTestAnonClient();
  expect((await c.auth.signInWithPassword({ email: data.user!.email!, password: PASSWORD })).error).toBeNull();
  return c;
}
const denied = (e: { code?: string; message?: string } | null) => e !== null && (e.code === "42501" || /permission denied/i.test(e.message ?? ""));

describe("S1 — effective table privileges", () => {
  it("anon and authenticated hold NO write privilege on any relation in public, except the two documented exceptions", async () => {
    const rels = (await pg.query("select c.relname, c.oid::regclass::text rel from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p','v','m','f') order by 1")).rows as { relname: string; rel: string }[];
    expect(rels.length).toBeGreaterThan(60);
    const offenders: string[] = [];
    for (const { relname, rel } of rels) {
      for (const role of ["anon", "authenticated"]) {
        for (const priv of WRITE) {
          const has = (await pg.query("select has_table_privilege($1, $2, $3) h", [role, rel, priv])).rows[0].h as boolean;
          const allowed = role === "authenticated" && relname === "invitations" && (priv === "INSERT" || priv === "UPDATE");
          if (has && !allowed) offenders.push(`${role} ${priv} ${relname}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the documented exceptions still exist, and are no wider than needed", async () => {
    const q = async (sql: string, params: unknown[]) => (await pg.query(sql, params)).rows[0].h as boolean;
    // invitations: authenticated may insert/update (admin policy applies), never delete; anon nothing
    expect(await q("select has_table_privilege('authenticated','public.invitations','INSERT') h", [])).toBe(true);
    expect(await q("select has_table_privilege('authenticated','public.invitations','UPDATE') h", [])).toBe(true);
    expect(await q("select has_table_privilege('authenticated','public.invitations','DELETE') h", [])).toBe(false);
    expect(await q("select has_table_privilege('anon','public.invitations','INSERT') h", [])).toBe(false);
    // user_profiles: column-level UPDATE on exactly the nine profile columns, nothing at table level
    expect(await q("select has_table_privilege('authenticated','public.user_profiles','UPDATE') h", [])).toBe(false);
    const cols = (await pg.query("select column_name from information_schema.column_privileges where table_schema='public' and table_name='user_profiles' and grantee='authenticated' and privilege_type='UPDATE' order by 1")).rows.map((r) => r.column_name);
    expect(cols).toEqual([...PROFILE_COLUMNS].sort());
    for (const sensitive of ["role", "is_active", "invited_by", "account_closed_at", "prediction_correct_count"]) {
      expect((await pg.query("select has_column_privilege('authenticated','public.user_profiles',$1,'UPDATE') h", [sensitive])).rows[0].h).toBe(false);
    }
  });

  it("a table created later does not inherit write privileges (the default itself is corrected)", async () => {
    const name = `s1_probe_${randomUUID().slice(0, 8)}`;
    try {
      await pg.query("begin");
      await pg.query(`create table public.${name} (id int)`);
      for (const role of ["anon", "authenticated"]) {
        for (const priv of WRITE) expect((await pg.query("select has_table_privilege($1, $2, $3) h", [role, `public.${name}`, priv])).rows[0].h, `${role} ${priv}`).toBe(false);
      }
    } finally {
      await pg.query("rollback");
    }
  });

  it("no default-privilege entry of the table-owning role grants a client role any write privilege (catalog check; hosted projects ship such an entry, a fresh local database does not)", async () => {
    const entries = (await pg.query(
      `select d.defaclnamespace::regnamespace::text ns, (aclexplode(d.defaclacl)).grantee::regrole::text grantee, (aclexplode(d.defaclacl)).privilege_type priv
         from pg_default_acl d where d.defaclobjtype = 'r' and d.defaclrole = 'postgres'::regrole and d.defaclnamespace in ('public'::regnamespace, 0)`,
    )).rows as { ns: string; grantee: string; priv: string }[];
    const bad = entries.filter((e) => ["anon", "authenticated"].includes(e.grantee) && ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].includes(e.priv));
    expect(bad).toEqual([]);
  });
});

describe("S1 — behaviour", () => {
  const tables = ["predictions", "challenges", "markets", "posts", "post_comments", "audit_logs", "confidence_prediction_stakes", "notifications", "fixtures"];

  it("an anonymous client cannot write sensitive tables or the settings", async () => {
    const anon = getTestAnonClient();
    for (const t of tables) {
      expect(denied((await anon.from(t).insert({ id: randomUUID() })).error), `anon insert ${t}`).toBe(true);
      expect(denied((await anon.from(t).update({ id: randomUUID() }).eq("id", randomUUID())).error), `anon update ${t}`).toBe(true);
      expect(denied((await anon.from(t).delete().eq("id", randomUUID())).error), `anon delete ${t}`).toBe(true);
    }
    expect(denied((await anon.from("platform_settings").update({ registration_enabled: true }).eq("id", true)).error)).toBe(true);
  });

  it("a signed-in Member cannot bypass the business rules by writing tables directly", async () => {
    const id = await seedUser("s1-member");
    const member = await sessionFor(id);
    for (const t of tables) {
      expect(denied((await member.from(t).insert({ id: randomUUID() })).error), `member insert ${t}`).toBe(true);
      expect(denied((await member.from(t).update({ id: randomUUID() }).eq("id", randomUUID())).error), `member update ${t}`).toBe(true);
      expect(denied((await member.from(t).delete().eq("id", randomUUID())).error), `member delete ${t}`).toBe(true);
    }
    expect(denied((await member.from("platform_settings").update({ registration_enabled: true }).eq("id", true)).error)).toBe(true);
    // a Member cannot make themselves an admin or touch counters on their own profile
    expect(denied((await member.from("user_profiles").update({ role: "super_admin" }).eq("id", id)).error)).toBe(true);
    expect(denied((await member.from("user_profiles").update({ prediction_correct_count: 99 }).eq("id", id)).error)).toBe(true);
    expect(denied((await member.from("user_profiles").insert({ id: randomUUID(), display_name: "x" })).error)).toBe(true);
    expect(denied((await member.from("user_profiles").delete().eq("id", id)).error)).toBe(true);
  });

  it("the legitimate Member write still works: updating their OWN profile fields — and only their own", async () => {
    const a = await seedUser("s1-own");
    const b = await seedUser("s1-other");
    const session = await sessionFor(a);
    const ok = await session.from("user_profiles").update({ bio: "hello from S1", pronouns: "they/them" }).eq("id", a).select("id, bio");
    expect(ok.error).toBeNull();
    expect(ok.data?.[0]?.bio).toBe("hello from S1");
    const other = await session.from("user_profiles").update({ bio: "hijacked" }).eq("id", b).select("id");
    expect(other.error).toBeNull(); // RLS filters the row: nothing is updated, nothing is leaked
    expect(other.data ?? []).toEqual([]);
    expect(((await admin.from("user_profiles").select("bio").eq("id", b).single()).data as { bio: string | null }).bio).not.toBe("hijacked");
  });

  it("the invitation flow still works for an admin through a client session, and is refused for everyone else", async () => {
    const adminId = await seedUser("s1-admin");
    await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", adminId);
    const adminSession = await sessionFor(adminId);
    const email = `s1-invite-${randomUUID().slice(0, 8)}@test.local`;
    const created = await adminSession.from("invitations").insert({ email, invited_by: adminId }).select("id").single();
    expect(created.error).toBeNull();
    const revoked = await adminSession.from("invitations").update({ status: "revoked" }).eq("id", created.data!.id).select("status").single();
    expect(revoked.error).toBeNull();
    expect(revoked.data?.status).toBe("revoked");
    expect(denied((await adminSession.from("invitations").delete().eq("id", created.data!.id)).error)).toBe(true); // DELETE was never used and is no longer granted

    const memberId = await seedUser("s1-notadmin");
    const member = await sessionFor(memberId);
    const refused = await member.from("invitations").insert({ email: `s1-x-${randomUUID().slice(0, 8)}@test.local`, invited_by: memberId });
    expect(refused.error).not.toBeNull(); // RLS refuses a non-admin
    expect(denied((await getTestAnonClient().from("invitations").insert({ email: "x@test.local", invited_by: memberId })).error)).toBe(true);
    await admin.from("invitations").delete().eq("id", created.data!.id);
    await admin.from("user_profiles").update({ role: "player" }).eq("id", adminId);
  });

  it("the service role still performs the authorized domain operations", async () => {
    const before = ((await admin.from("platform_settings").select("registration_enabled").eq("id", true).single()).data as { registration_enabled: boolean }).registration_enabled;
    expect((await admin.from("platform_settings").update({ registration_enabled: !before }).eq("id", true)).error).toBeNull();
    expect(((await admin.from("platform_settings").select("registration_enabled").eq("id", true).single()).data as { registration_enabled: boolean }).registration_enabled).toBe(!before);
    expect((await admin.from("platform_settings").update({ registration_enabled: before }).eq("id", true)).error).toBeNull();
  });
});

describe("S2 stage 1 — the narrow public settings surface", () => {
  it("public_platform_settings exposes exactly one column, registration_enabled", async () => {
    const cols = (await pg.query("select column_name from information_schema.columns where table_schema='public' and table_name='public_platform_settings' order by ordinal_position")).rows.map((r) => r.column_name);
    expect(cols).toEqual(["registration_enabled"]);
  });

  it("a visitor and a signed-in Member can read it, and it reflects the real setting", async () => {
    const actual = ((await admin.from("platform_settings").select("registration_enabled").eq("id", true).single()).data as { registration_enabled: boolean }).registration_enabled;
    const anon = await getTestAnonClient().from("public_platform_settings").select("registration_enabled").single();
    expect(anon.error).toBeNull();
    expect(anon.data?.registration_enabled).toBe(actual);
    const member = await sessionFor(await seedUser("s2-member"));
    expect((await member.from("public_platform_settings").select("registration_enabled").single()).data?.registration_enabled).toBe(actual);
  });

  it("nobody but the server can write it (it is a read-only view)", async () => {
    const anon = getTestAnonClient();
    expect(denied((await anon.from("public_platform_settings").update({ registration_enabled: true }).eq("registration_enabled", false)).error)).toBe(true);
    expect(denied((await anon.from("public_platform_settings").insert({ registration_enabled: true })).error)).toBe(true);
  });
});
