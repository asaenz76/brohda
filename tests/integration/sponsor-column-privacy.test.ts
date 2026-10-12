/**
 * Sponsor-facing columns of `sponsors` (migration 194), against the real database. A Sponsor's own signed-in Supabase client — the raw data API, not the app — may read
 * ONLY the Sponsor-facing columns of its own organization row. The Super Admin's private note (`internal_review_note`) and the staff/review metadata
 * (`reviewed_by`, `reviewed_at`, `created_by`) are admin-only: reading them fails with "permission denied", directly, through `select *`, through an embed, and by filtering on
 * them. The permitted columns, the RLS policies that join `sponsors`, and the application's own (service-role) reads keep working.
 *
 * The allowlist guard below fails when a column is added to `sponsors` without being classified — a new column is Sponsor-unreadable until someone deliberately grants it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestAnonClient, getTestSupabaseConfig } from "./helpers/test-env";
import { seedGame, seedSponsorAccount, seedUser } from "./helpers/game-seed";

const admin = getTestAdminClient();
const PASSWORD = "integration-test-password-123";
const HOUR = 3_600_000;
const MARKER = "PRIVATE-ADMIN-NOTE-do-not-show-the-sponsor";
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The columns a Sponsor may read on its own row. Keep in step with the grant in migration 194. */
const SPONSOR_READABLE = ["id", "display_name", "legal_name", "contact_email", "logo_path", "status", "status_reason", "website", "country", "contact_name", "contact_phone", "created_at", "updated_at"];
/** Admin-only: never readable by a client role. */
const ADMIN_ONLY = ["internal_review_note", "reviewed_by", "reviewed_at", "created_by"];

let repo: typeof import("@/lib/sponsorship/repository");
let staffId = "";
let a: { userId: string; sponsorId: string; email: string };
let b: { userId: string; sponsorId: string; email: string };
let aClient: SupabaseClient;

async function signedIn(email: string): Promise<SupabaseClient> {
  const client = getTestAnonClient();
  const r = await client.auth.signInWithPassword({ email, password: PASSWORD });
  expect(r.error).toBeNull();
  return client;
}
const denied = (error: { code?: string; message?: string } | null) => {
  expect(error, "expected the data API to refuse").not.toBeNull();
  expect(error!.code).toBe("42501"); // insufficient_privilege
};

beforeAll(async () => {
  const cfg = getTestSupabaseConfig();
  process.env.NEXT_PUBLIC_SUPABASE_URL = cfg.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = cfg.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = cfg.serviceRoleKey;
  repo = await import("@/lib/sponsorship/repository");

  staffId = await seedUser("colstaff");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", staffId);
  await admin.from("platform_settings").update({ sponsorship_enabled: true }).eq("id", true);

  a = await seedSponsorAccount("colsponsora");
  b = await seedSponsorAccount("colsponsorb");
  // Everything an admin might record about Sponsor A, including the private parts.
  const { error } = await admin.from("sponsors").update({
    internal_review_note: MARKER,
    reviewed_by: staffId,
    reviewed_at: new Date().toISOString(),
    created_by: staffId,
    status_reason: "Please add your website",
    website: "https://acme.example.com",
    country: "Colombia",
    contact_name: "Ana Pérez",
    contact_phone: "+57 300 000 0000",
    legal_name: "Acme S.A.S.",
    contact_email: a.email,
  }).eq("id", a.sponsorId);
  expect(error).toBeNull();
  aClient = await signedIn(a.email);
});
afterAll(async () => {
  await admin.from("user_profiles").update({ role: "player" }).eq("id", staffId);
  await admin.from("platform_settings").update({ sponsorship_enabled: false }).eq("id", true);
});

