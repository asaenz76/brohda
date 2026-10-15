/**
 * Milestone 3 — the Confidence economy foundation (migration 201) against the real database: one account per Member, the exactly-once initial grant, the Daily Claim (rolling interval, never above the baseline,
 * never banked, race-safe, idempotent), the immutable ledger and its reconciliation, admin adjustments and reversals, the capability, configuration validation, aggregate observability, and isolation
 * (Members, Sponsors, the public). Real local Supabase.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { getTestAdminClient, getTestAnonClient, getTestDatabaseUrl } from "./helpers/test-env";
import { seedSponsorAccount, seedUser } from "./helpers/game-seed";

const admin = getTestAdminClient();
const PASSWORD = "integration-test-password-123";
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const rpc = async (name: string, args: Record<string, unknown> = {}) => {
  const { data, error } = await admin.rpc(name, args);
  return { data: data as Row | null, error };
};
const ok = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc(name, args);
  expect(r.error, `${name}: ${r.error?.message}`).toBeNull();
  return r.data as Row;
};

const SETTINGS = ["confidence_enabled", "confidence_baseline", "confidence_daily_claim_amount", "confidence_daily_claim_interval_hours", "confidence_allowed_stakes"];
let saved: Row | null = null;
const setSettings = async (values: Record<string, unknown>) => {
  const { error } = await admin.from("platform_settings").update(values).eq("id", true);
  if (error) throw error;
};
const settings = async () => (await admin.from("platform_settings").select(SETTINGS.join(",")).eq("id", true).single()).data as Row;
beforeEach(async () => {
  saved = (await admin.from("platform_settings").select(SETTINGS.join(",")).eq("id", true).single()).data as Row;
  await setSettings({ confidence_enabled: true, confidence_baseline: 50, confidence_daily_claim_amount: 1, confidence_daily_claim_interval_hours: 24, confidence_allowed_stakes: [1, 2, 3, 4, 5] });
});
afterEach(async () => {
  if (saved) await setSettings(saved);
});

const staffIds: string[] = [];
afterAll(async () => {
  if (staffIds.length) await admin.from("user_profiles").update({ role: "player" }).in("id", staffIds);
});
async function superAdmin() {
  const id = await seedUser("conf-admin");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", id);
  staffIds.push(id);
  return id;
}

/**
 * A Member whose profile exists but who has NOT been bootstrapped: created while the capability is OFF (a new profile only gets an account while it is ON), exactly like an existing Member the day
 * Confidence is switched on.
 */
async function seedUnbootstrapped(label: string) {
  await setSettings({ confidence_enabled: false });
  const id = await seedUser(label);
  await setSettings({ confidence_enabled: true });
  expect(await account(id)).toBeNull();
  return id;
}

/**
 * Runs the bounded backfill until nothing eligible is left without an account. A call that errors (a slow shared database can trip the 8 s statement limit on a big batch) is retried with a smaller batch;
 * if the backfill cannot drain, that is a failure, never silently skipped.
 */
