/**
 * M9 — account integrity: the atomic rate limiter, expired-row pruning, replacing an unused unconfirmed login that is squatting an address, and the reserved-username list.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl } from "./helpers/test-env";

const admin = getTestAdminClient();
const anon = getTestAnonClient();

const identifiers: string[] = [];
const userIds: string[] = [];

function limit(identifier: string, windowSeconds: number, maxAttempts: number) {
  identifiers.push(identifier);
  return admin.rpc("check_and_increment_rate_limit", { p_identifier: identifier, p_window_seconds: windowSeconds, p_max_attempts: maxAttempts });
}

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: getTestDatabaseUrl() });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

async function makeLogin(opts: { confirmed: boolean; email?: string }) {
  const email = opts.email ?? `m9-${randomUUID()}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: "correct-horse-9", email_confirm: opts.confirmed });
  if (error || !data.user) throw error ?? new Error("could not create login");
  userIds.push(data.user.id);
  return { id: data.user.id, email };
}

const ageLogin = (id: string, minutes: number) => withDb((db) => db.query("update auth.users set created_at = now() - make_interval(mins => $2) where id = $1", [id, minutes]));
const reclaimable = async (email: string, minAge = "10 minutes") => (await admin.rpc("reclaimable_orphan_auth_user", { p_email: email, p_min_age: minAge })).data as string | null;

afterAll(async () => {
  if (identifiers.length > 0) await admin.from("rate_limits").delete().in("identifier", identifiers);
  await admin.from("user_profiles").delete().in("id", userIds);
  await admin.from("account_types").delete().in("user_id", userIds);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
});

describe("rate limiter — atomic", () => {
  it("lets exactly max_attempts through under concurrency, with no database error (the old first-insert race let an extra one through)", async () => {
    for (let round = 0; round < 5; round++) {
      const id = `m9-race:${randomUUID()}`;
      const results = await Promise.all(Array.from({ length: 40 }, () => limit(id, 900, 5)));
      expect(results.filter((r) => r.error)).toHaveLength(0);
      expect(results.filter((r) => r.data === true)).toHaveLength(5);
      expect(results.filter((r) => r.data === false)).toHaveLength(35);
    }
  });

  it("caps the stored count at max + 1 however many denied attempts follow, and never extends the window", async () => {
    const id = `m9-cap:${randomUUID()}`;
    for (let i = 0; i < 12; i++) await limit(id, 900, 3);
    const { data } = await admin.from("rate_limits").select("attempt_count, window_start").eq("identifier", id).single();
    expect(data?.attempt_count).toBe(4);
    const startedAt = data?.window_start;
    await limit(id, 900, 3);
    expect((await admin.from("rate_limits").select("window_start").eq("identifier", id).single()).data?.window_start).toBe(startedAt);
  });

  it("opens a fresh window once the old one has ended", async () => {
    const id = `m9-window:${randomUUID()}`;
    for (let i = 0; i < 3; i++) await limit(id, 60, 2);
    expect((await limit(id, 60, 2)).data).toBe(false);
    await withDb((db) => db.query("update rate_limits set window_start = now() - interval '2 minutes' where identifier = $1", [id]));
    expect((await limit(id, 60, 2)).data).toBe(true);
    expect((await admin.from("rate_limits").select("attempt_count").eq("identifier", id).single()).data?.attempt_count).toBe(1);
  });

  it("a denied call is an answer, never an error", async () => {
    const id = `m9-deny:${randomUUID()}`;
    await limit(id, 60, 1);
    const denied = await limit(id, 60, 1);
    expect(denied.error).toBeNull();
    expect(denied.data).toBe(false);
  });

  it("the public anon key can no longer spend anybody's bucket (it used to lock people out of signing in)", async () => {
    const victim = `login:m9-victim-${randomUUID()}`;
    identifiers.push(victim);
    const { error, data } = await anon.rpc("check_and_increment_rate_limit", { p_identifier: victim, p_window_seconds: 900, p_max_attempts: 10 });
    expect(error?.code).toBe("42501");
    expect(data).toBeNull();
    expect((await admin.from("rate_limits").select("identifier").eq("identifier", victim)).data).toHaveLength(0);
  });
});

describe("prune_rate_limits", () => {
  it("removes only rows whose window ended long ago, in bounded batches", async () => {
    const old = [1, 2, 3].map((n) => `m9-prune-old-${n}:${randomUUID()}`);
    const fresh = `m9-prune-fresh:${randomUUID()}`;
    identifiers.push(...old, fresh);
    await admin.from("rate_limits").insert([...old.map((identifier) => ({ identifier, window_start: new Date(Date.now() - 5 * 86_400_000).toISOString(), attempt_count: 1 })), { identifier: fresh, window_start: new Date().toISOString(), attempt_count: 1 }]);

    const first = await admin.rpc("prune_rate_limits", { p_older_than: "2 days", p_batch: 2 });
    expect(first.error).toBeNull();
    expect(first.data).toBeGreaterThanOrEqual(2);
    // Whatever other expired rows exist in a shared database, a few more calls clear all three of ours and leave the fresh row.
    for (let i = 0; i < 20; i++) if (((await admin.rpc("prune_rate_limits", { p_older_than: "2 days", p_batch: 5000 })).data as number) === 0) break;
    const left = (await admin.from("rate_limits").select("identifier").in("identifier", [...old, fresh])).data?.map((r) => r.identifier);
    expect(left).toEqual([fresh]);
  });
});

describe("reclaimable_orphan_auth_user", () => {
  it("finds an old, unconfirmed, never-used login with no account and no profile — matching the email case-insensitively", async () => {
    const login = await makeLogin({ confirmed: false });
    await ageLogin(login.id, 30);
    expect(await reclaimable(login.email)).toBe(login.id);
    expect(await reclaimable(`  ${login.email.toUpperCase()} `)).toBe(login.id);
  });

  it("leaves a recent one alone (a Sponsor application is created in two steps, seconds apart)", async () => {
    const login = await makeLogin({ confirmed: false });
    expect(await reclaimable(login.email)).toBeNull();
    await ageLogin(login.id, 5);
    expect(await reclaimable(login.email)).toBeNull();
    await ageLogin(login.id, 11);
    expect(await reclaimable(login.email)).toBe(login.id);
  });

  it("never offers a confirmed login — every Member is one", async () => {
    const login = await makeLogin({ confirmed: true });
    await ageLogin(login.id, 600);
    expect(await reclaimable(login.email)).toBeNull();
  });

  it("never offers one that has been signed in to", async () => {
    const login = await makeLogin({ confirmed: false });
    await ageLogin(login.id, 60);
    await withDb((db) => db.query("update auth.users set last_sign_in_at = now() where id = $1", [login.id]));
    expect(await reclaimable(login.email)).toBeNull();
  });

  it("never offers one that has an account type (a Sponsor awaiting verification, a Member) or a profile", async () => {
    const typed = await makeLogin({ confirmed: false });
    await ageLogin(typed.id, 60);
    await admin.from("account_types").insert({ user_id: typed.id, account_type: "MEMBER" });
    expect(await reclaimable(typed.email)).toBeNull();

    const profiled = await makeLogin({ confirmed: false });
    await ageLogin(profiled.id, 60);
    await admin.from("account_types").insert({ user_id: profiled.id, account_type: "MEMBER" });
    await admin.from("user_profiles").insert({ id: profiled.id, display_name: "m9", username: `m9_${profiled.id.slice(0, 8)}`, role: "player", is_active: true });
    expect(await reclaimable(profiled.email)).toBeNull();
  });

  it("finds nothing for an address that has no login", async () => {
    expect(await reclaimable(`m9-nobody-${randomUUID()}@example.test`)).toBeNull();
  });

  it("only the service role may ask", async () => {
    const { error } = await anon.rpc("reclaimable_orphan_auth_user", { p_email: "x@example.test", p_min_age: "1 minute" });
    expect(error?.code).toBe("42501");
  });
});

describe("reserved usernames", () => {
  async function player(role: "player" | "super_admin" = "player") {
    const login = await makeLogin({ confirmed: true });
    await admin.from("account_types").insert({ user_id: login.id, account_type: "MEMBER" });
    return { ...login, role };
  }
  const insertProfile = (p: { id: string; role: "player" | "super_admin" }, username: string | null) => admin.from("user_profiles").insert({ id: p.id, display_name: "m9", username, role: p.role, is_active: true });

  it("ships a short, impersonation-only list", async () => {
    const { data } = await admin.from("reserved_usernames").select("username");
    const names = new Set(data?.map((r) => r.username));
    for (const n of ["admin", "brohda", "support", "moderator", "official"]) expect(names.has(n)).toBe(true);
    expect(names.size).toBeLessThanOrEqual(15);
  });

  it("refuses a reserved handle for a player profile, whatever its case, at the database", async () => {
    for (const handle of ["admin", "Admin", "BROHDA"]) {
      const p = await player();
      const { error } = await insertProfile(p, handle);
      expect(error?.message).toContain("reserved_username");
    }
  });

  it("accepts an ordinary handle, and a handle that merely contains a reserved word", async () => {
    const a = await player();
    expect((await insertProfile(a, `m9_${a.id.slice(0, 8)}`)).error).toBeNull();
    const b = await player();
    expect((await insertProfile(b, `admin_${b.id.slice(0, 8)}`)).error).toBeNull();
  });

  it("refuses setting a reserved handle later, and lets a profile that already holds one (a staff handle, since demoted) keep being edited", async () => {
    const p = await player();
    await insertProfile(p, null);
    const refused = await admin.from("user_profiles").update({ username: "support" }).eq("id", p.id);
    expect(refused.error?.message).toContain("reserved_username");
    expect((await admin.from("user_profiles").update({ username: `m9_${p.id.slice(0, 8)}` }).eq("id", p.id)).error).toBeNull();

    const holder = await player("super_admin");
    expect((await insertProfile(holder, "official")).error).toBeNull();
    await admin.from("user_profiles").update({ role: "player" }).eq("id", holder.id);
    expect((await admin.from("user_profiles").update({ display_name: "renamed" }).eq("id", holder.id)).error).toBeNull();
  });

  it("does not apply to staff profiles", async () => {
    const staff = await player("super_admin");
    const { error } = await insertProfile(staff, "admin");
    expect(error).toBeNull();
  });

  it("the list is closed to the public: anon can neither read nor change it", async () => {
    expect((await anon.from("reserved_usernames").select("username")).error?.code).toBe("42501");
    expect((await anon.from("reserved_usernames").insert({ username: "m9nope" })).error?.code).toBe("42501");
  });
});