describe("a Sponsor's own signed-in client reads only the Sponsor-facing columns of its own row", () => {
  it("the permitted columns come back, with their real values", async () => {
    const { data, error } = await aClient.from("sponsors").select(SPONSOR_READABLE.join(",")).eq("id", a.sponsorId).single<Row>();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      id: a.sponsorId,
      status: "ACTIVE",
      status_reason: "Please add your website",
      website: "https://acme.example.com",
      country: "Colombia",
      contact_name: "Ana Pérez",
      contact_phone: "+57 300 000 0000",
      legal_name: "Acme S.A.S.",
      contact_email: a.email,
    });
    expect(Object.keys(data!).sort()).toEqual([...SPONSOR_READABLE].sort());
  });

  it.each(ADMIN_ONLY)("%s is refused (permission denied), not returned", async (column) => {
    const r = await aClient.from("sponsors").select(column).eq("id", a.sponsorId);
    denied(r.error);
    expect(r.data).toBeNull();
  });

  it("select * is refused and leaks nothing (it no longer returns every column)", async () => {
    const r = await aClient.from("sponsors").select("*").eq("id", a.sponsorId);
    denied(r.error);
    expect(JSON.stringify(r)).not.toContain(MARKER);
  });

  it("the private note cannot be probed through a filter either (no match-by-guessing oracle)", async () => {
    for (const q of [aClient.from("sponsors").select("id").eq("internal_review_note", MARKER), aClient.from("sponsors").select("id").ilike("internal_review_note", "PRIVATE%"), aClient.from("sponsors").select("id").not("reviewed_by", "is", null), aClient.from("sponsors").select("id").order("reviewed_at")]) {
      const r = await q;
      denied(r.error);
      expect(r.data).toBeNull();
    }
  });

  it("ALLOWLIST GUARD: the columns the Sponsor can read are exactly the intended ones — a new column must be classified here and in a migration", async () => {
    const { data: full } = await admin.from("sponsors").select("*").eq("id", a.sponsorId).single<Row>();
    const all = Object.keys(full!).sort();
    expect([...SPONSOR_READABLE, ...ADMIN_ONLY].sort(), "sponsors has a column this test (and the grant) has not classified as Sponsor-readable or admin-only").toEqual(all);
    const readable: string[] = [];
    for (const column of all) {
      const r = await aClient.from("sponsors").select(column).eq("id", a.sponsorId);
      if (!r.error) readable.push(column);
      else denied(r.error);
    }
    expect(readable.sort()).toEqual([...SPONSOR_READABLE].sort());
  });

  it("the row policy still holds: a Sponsor sees its own organization and no other", async () => {
    const own = await aClient.from("sponsors").select("id");
    expect(own.error).toBeNull();
    expect((own.data ?? []).map((r: Row) => r.id)).toEqual([a.sponsorId]);
    const other = await aClient.from("sponsors").select("id, display_name").eq("id", b.sponsorId);
    expect(other.error).toBeNull();
    expect(other.data).toEqual([]);
  });

  it("it still cannot write: no insert, no update (the note and the status stay as they were)", async () => {
    denied((await aClient.from("sponsors").update({ internal_review_note: "x" }).eq("id", a.sponsorId)).error);
    denied((await aClient.from("sponsors").update({ status: "ACTIVE", status_reason: "x" }).eq("id", a.sponsorId)).error);
    denied((await aClient.from("sponsors").insert({ display_name: "Nope" })).error);
    const after = (await admin.from("sponsors").select("internal_review_note, status_reason").eq("id", a.sponsorId).single()).data as Row;
    expect(after).toEqual({ internal_review_note: MARKER, status_reason: "Please add your website" });
  });

  it("a signed-out (anon) client reads nothing at all", async () => {
    const r = await getTestAnonClient().from("sponsors").select("id").eq("id", a.sponsorId);
    denied(r.error);
  });
});