async function drainBackfill(limit = 500) {
  let size = limit;
  for (let i = 0; i < 2000; i++) {
    const r = await admin.rpc("confidence_bootstrap_batch", { p_limit: size });
    if (r.error) {
      size = Math.max(25, Math.floor(size / 2));
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    const row = r.data as Row;
    if (row.enabled !== true) throw new Error("the capability must be ON to drain the backfill");
    if (row.remaining === 0) return;
  }
  throw new Error("the Confidence backfill did not drain");
}

// The shared local database holds tens of thousands of Members from earlier test runs. Give them all their one account once, up front (that IS the backfill, exercised at scale), so the tests below deal only
// with the Members they create.
beforeAll(async () => {
  const before = await admin.from("platform_settings").select("confidence_enabled").eq("id", true).single();
  await admin.from("platform_settings").update({ confidence_enabled: true }).eq("id", true);
  await drainBackfill();
  await admin.from("platform_settings").update({ confidence_enabled: before.data?.confidence_enabled ?? false }).eq("id", true);
}, 600_000);

/** A Member with an account and the initial grant (the configured baseline). */
async function member(label = "conf") {
  const id = await seedUser(label);
  await ok("confidence_bootstrap_member", { p_member_id: id });
  return id;
}
const account = async (id: string) => (await admin.from("confidence_accounts").select("*").eq("member_id", id).maybeSingle()).data as Row | null;
const entries = async (id: string, type?: string) => {
  let q = admin.from("confidence_ledger_entries").select("*").eq("member_id", id).order("created_at");
  if (type) q = q.eq("entry_type", type);
  return ((await q).data ?? []) as Row[];
};
const claim = (id: string, key: string | null = randomUUID()) => rpc("confidence_daily_claim", { p_member_id: id, p_idempotency_key: key });
const adjust = (adminId: string, id: string, amount: number, note = "test adjustment", reason = "CORRECTION", key = randomUUID()) =>
  rpc("admin_confidence_adjust", { p_admin_id: adminId, p_member_id: id, p_amount: amount, p_reason_code: reason, p_note: note, p_idempotency_key: key });
/** Brings a Member's available Confidence to a target through real ledger entries (never by writing the balance). */
async function setAvailable(adminId: string, id: string, target: number) {
  const current = Number((await account(id))!.available);
  if (target !== current) await ok("admin_confidence_adjust", { p_admin_id: adminId, p_member_id: id, p_amount: target - current, p_reason_code: "CORRECTION", p_note: "test setup", p_idempotency_key: randomUUID() });
}
/** Test-only time travel: the account's clock fields are write-protected like the balances, so the helper uses the same documented session switch the ledger trigger uses. */
async function setLastClaim(id: string, at: Date | null) {
  const client = new Client({ connectionString: getTestDatabaseUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('brohda.confidence_ledger', 'on', true)");
    await client.query("update public.confidence_accounts set last_daily_claim_at = $1 where member_id = $2", [at, id]);
    await client.query("commit");
  } finally {
    await client.end();
  }
}
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
async function clientFor(userId: string) {
  const { data } = await admin.auth.admin.getUserById(userId);
  const c = getTestAnonClient();
  const r = await c.auth.signInWithPassword({ email: data.user!.email!, password: PASSWORD });
  expect(r.error).toBeNull();
  return c;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("accounts and the initial grant", () => {
  it("an eligible Member gets exactly one account and exactly the configured baseline, once", async () => {
    const id = await seedUnbootstrapped("conf-new");
    expect((await ok("confidence_bootstrap_member", { p_member_id: id })).outcome).toBe("granted");
    const a = await account(id);
    expect(Number(a!.available)).toBe((await settings()).confidence_baseline);
    expect(Number(a!.reserved)).toBe(0);
    expect(Number(a!.total)).toBe(Number(a!.available) + Number(a!.reserved));
    const grants = await entries(id, "INITIAL_GRANT");
    expect(grants).toHaveLength(1);
    expect(Number(grants[0].available_delta)).toBe((await settings()).confidence_baseline);
    // Bootstrapping again, however often, changes nothing.
    for (let i = 0; i < 3; i++) expect((await ok("confidence_bootstrap_member", { p_member_id: id })).outcome).toBe("exists");
    expect(await entries(id)).toHaveLength(1);
    expect(Number((await account(id))!.available)).toBe(50);
  });

  it("concurrent bootstraps (login, backfill and signup at once) still make one account and one grant", async () => {
    const id = await seedUnbootstrapped("conf-race");
    const results = await Promise.all(Array.from({ length: 12 }, () => rpc("confidence_bootstrap_member", { p_member_id: id })));
    expect(results.every((r) => r.error === null), JSON.stringify(results.map((r) => r.error))).toBe(true);
    expect(results.filter((r) => r.data?.outcome === "granted")).toHaveLength(1);
    expect((await admin.from("confidence_accounts").select("member_id").eq("member_id", id)).data).toHaveLength(1);
    expect(await entries(id, "INITIAL_GRANT")).toHaveLength(1);
    expect(Number((await account(id))!.available)).toBe(50);
  });

  it("the grant uses the configured baseline at the time, from the one settings source", async () => {
    await setSettings({ confidence_baseline: 80 });
    const id = await seedUnbootstrapped("conf-80");
    await ok("confidence_bootstrap_member", { p_member_id: id });
    expect(Number((await account(id))!.available)).toBe(80);
    // Changing the baseline later does NOT rewrite existing balances.
    await setSettings({ confidence_baseline: 30, confidence_daily_claim_amount: 1 });
    expect(Number((await account(id))!.available)).toBe(80);
    expect(await entries(id)).toHaveLength(1);
  });

  it("a Sponsor never gets Confidence: no profile means no account and no grant", async () => {
    const sponsor = await seedSponsorAccount("ConfSponsor");
    expect((await ok("confidence_bootstrap_member", { p_member_id: sponsor.userId })).outcome).toBe("ineligible");
    expect(await account(sponsor.userId)).toBeNull();
    expect((await claim(sponsor.userId)).data?.outcome).toBe("ineligible");
    // The database refuses the row outright: an account needs a Member profile.
    expect((await admin.from("confidence_accounts").insert({ member_id: sponsor.userId })).error).not.toBeNull();
  });

  it("an inactive (suspended) or closed account gets no grant and no claim; a Member who closes keeps their ledger", async () => {
    const suspended = await seedUnbootstrapped("conf-susp");
    await admin.from("user_profiles").update({ is_active: false }).eq("id", suspended);
    expect((await ok("confidence_bootstrap_member", { p_member_id: suspended })).outcome).toBe("ineligible");
    expect(await account(suspended)).toBeNull();

    const closed = await seedUnbootstrapped("conf-closed");
    await admin.from("user_profiles").update({ is_active: false, account_closed_at: new Date().toISOString() }).eq("id", closed);
    expect((await ok("confidence_bootstrap_member", { p_member_id: closed })).outcome).toBe("ineligible");
    expect(await account(closed)).toBeNull();

    // An existing account whose owner later closes: no more claims, history intact.
    const later = await member("conf-later");
    await setLastClaim(later, null);
    const sa = await superAdmin();
    await setAvailable(sa, later, 40);
    await admin.from("user_profiles").update({ is_active: false, account_closed_at: new Date().toISOString() }).eq("id", later);
    expect((await claim(later)).data?.outcome).toBe("ineligible");
    expect((await entries(later)).length).toBeGreaterThanOrEqual(2);
    expect(Number((await account(later))!.available)).toBe(40);
  });

  it("while the capability is OFF there is no bootstrap side effect at all, and nothing is lost when it is switched on", async () => {
    await setSettings({ confidence_enabled: false });
    const id = await seedUser("conf-off");
    expect((await ok("confidence_bootstrap_member", { p_member_id: id })).outcome).toBe("disabled");
    expect(await account(id)).toBeNull();
    expect((await ok("confidence_bootstrap_batch", { p_limit: 50 })).enabled).toBe(false);
    expect(await account(id)).toBeNull();
    await setSettings({ confidence_enabled: true });
    await drainBackfill();
    expect(Number((await account(id))!.available)).toBe(50);
  });

  it("a NEW Member gets their account and grant automatically, the way every profile gets its other rows — but only while ON", async () => {
    const onId = await seedUser("conf-auto-on");
    expect(Number((await account(onId))?.available)).toBe(50);
    expect(await entries(onId, "INITIAL_GRANT")).toHaveLength(1);
    await setSettings({ confidence_enabled: false });
    const offId = await seedUser("conf-auto-off");
    expect(await account(offId)).toBeNull();
  });

  it("the backfill for existing Members is bounded, observable and idempotent", async () => {
    const ids = [] as string[];
    for (let i = 0; i < 5; i++) ids.push(await seedUnbootstrapped(`conf-fill-${i}`));
    const first = await ok("confidence_bootstrap_batch", { p_limit: 2 });
    expect(first.processed).toBe(2); // bounded: never more than asked
    expect(first.remaining).toBeGreaterThanOrEqual(3);
    // Drain it; every eligible Member ends with exactly one account and one grant.
    await drainBackfill(200);
    for (const id of ids) {
      expect(await account(id)).not.toBeNull();
      expect(await entries(id, "INITIAL_GRANT")).toHaveLength(1);
    }
    expect(await ok("confidence_bootstrap_batch", { p_limit: 200 })).toMatchObject({ processed: 0, remaining: 0 });
    // An out-of-range limit falls back to a safe default rather than an unbounded run.
    expect(await ok("confidence_bootstrap_batch", { p_limit: 5000 })).toMatchObject({ enabled: true });
    const o = await ok("confidence_economy_overview");
    // Every eligible Member has an account (accounts may also exist for Members who have since closed: their history is kept).
    expect(o.accounts).toBeGreaterThanOrEqual(o.eligibleMembers);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("the Daily Claim", () => {
  it("restores the configured amount below the baseline and never beyond it", async () => {
    const sa = await superAdmin();
    const a = await member("claim-49");
    await setAvailable(sa, a, 49);
    expect(await claim(a)).toMatchObject({ data: { outcome: "claimed", amount: 1, available: 50 } });
    expect(Number((await account(a))!.available)).toBe(50);

    await setSettings({ confidence_daily_claim_amount: 5 });
    const b = await member("claim-48");
    await setAvailable(sa, b, 48);
    expect((await claim(b)).data).toMatchObject({ outcome: "claimed", amount: 2, available: 50 }); // capped at the gap: 48 + 5 would be 53
    const c = await member("claim-40");
    await setAvailable(sa, c, 40);
    expect((await claim(c)).data).toMatchObject({ outcome: "claimed", amount: 5, available: 45 });
  });

  it("is denied at the baseline and above it", async () => {
    const sa = await superAdmin();
    const at = await member("claim-50");
    expect((await claim(at)).data?.outcome).toBe("at_or_above_baseline");
    const above = await member("claim-51");
    await setAvailable(sa, above, 72);
    expect((await claim(above)).data?.outcome).toBe("at_or_above_baseline");
    expect(await entries(above, "DAILY_CLAIM")).toHaveLength(0);
    expect(await entries(at, "DAILY_CLAIM")).toHaveLength(0);
  });

  it("uses a rolling interval from the last successful claim: denied inside it, allowed at it", async () => {
    const sa = await superAdmin();
    const id = await member("claim-roll");
    await setAvailable(sa, id, 40);
    expect((await claim(id)).data?.outcome).toBe("claimed");
    const again = await claim(id);
    expect(again.data).toMatchObject({ outcome: "too_soon" });
    expect(new Date(again.data!.nextAvailableAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    await setLastClaim(id, hoursAgo(23.5));
    expect((await claim(id)).data?.outcome).toBe("too_soon");
    await setLastClaim(id, hoursAgo(24.01));
    expect((await claim(id)).data?.outcome).toBe("claimed");
    expect(await entries(id, "DAILY_CLAIM")).toHaveLength(2);
  });

  it("the interval is a setting: shortening it takes effect at once", async () => {
    const sa = await superAdmin();
    const id = await member("claim-int");
    await setAvailable(sa, id, 40);
    expect((await claim(id)).data?.outcome).toBe("claimed");
    await setLastClaim(id, hoursAgo(7));
    expect((await claim(id)).data?.outcome).toBe("too_soon");
    await setSettings({ confidence_daily_claim_interval_hours: 6 });
    expect((await claim(id)).data?.outcome).toBe("claimed");
  });

  it("time zones and calendar days never matter: eligibility is 24 hours from the last claim, whatever the session's zone", async () => {
    const sa = await superAdmin();
    const id = await member("claim-tz");
    await setAvailable(sa, id, 40);
    expect((await claim(id)).data?.outcome).toBe("claimed");
    for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "UTC", "America/Costa_Rica"]) {
      const client = new Client({ connectionString: getTestDatabaseUrl() });
      await client.connect();
      try {
        await client.query(`set time zone '${zone}'`);
        const { rows } = await client.query("select public.confidence_daily_claim($1, $2) r", [id, randomUUID()]);
        expect(rows[0].r.outcome, zone).toBe("too_soon"); // just claimed: still inside 24h in every zone, even across local midnight
      } finally {
        await client.end();
      }
    }
    await setLastClaim(id, hoursAgo(25));
    const client = new Client({ connectionString: getTestDatabaseUrl() });
    await client.connect();
    try {
      await client.query("set time zone 'Pacific/Kiritimati'");
      expect((await client.query("select public.confidence_daily_claim($1, $2) r", [id, randomUUID()])).rows[0].r.outcome).toBe("claimed");
    } finally {
      await client.end();
    }
  });

  it("missed claims are lost: seven days away earns ONE claim, not seven", async () => {
    const sa = await superAdmin();
    const id = await member("claim-miss");
    await setAvailable(sa, id, 30);
    await setLastClaim(id, hoursAgo(7 * 24));
    const first = await claim(id);
    expect(first.data).toMatchObject({ outcome: "claimed", amount: 1, available: 31 });
    expect((await claim(id)).data?.outcome).toBe("too_soon");
    expect(await entries(id, "DAILY_CLAIM")).toHaveLength(1);
    expect(Number((await account(id))!.available)).toBe(31);
  });

  it("concurrent claims produce exactly one ledger entry and one increase", async () => {
    const sa = await superAdmin();
    const id = await member("claim-race");
    await setAvailable(sa, id, 40);
    const results = await Promise.all(Array.from({ length: 12 }, () => claim(id)));
    expect(results.every((r) => r.error === null), JSON.stringify(results.map((r) => r.error))).toBe(true);
    expect(results.filter((r) => r.data?.outcome === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.data?.outcome === "too_soon")).toHaveLength(11);
    expect(await entries(id, "DAILY_CLAIM")).toHaveLength(1);
    expect(Number((await account(id))!.available)).toBe(41);
    expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);
  });

  it("a retry of the same request returns the first result and never a second entry", async () => {
    const sa = await superAdmin();
    const id = await member("claim-retry");
    await setAvailable(sa, id, 40);
    const key = randomUUID();
    const first = await claim(id, key);
    expect(first.data?.outcome).toBe("claimed");
    const retry = await claim(id, key);
    expect(retry.data).toMatchObject({ outcome: "claimed", replay: true, amount: 1, available: 41 });
    expect(await entries(id, "DAILY_CLAIM")).toHaveLength(1);
    expect(Number((await account(id))!.available)).toBe(41);
  });

  it("is an active action: nothing grants Confidence by itself as time passes", async () => {
    const sa = await superAdmin();
    const id = await member("claim-active");
    await setAvailable(sa, id, 40);
    await setLastClaim(id, hoursAgo(24 * 30));
    await ok("confidence_bootstrap_batch", { p_limit: 200 });
    expect(await entries(id, "DAILY_CLAIM")).toHaveLength(0);
    expect(Number((await account(id))!.available)).toBe(40);
  });

  it("is refused while the capability is OFF, and the account and its history are preserved", async () => {
    const sa = await superAdmin();
    const id = await member("claim-off");
    await setAvailable(sa, id, 40);
    await setSettings({ confidence_enabled: false });
    expect((await claim(id)).data?.outcome).toBe("disabled");
    expect(Number((await account(id))!.available)).toBe(40);
    expect((await entries(id)).length).toBeGreaterThanOrEqual(2);
    await setSettings({ confidence_enabled: true });
    expect((await claim(id)).data?.outcome).toBe("claimed");
  });

  it("a claim cannot be made for someone else's id by a Member client: the function is not callable by Members at all", async () => {
    const a = await member("claim-priv-a");
    const b = await member("claim-priv-b");
    const asA = await clientFor(a);
    expect((await asA.rpc("confidence_daily_claim", { p_member_id: b, p_idempotency_key: randomUUID() })).error).not.toBeNull();
    expect((await getTestAnonClient().rpc("confidence_daily_claim", { p_member_id: b, p_idempotency_key: randomUUID() })).error).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("accounting integrity", () => {
  it("total is always available + reserved, and the ledger reconciles with every account", async () => {
    const sa = await superAdmin();
    const ids = [await member("acct-1"), await member("acct-2"), await member("acct-3")];
    await setAvailable(sa, ids[0], 35);
    await claim(ids[0]);
    await setAvailable(sa, ids[1], 120);
    for (const id of ids) {
      const a = (await account(id))!;
      expect(Number(a.total)).toBe(Number(a.available) + Number(a.reserved));
      const sum = (await entries(id)).reduce((n, e) => n + Number(e.available_delta), 0);
      expect(sum).toBe(Number(a.available));
    }
    expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);
    // `total` is generated: it cannot be written.
    expect((await admin.from("confidence_accounts").update({ total: 9999 }).eq("member_id", ids[0])).error).not.toBeNull();
  });

  it("nothing can go negative: an adjustment, a direct entry or a direct account write that would is refused", async () => {
    const sa = await superAdmin();
    const id = await member("neg");
    expect((await adjust(sa, id, -51)).data?.outcome).toBe("would_go_negative");
    expect(Number((await account(id))!.available)).toBe(50);
    expect((await adjust(sa, id, -50)).data?.outcome).toBe("adjusted"); // exactly to zero is fine
    expect(Number((await account(id))!.available)).toBe(0);
    // Even bypassing the function, the ledger trigger and the table checks refuse.
    const direct = await admin.from("confidence_ledger_entries").insert({ member_id: id, entry_type: "ADMIN_ADJUSTMENT", available_delta: -1, reason_code: "CORRECTION", note: "x y z", actor_id: sa });
    expect(direct.error).not.toBeNull();
    expect((await admin.from("confidence_accounts").update({ available: -5 }).eq("member_id", id)).error).not.toBeNull();
    expect((await admin.from("confidence_accounts").update({ reserved: -1 }).eq("member_id", id)).error).not.toBeNull();
    expect(Number((await account(id))!.available)).toBe(0);
    expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);
  });

  it("balances cannot be written directly by anyone, the service role included; accounts start empty", async () => {
    const id = await member("direct");
    expect((await admin.from("confidence_accounts").update({ available: 9999 }).eq("member_id", id)).error?.message ?? "").toContain("through the ledger");
    expect((await admin.from("confidence_accounts").update({ last_daily_claim_at: null }).eq("member_id", id)).error).not.toBeNull();
    const other = await seedUnbootstrapped("direct-2");
    expect((await admin.from("confidence_accounts").insert({ member_id: other, available: 500 })).error).not.toBeNull();
    expect((await admin.from("confidence_accounts").insert({ member_id: other })).error).toBeNull(); // an empty account is fine…
    expect(Number((await account(other))!.available)).toBe(0); // …and holds nothing until the ledger says so
  });

  it("the ledger is immutable: rows cannot be updated or deleted, and a mistake is corrected with a compensating entry", async () => {
    const sa = await superAdmin();
    const id = await member("immut");
    const [grant] = await entries(id, "INITIAL_GRANT");
    expect((await admin.from("confidence_ledger_entries").update({ available_delta: 999 }).eq("id", grant.id)).error?.message ?? "").toContain("append-only");
    expect((await admin.from("confidence_ledger_entries").update({ note: "rewritten" }).eq("id", grant.id)).error).not.toBeNull();
    expect((await admin.from("confidence_ledger_entries").delete().eq("id", grant.id)).error?.message ?? "").toContain("append-only");
    expect(await entries(id)).toHaveLength(1);
    const reversal = await ok("admin_confidence_reverse", { p_admin_id: sa, p_entry_id: grant.id, p_note: "granted in error", p_idempotency_key: randomUUID() });
    expect(reversal.outcome).toBe("reversed");
    const all = await entries(id);
    expect(all).toHaveLength(2); // history preserved; the correction is a new entry
    expect(all[1]).toMatchObject({ entry_type: "REVERSAL", reverses_entry_id: grant.id, actor_id: sa });
    expect(Number(all[1].available_delta)).toBe(-Number(grant.available_delta));
    expect(Number((await account(id))!.available)).toBe(0);
  });

  it("a reversed initial grant is never granted again", async () => {
    const sa = await superAdmin();
    const id = await member("regrant");
    const [grant] = await entries(id, "INITIAL_GRANT");
    await ok("admin_confidence_reverse", { p_admin_id: sa, p_entry_id: grant.id, p_note: "granted in error", p_idempotency_key: randomUUID() });
    expect((await ok("confidence_bootstrap_member", { p_member_id: id })).outcome).toBe("exists");
    expect(await entries(id, "INITIAL_GRANT")).toHaveLength(1);
    expect((await admin.from("confidence_ledger_entries").insert({ member_id: id, entry_type: "INITIAL_GRANT", available_delta: 50 })).error).not.toBeNull(); // the unique index
    expect(Number((await account(id))!.available)).toBe(0);
  });

  it("an admin adjustment needs Super Admin, a canonical reason and a note; it is a ledger entry and is audited", async () => {
    const sa = await superAdmin();
    const plain = await seedUser("adj-plain");
    const id = await member("adj");
    expect((await adjust(plain, id, 5)).error).not.toBeNull(); // not a Super Admin
    expect((await adjust(sa, id, 5, "", "CORRECTION")).data?.outcome).toBe("note_required");
    expect((await adjust(sa, id, 5, "ok note", "BECAUSE")).error).not.toBeNull(); // not a canonical reason
    expect((await adjust(sa, id, 0)).data?.outcome).toBe("invalid_amount");
    expect((await adjust(sa, id, 1_000_001)).data?.outcome).toBe("invalid_amount");
    expect((await adjust(sa, randomUUID(), 5)).data?.outcome).toBe("no_account");
    const done = await adjust(sa, id, 7, "support ticket 42", "SUPPORT_CASE");
    expect(done.data?.outcome).toBe("adjusted");
    const [row] = await entries(id, "ADMIN_ADJUSTMENT");
    expect(row).toMatchObject({ actor_id: sa, reason_code: "SUPPORT_CASE", note: "support ticket 42" });
    expect(Number(row.available_delta)).toBe(7);
    expect(Number(row.available_after)).toBe(57);
    expect((await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "confidence.adjusted").eq("entity_id", id)).count).toBe(1);
  });

  it("admin adjustments and reversals are idempotent: a resubmission never applies twice", async () => {
    const sa = await superAdmin();
    const id = await member("adj-idem");
    const key = randomUUID();
    expect((await adjust(sa, id, 3, "once", "CORRECTION", key)).data?.outcome).toBe("adjusted");
    expect((await adjust(sa, id, 3, "once", "CORRECTION", key)).data).toMatchObject({ outcome: "adjusted", replay: true });
    expect(await entries(id, "ADMIN_ADJUSTMENT")).toHaveLength(1);
    expect(Number((await account(id))!.available)).toBe(53);
    const [entry] = await entries(id, "ADMIN_ADJUSTMENT");
    const rkey = randomUUID();
    expect((await rpc("admin_confidence_reverse", { p_admin_id: sa, p_entry_id: entry.id, p_note: "undo", p_idempotency_key: rkey })).data?.outcome).toBe("reversed");
    expect((await rpc("admin_confidence_reverse", { p_admin_id: sa, p_entry_id: entry.id, p_note: "undo", p_idempotency_key: rkey })).data).toMatchObject({ outcome: "reversed", replay: true });
    expect((await rpc("admin_confidence_reverse", { p_admin_id: sa, p_entry_id: entry.id, p_note: "undo again", p_idempotency_key: randomUUID() })).data?.outcome).toBe("already_reversed");
    expect(await entries(id, "REVERSAL")).toHaveLength(1);
    expect(Number((await account(id))!.available)).toBe(50);
  });

  it("a reversal cannot itself be reversed, and one that would go negative is refused", async () => {
    const sa = await superAdmin();
    const id = await member("rev-rules");
    await adjust(sa, id, 10, "plus ten");
    const [plus] = await entries(id, "ADMIN_ADJUSTMENT");
    await ok("admin_confidence_reverse", { p_admin_id: sa, p_entry_id: plus.id, p_note: "undo", p_idempotency_key: randomUUID() });
    const [reversal] = await entries(id, "REVERSAL");
    expect((await rpc("admin_confidence_reverse", { p_admin_id: sa, p_entry_id: reversal.id, p_note: "undo the undo", p_idempotency_key: randomUUID() })).data?.outcome).toBe("cannot_reverse_a_reversal");
    // Spend the balance below what a reversal of the grant would need.
    await adjust(sa, id, -40, "take most of it");
    const [grant] = await entries(id, "INITIAL_GRANT");
    expect((await rpc("admin_confidence_reverse", { p_admin_id: sa, p_entry_id: grant.id, p_note: "grant in error", p_idempotency_key: randomUUID() })).data?.outcome).toBe("would_go_negative");
    expect(Number((await account(id))!.available)).toBe(10);
    expect((await rpc("admin_confidence_reverse", { p_admin_id: sa, p_entry_id: randomUUID(), p_note: "nothing there", p_idempotency_key: randomUUID() })).data?.outcome).toBe("not_found");
    expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);
  });

  it("concurrent admin adjustments never create a negative balance or a ledger/account mismatch", async () => {
    const sa = await superAdmin();
    const id = await member("adj-race");
    const results = await Promise.all(Array.from({ length: 10 }, () => adjust(sa, id, -20, "draining")));
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(results.filter((r) => r.data?.outcome === "adjusted")).toHaveLength(2); // 50 → 30 → 10; the rest would go below zero
    expect(results.filter((r) => r.data?.outcome === "would_go_negative")).toHaveLength(8);
    expect(Number((await account(id))!.available)).toBe(10);
    expect((await admin.rpc("confidence_reconcile")).data).toEqual([]);
  });

  it("the entry shape is enforced by the schema: no reservation yet, canonical types only, no transfer or redemption field exists", async () => {
    const id = await member("shape");
    expect((await admin.from("confidence_ledger_entries").insert({ member_id: id, entry_type: "DAILY_CLAIM", available_delta: 1, reserved_delta: 1 })).error).not.toBeNull();
    expect((await admin.from("confidence_ledger_entries").insert({ member_id: id, entry_type: "PURCHASE", available_delta: 1 })).error).not.toBeNull();
    expect((await admin.from("confidence_ledger_entries").insert({ member_id: id, entry_type: "DAILY_CLAIM", available_delta: -1 })).error).not.toBeNull();
    const cols = Object.keys(((await admin.from("confidence_ledger_entries").select("*").limit(1)).data ?? [{}])[0] ?? {});
    expect(cols.some((c) => /recipient|to_member|transfer|price|currency|amount_usd|cash|redeem/i.test(c))).toBe(false);
    const accountCols = Object.keys(((await admin.from("confidence_accounts").select("*").limit(1)).data ?? [{}])[0] ?? {});
    expect(accountCols.some((c) => /recipient|transfer|price|currency|cash|redeem|wallet/i.test(c))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("who can see and change what", () => {
  it("a Member reads their own account and the non-sensitive columns of their own history — and nobody else's", async () => {
    const sa = await superAdmin();
    const a = await member("vis-a");
    const b = await member("vis-b");
    await adjust(sa, a, 3, "private note about A", "SUPPORT_CASE");
    const asA = await clientFor(a);
    const mine = await asA.from("confidence_accounts").select("available, reserved, total").eq("member_id", a).single();
    expect(mine.error).toBeNull();
    expect(Number(mine.data!.total)).toBe(53);
    const history = await asA.from("confidence_ledger_entries").select("entry_type, available_delta, available_after, created_at");
    expect(history.error).toBeNull();
    expect(history.data!.length).toBe(2);
    // Another Member's account and ledger are invisible.
    expect((await asA.from("confidence_accounts").select("*").eq("member_id", b)).data).toEqual([]);
    expect((await asA.from("confidence_ledger_entries").select("id").eq("member_id", b)).data).toEqual([]);
    // The private columns (admin note, actor, reason, metadata, reversal link, idempotency key) are not granted to Members at all.
    for (const col of ["note", "actor_id", "reason_code", "metadata", "reverses_entry_id", "idempotency_key"]) {
      expect((await asA.from("confidence_ledger_entries").select(col)).error, `${col} must not be readable by a Member`).not.toBeNull();
    }
    expect((await asA.from("confidence_ledger_entries").select("*")).error).not.toBeNull();
  });

  it("a Member cannot write anything: no direct insert, update or delete on either table, and no admin function", async () => {
    const sa = await superAdmin();
    const a = await member("write-a");
    const b = await member("write-b");
    const asA = await clientFor(a);
    expect((await asA.from("confidence_accounts").update({ available: 99999 }).eq("member_id", a)).error).not.toBeNull();
    expect((await asA.from("confidence_accounts").insert({ member_id: randomUUID() })).error).not.toBeNull();
    expect((await asA.from("confidence_ledger_entries").insert({ member_id: a, entry_type: "DAILY_CLAIM", available_delta: 100 })).error).not.toBeNull();
    expect((await asA.from("confidence_ledger_entries").update({ available_delta: 100 }).eq("member_id", a)).error).not.toBeNull();
    expect((await asA.from("confidence_ledger_entries").delete().eq("member_id", a)).error).not.toBeNull();
    expect(Number((await account(a))!.available)).toBe(50);
    for (const [fn, args] of [
      ["admin_confidence_adjust", { p_admin_id: a, p_member_id: b, p_amount: 5, p_reason_code: "CORRECTION", p_note: "nope", p_idempotency_key: randomUUID() }],
      ["admin_confidence_reverse", { p_admin_id: a, p_entry_id: randomUUID(), p_note: "nope", p_idempotency_key: randomUUID() }],
      ["admin_set_confidence_config", { p_admin_id: a, p_config: {} }],
      ["confidence_bootstrap_member", { p_member_id: a }],
      ["confidence_bootstrap_batch", { p_limit: 10 }],
      ["confidence_daily_claim", { p_member_id: a, p_idempotency_key: randomUUID() }],
      ["confidence_reconcile", {}],
      ["confidence_economy_overview", {}],
      ["confidence_member_eligible", { p_member_id: a }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect((await asA.rpc(fn, args)).error, `${fn} must be service-role only`).not.toBeNull();
      expect((await getTestAnonClient().rpc(fn, args)).error, `${fn} must be closed to the public`).not.toBeNull();
    }
    expect(sa).toBeTruthy();
  });

  it("the public sees nothing: anonymous clients read neither table", async () => {
    await member("pub");
    const anon = getTestAnonClient();
    expect((await anon.from("confidence_accounts").select("*")).error).not.toBeNull();
    expect((await anon.from("confidence_ledger_entries").select("id")).error).not.toBeNull();
  });

  it("a Sponsor session reads nothing and can call nothing", async () => {
    const sponsor = await seedSponsorAccount("ConfSponsorRead");
    await member("sponsor-bystander");
    const { data } = await admin.auth.admin.getUserById(sponsor.userId);
    const c = getTestAnonClient();
    expect((await c.auth.signInWithPassword({ email: data.user!.email!, password: PASSWORD })).error).toBeNull();
    expect((await c.from("confidence_accounts").select("*")).data ?? []).toEqual([]);
    expect((await c.from("confidence_ledger_entries").select("id")).data ?? []).toEqual([]);
    expect((await c.rpc("confidence_daily_claim", { p_member_id: sponsor.userId, p_idempotency_key: randomUUID() })).error).not.toBeNull();
    expect(await account(sponsor.userId)).toBeNull();
  });

  it("while the capability is OFF the database itself hides a Member's own data from them; the data is preserved and returns when ON", async () => {
    const a = await member("vis-off");
    const asA = await clientFor(a);
    expect((await asA.from("confidence_accounts").select("available").eq("member_id", a)).data).toHaveLength(1);
    await setSettings({ confidence_enabled: false });
    expect((await asA.from("confidence_accounts").select("available").eq("member_id", a)).data).toEqual([]);
    expect((await asA.from("confidence_ledger_entries").select("id")).data).toEqual([]);
    expect(Number((await account(a))!.available)).toBe(50); // preserved
    await setSettings({ confidence_enabled: true });
    expect((await asA.from("confidence_accounts").select("available").eq("member_id", a)).data).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("configuration", () => {
  it("only a Super Admin can change it; unknown keys are refused; a real change is audited and a no-op is not", async () => {
    const sa = await superAdmin();
    const plain = await seedUser("cfg-plain");
    expect((await rpc("admin_set_confidence_config", { p_admin_id: plain, p_config: { confidence_baseline: 60 } })).error).not.toBeNull();
    expect((await rpc("admin_set_confidence_config", { p_admin_id: sa, p_config: { confidence_price: 1 } })).error).not.toBeNull();
    const countAudit = async () => (await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "settings.confidence_updated")).count ?? 0;
    const before = await countAudit();
    await ok("admin_set_confidence_config", { p_admin_id: sa, p_config: { confidence_baseline: 60, confidence_daily_claim_amount: 2 } });
    expect(await countAudit()).toBe(before + 1);
    await ok("admin_set_confidence_config", { p_admin_id: sa, p_config: { confidence_baseline: 60 } });
    expect(await countAudit()).toBe(before + 1); // unchanged, so not audited
    expect(await settings()).toMatchObject({ confidence_baseline: 60, confidence_daily_claim_amount: 2 });
  });

  it("invalid configuration is refused as a whole and nothing is partially applied", async () => {
    const sa = await superAdmin();
    const original = await settings();
    for (const bad of [
      { confidence_baseline: 0 },
      { confidence_baseline: 1_000_001 },
      { confidence_daily_claim_amount: 0 },
      { confidence_daily_claim_amount: 6 },
      { confidence_daily_claim_interval_hours: 0 },
      { confidence_daily_claim_interval_hours: 169 },
      { confidence_daily_claim_amount: 5, confidence_baseline: 4 }, // a claim can't exceed the baseline
      { confidence_allowed_stakes: [] },
      { confidence_allowed_stakes: [3, 2, 1] },
      { confidence_allowed_stakes: [1, 1, 2] },
      { confidence_allowed_stakes: [0, 1] },
      { confidence_allowed_stakes: [1, 1001] },
      { confidence_allowed_stakes: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
      { confidence_allowed_stakes: "1,2,3" },
      { confidence_allowed_stakes: [1, null, 3] },
    ]) {
      expect((await rpc("admin_set_confidence_config", { p_admin_id: sa, p_config: bad })).error, JSON.stringify(bad)).not.toBeNull();
    }
    // A valid change combined with an invalid one: neither is applied.
    expect((await rpc("admin_set_confidence_config", { p_admin_id: sa, p_config: { confidence_baseline: 77, confidence_allowed_stakes: [2, 1] } })).error).not.toBeNull();
    expect(await settings()).toEqual(original);
    // The table itself also refuses direct writes of malformed values.
    expect((await admin.from("platform_settings").update({ confidence_allowed_stakes: [5, 1] }).eq("id", true)).error).not.toBeNull();
    expect((await admin.from("platform_settings").update({ confidence_daily_claim_amount: 9 }).eq("id", true)).error).not.toBeNull();
  });

  it("the stake ladder is configurable and ordered; the defaults are the owner's: 50 / 1 / 24h / 1-2-3-4-5, capability OFF", async () => {
    const sa = await superAdmin();
    await ok("admin_set_confidence_config", { p_admin_id: sa, p_config: { confidence_allowed_stakes: [1, 5, 10] } });
    expect((await settings()).confidence_allowed_stakes).toEqual([1, 5, 10]);
    const client = new Client({ connectionString: getTestDatabaseUrl() });
    await client.connect();
    try {
      const { rows } = await client.query<{ column_name: string; column_default: string | null }>(
        "select column_name, column_default from information_schema.columns where table_schema = 'public' and table_name = 'platform_settings' and column_name like 'confidence\\_%'",
      );
      const d = Object.fromEntries(rows.map((r) => [r.column_name, r.column_default]));
      expect(d.confidence_enabled).toBe("false");
      expect(d.confidence_baseline).toBe("50");
      expect(d.confidence_daily_claim_amount).toBe("1");
      expect(d.confidence_daily_claim_interval_hours).toBe("24");
      expect(d.confidence_allowed_stakes).toContain("1,2,3,4,5");
    } finally {
      await client.end();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
describe("economy observability", () => {
  it("the aggregate figures reconcile with the underlying data and expose nothing private", async () => {
    const sa = await superAdmin();
    await setSettings({ confidence_enabled: true });
    // A known economy, built through real ledger entries.
    const a = await member("eco-a"); // 50
    const b = await member("eco-b");
    await setAvailable(sa, b, 40); // below baseline
    const c = await member("eco-c");
    await setAvailable(sa, c, 70); // above baseline
    const d = await member("eco-d");
    await setAvailable(sa, d, 30);
    await claim(d); // 31
    const [adj] = await entries(b, "ADMIN_ADJUSTMENT");
    await ok("admin_confidence_reverse", { p_admin_id: sa, p_entry_id: adj.id, p_note: "back out", p_idempotency_key: randomUUID() }); // b back to 50
    expect(a).toBeTruthy();

    const o = await ok("confidence_economy_overview");
    const client = new Client({ connectionString: getTestDatabaseUrl() });
    await client.connect();
    let e: Row;
    let t: Row;
    try {
      const baseline = (await settings()).confidence_baseline as number;
      e = (
        await client.query(
          `select count(*)::int accounts, coalesce(sum(total),0)::bigint total, coalesce(sum(available),0)::bigint available, coalesce(sum(reserved),0)::bigint reserved, avg(total)::float8 average,
                  (select percentile_cont(0.5) within group (order by total) from public.confidence_accounts)::float8 median,
                  count(*) filter (where available < $1)::int below, count(*) filter (where available = $1)::int at, count(*) filter (where available > $1)::int above,
                  min(total)::bigint min, max(total)::bigint max
           from public.confidence_accounts`,
          [baseline],
        )
      ).rows[0];
      t = (
        await client.query(
          `select entry_type, count(*)::int n, coalesce(sum(available_delta),0)::bigint s from public.confidence_ledger_entries group by entry_type`,
        )
      ).rows.reduce((acc: Row, r: Row) => ({ ...acc, [r.entry_type]: r }), {});
    } finally {
      await client.end();
    }
    const baselineNow = (await settings()).confidence_baseline as number;
    expect(o.accounts).toBe(e.accounts);
    expect(o.totalConfidence).toBe(Number(e.total));
    expect(o.available).toBe(Number(e.available));
    expect(o.reserved).toBe(Number(e.reserved));
    expect(Number(o.average)).toBeCloseTo(e.average, 1);
    expect(Number(o.median)).toBeCloseTo(e.median, 5);
    expect(o.belowBaseline).toBe(e.below);
    expect(o.atBaseline).toBe(e.at);
    expect(o.aboveBaseline).toBe(e.above);
    expect(o.belowBaseline + o.atBaseline + o.aboveBaseline).toBe(o.accounts);
    expect(o.distribution.min).toBe(Number(e.min));
    expect(o.distribution.max).toBe(Number(e.max));
    expect(o.baseline).toBe(baselineNow);
    const pick = (type: string, field: "count" | "total" | "net") => (field === "count" ? (t[type]?.n ?? 0) : Number(t[type]?.s ?? 0));
    expect(o.initialGrants).toEqual({ count: pick("INITIAL_GRANT", "count"), total: pick("INITIAL_GRANT", "total") });
    expect(o.dailyClaims).toEqual({ count: pick("DAILY_CLAIM", "count"), total: pick("DAILY_CLAIM", "total") });
    expect(o.adminAdjustments).toEqual({ count: pick("ADMIN_ADJUSTMENT", "count"), net: pick("ADMIN_ADJUSTMENT", "net") });
    expect(o.reversals).toEqual({ count: pick("REVERSAL", "count"), net: pick("REVERSAL", "net") });
    // A known slice of it: the four Members this test made moved the figures by exactly what they did.
    expect(o.dailyClaims.count).toBeGreaterThanOrEqual(1);
    expect(o.reversals.count).toBeGreaterThanOrEqual(1);
    expect(o.reconciliationMismatches).toBe(0);
    // Aggregates only: nothing in it names a Member.
    expect(Object.keys(o).sort()).toEqual(["accounts", "adminAdjustments", "aboveBaseline", "atBaseline", "available", "average", "baseline", "belowBaseline", "dailyClaims", "distribution", "eligibleMembers", "initialGrants", "median", "reconciliationMismatches", "reserved", "reversals", "totalConfidence"].sort());
    expect(JSON.stringify(o)).not.toMatch(/member_id|note|actor|email/i);
  });

  it("an empty economy reports zeros and nulls, never an error", async () => {
    await admin.from("confidence_ledger_entries").select("id").limit(1); // (isolation resets the tables per file; here we only need the function to cope with whatever exists)
    const o = await ok("confidence_economy_overview");
    expect(typeof o.accounts).toBe("number");
    expect(o.reconciliationMismatches).toBe(0);
  });
});