describe("what legitimately needs `sponsors` as the signed-in user keeps working", () => {
  it("the policies that join sponsors: ACTIVE Sponsors see sponsorable inventory; a PENDING_REVIEW one does not", async () => {
    const pending = await seedSponsorAccount("colpending", "PENDING_REVIEW");
    const { fixtureId } = await seedGame({ startsInMinutes: 48 * 60 });
    const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
    const set = await admin.rpc("admin_set_sponsorship_inventory", { p_admin_id: staffId, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 40000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 60 * HOUR).toISOString() });
    expect(set.error).toBeNull();
    const inventoryId = (Array.isArray(set.data) ? set.data[0] : set.data).id as string;

    const active = await aClient.from("sponsorship_inventory").select("id, price_cents, is_sponsorable").eq("id", inventoryId);
    expect(active.error).toBeNull();
    expect(active.data).toHaveLength(1);

    const notYet = await (await signedIn(pending.email)).from("sponsorship_inventory").select("id").eq("id", inventoryId);
    expect(notYet.error).toBeNull();
    expect(notYet.data).toEqual([]);

    // sponsorships_read, and the embed the app uses (explicit columns) — through the Sponsor's own client.
    const created = await admin.rpc("sponsor_create_sponsorship", { p_user_id: a.userId, p_sponsor_id: a.sponsorId, p_inventory_id: inventoryId, p_campaign_name: "Cols" });
    expect(created.error).toBeNull();
    const sponsorshipId = (Array.isArray(created.data) ? created.data[0] : created.data).id as string;
    const mine = await aClient.from("sponsorships").select("id, campaign_name, sponsors(display_name, website)").eq("id", sponsorshipId).single<Row>();
    expect(mine.error).toBeNull();
    expect(mine.data!.campaign_name).toBe("Cols");
    expect(mine.data!.sponsors).toMatchObject({ website: "https://acme.example.com" });
    // ...while an embed that reaches the admin-only columns, or all of them, is refused.
    denied((await aClient.from("sponsorships").select("id, sponsors(internal_review_note)").eq("id", sponsorshipId)).error);
    denied((await aClient.from("sponsorships").select("id, sponsors(*)").eq("id", sponsorshipId)).error);
    // Another Sponsor still cannot see this one's sponsorship.
    expect((await (await signedIn(b.email)).from("sponsorships").select("id").eq("id", sponsorshipId)).data).toEqual([]);
  });

  it("the Sponsor's own session rows (account type, account link, terms) and membership check are unaffected", async () => {
    const type = await aClient.from("account_types").select("account_type").eq("user_id", a.userId).single<Row>();
    expect(type.error).toBeNull();
    expect(type.data!.account_type).toBe("SPONSOR");
    const link = await aClient.from("sponsor_accounts").select("sponsor_id").eq("user_id", a.userId).single<Row>();
    expect(link.error).toBeNull();
    expect(link.data!.sponsor_id).toBe(a.sponsorId);
    for (const table of ["sponsor_terms_acceptances", "sponsorship_payment_events", "sponsorship_cancellations", "sponsorship_agreement_acceptances"]) {
      const r = await aClient.from(table).select("*");
      expect(r.error, `${table}: ${r.error?.message}`).toBeNull();
    }
    expect((await aClient.rpc("is_sponsor_member", { p_sponsor_id: a.sponsorId, p_user_id: a.userId })).data).toBe(true);
    expect((await aClient.rpc("is_sponsor_member", { p_sponsor_id: b.sponsorId, p_user_id: a.userId })).data).toBe(false);
  });

  it("the application's own reads (service role) still see every column, and the Sponsor-facing record still omits the note", async () => {
    const full = (await admin.from("sponsors").select("*").eq("id", a.sponsorId).single()).data as Row;
    expect(full.internal_review_note).toBe(MARKER);
    expect(full.reviewed_by).toBe(staffId);

    const listed = (await repo.listSponsors()).find((s) => s.id === a.sponsorId);
    expect(listed?.internalReviewNote).toBe(MARKER); // the Super Admin list shows it
    const own = await repo.getSponsorForUser(a.userId); // the Sponsor portal's record
    expect(own?.displayName).toBeTruthy();
    expect(JSON.stringify(own)).not.toContain(MARKER);
    expect((await repo.listSponsorApplicationsAwaitingReview()).every((s) => !JSON.stringify(s).includes(MARKER))).toBe(true);
  });

  it("a signed-in Super Admin's OWN client is held to the same columns (admin reads of the note stay on the server)", async () => {
    const staff = await admin.auth.admin.getUserById(staffId);
    const staffClient = await signedIn(staff.data.user!.email!);
    const rows = await staffClient.from("sponsors").select(SPONSOR_READABLE.join(","));
    expect(rows.error).toBeNull();
    const seen = new Set((rows.data as unknown as Row[]).map((r) => r.id));
    expect(seen.has(a.sponsorId) && seen.has(b.sponsorId)).toBe(true); // the row policy still lets Super Admin see every Sponsor
    denied((await staffClient.from("sponsors").select("internal_review_note").eq("id", a.sponsorId)).error);
  });
});
