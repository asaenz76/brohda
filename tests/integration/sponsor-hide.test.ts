/**
 * Sponsor hide / unhide (r72): ADMIN LIST VISIBILITY, separate from account status, against the real database. Proved: hidden Sponsors are absent from the default list and present under
 * Hidden / All; hiding and unhiding change nothing about status, login, sponsorships, payments, acceptances, audit history or public campaigns; pending review work still surfaces; only
 * Super Admin (through the server) can hide or unhide, and a Sponsor's own login can neither call the function nor read the visibility table; every change is audited once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient, getTestSupabaseConfig } from "./helpers/test-env";
import { seedGame, seedSponsorAccount, seedUser } from "./helpers/game-seed";
import { loadPublicSponsorships } from "@/lib/sponsorship/public";
import { parseSponsorVisibility } from "@/lib/sponsorship/sponsor-visibility";

const admin = getTestAdminClient();
const HOUR = 3_600_000;
const PASSWORD = "integration-test-password-123";
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let repo: typeof import("@/lib/sponsorship/repository");
let adminId = "";
const staffIds: string[] = [];

beforeAll(async () => {
  const cfg = getTestSupabaseConfig();
  process.env.NEXT_PUBLIC_SUPABASE_URL = cfg.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = cfg.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = cfg.serviceRoleKey;
  repo = await import("@/lib/sponsorship/repository");
  adminId = await seedUser("hideadmin");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", adminId);
  staffIds.push(adminId);
  await admin.from("platform_settings").update({ sponsorship_enabled: true }).eq("id", true);
});
afterAll(async () => {
  if (staffIds.length) await admin.from("user_profiles").update({ role: "player" }).in("id", staffIds);
  await admin.from("platform_settings").update({ sponsorship_enabled: false }).eq("id", true);
});

const rpc = async (name: string, args: Record<string, unknown>) => {
  const { data, error } = await admin.rpc(name, args);
  return { data: (Array.isArray(data) ? data[0] : data) as Row | null, error };
};
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await rpc(name, args);
  expect(r.error, `${name}: ${r.error?.message}`).toBeNull();
  return r.data as Row;
};
const setHidden = (sponsorId: string, hidden: boolean, actor = adminId) => rpc("admin_set_sponsor_hidden", { p_admin_id: actor, p_sponsor_id: sponsorId, p_hidden: hidden });
const sponsorRow = async (id: string) => (await admin.from("sponsors").select("*").eq("id", id).single()).data as Row;
const ids = async (visibility: "visible" | "hidden" | "all") => new Set((await repo.listSponsors({ visibility })).map((s) => s.id));
const audits = async (id: string) => (await admin.from("audit_logs").select("action, actor_id, before, after").eq("entity_type", "sponsor").eq("entity_id", id).in("action", ["sponsor.hidden", "sponsor.unhidden"]).order("created_at")).data!;

/** An ACTIVE Sponsor with a paid, approved, in-window sponsorship (so its campaign is public). */
async function liveCampaign() {
  const sponsor = await seedSponsorAccount("hidelive");
  const { fixtureId } = await seedGame({ startsInMinutes: 48 * 60 });
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  const inv = await ok("admin_set_sponsorship_inventory", { p_admin_id: adminId, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 40000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 60 * HOUR).toISOString() });
  const created = await ok("sponsor_create_sponsorship", { p_user_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.id, p_campaign_name: "Hide" });
  await ok("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: created.id, p_fields: { presented_by: "Acme", tagline: "x", cta_text: "More", destination_url: "https://acme.example.com" } });
  await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: created.id });
  await ok("admin_mark_sponsorship_paid", { p_admin_id: adminId, p_id: created.id, p_reference: "INV", p_note: "", p_idempotency_key: randomUUID() });
  const rev = (await admin.from("sponsorships").select("revision").eq("id", created.id).single()).data!.revision;
  await ok("admin_approve_sponsorship", { p_admin_id: adminId, p_id: created.id, p_expected_revision: rev });
  return { sponsor, sponsorshipId: created.id as string, postId: post!.id as string };
}

describe("the default list excludes hidden Sponsors; Hidden and All bring them back", () => {
  it("visible → listed; hidden → absent by default, present under Hidden and All; unhide → back in the default list", async () => {
    const a = await seedSponsorAccount("hidea");
    const b = await seedSponsorAccount("hideb");
    expect((await ids("visible")).has(a.sponsorId)).toBe(true);
    await setHidden(a.sponsorId, true);
    const [visible, hidden, all] = [await ids("visible"), await ids("hidden"), await ids("all")];
    expect(visible.has(a.sponsorId)).toBe(false);
    expect(visible.has(b.sponsorId)).toBe(true);
    expect(hidden.has(a.sponsorId)).toBe(true);
    expect(hidden.has(b.sponsorId)).toBe(false);
    expect(all.has(a.sponsorId) && all.has(b.sponsorId)).toBe(true);
    expect((await repo.listSponsors({ visibility: "hidden" })).find((s) => s.id === a.sponsorId)?.hiddenAt).toBeTruthy();
    expect((await repo.listSponsors()).some((s) => s.id === a.sponsorId)).toBe(false); // the default is visible-only
    await setHidden(a.sponsorId, false);
    expect((await ids("visible")).has(a.sponsorId)).toBe(true);
    expect((await ids("hidden")).has(a.sponsorId)).toBe(false);
  });

  it("every existing Sponsor defaults to visible; the URL parameter can never reveal more than the control offers", () => {
    expect(parseSponsorVisibility(undefined)).toBe("visible");
    expect(parseSponsorVisibility("hidden")).toBe("hidden");
    expect(parseSponsorVisibility("all")).toBe("all");
    for (const odd of ["", "everything", "ALL", "1", "visible;drop", ["junk"]] as Array<string | string[]>) expect(parseSponsorVisibility(odd)).toBe("visible");
  });
});

describe("hiding is visibility only — status, login and the Sponsor row are untouched", () => {
  it.each(["ACTIVE", "DISABLED", "SUSPENDED", "REJECTED", "PENDING_REVIEW"] as const)("a %s Sponsor keeps its status, reason and every column when hidden and when unhidden", async (status) => {
    const s = await seedSponsorAccount(`hide${status.toLowerCase()}`, status);
    const before = await sponsorRow(s.sponsorId);
    await setHidden(s.sponsorId, true);
    expect(await sponsorRow(s.sponsorId)).toEqual(before); // the sponsors row is not even written
    await setHidden(s.sponsorId, false);
    expect(await sponsorRow(s.sponsorId)).toEqual(before);
    expect(before.status).toBe(status);
  });

  it("a hidden ACTIVE Sponsor can still operate (its login/account row is untouched), and a hidden DISABLED Sponsor stays disabled because of its status — not because it is hidden", async () => {
    const active = await seedSponsorAccount("hideopactive", "ACTIVE");
    await setHidden(active.sponsorId, true);
    const { fixtureId } = await seedGame({ startsInMinutes: 48 * 60 });
    const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
    const inv = await ok("admin_set_sponsorship_inventory", { p_admin_id: adminId, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 100, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 60 * HOUR).toISOString() });
    expect((await rpc("sponsor_create_sponsorship", { p_user_id: active.userId, p_sponsor_id: active.sponsorId, p_inventory_id: inv.id, p_campaign_name: "still works" })).error).toBeNull();
    expect((await admin.from("sponsor_accounts").select("user_id").eq("sponsor_id", active.sponsorId).single()).data!.user_id).toBe(active.userId);

    const disabled = await seedSponsorAccount("hideopdisabled", "DISABLED");
    await setHidden(disabled.sponsorId, true);
    expect((await rpc("sponsor_create_sponsorship", { p_user_id: disabled.userId, p_sponsor_id: disabled.sponsorId, p_inventory_id: inv.id, p_campaign_name: "must fail" })).error).not.toBeNull();
    await setHidden(disabled.sponsorId, false);
    expect((await sponsorRow(disabled.sponsorId)).status).toBe("DISABLED"); // unhiding doesn't re-enable it
  });
});

describe("history is preserved and public campaign behaviour is unchanged", () => {
  it("sponsorships, payment events, acceptances, audit history and exposure events are exactly as they were after hide AND after unhide", async () => {
    const c = await liveCampaign();
    await admin.from("sponsor_terms_acceptances").insert({ user_id: c.sponsor.userId, sponsor_id: c.sponsor.sponsorId, document_key: "sponsor_terms", version: "t-1", source: "signup" });
    await admin.from("sponsorship_exposure_events").insert({ sponsorship_id: c.sponsorshipId, post_id: c.postId, event_type: "CLICK", user_id: null });
    const snapshot = async () => ({
      sponsorships: (await admin.from("sponsorships").select("id, lifecycle, payment_status, review_status, revision").eq("sponsor_id", c.sponsor.sponsorId)).data,
      payments: (await admin.from("sponsorship_payment_events").select("event_type, amount_cents").eq("sponsorship_id", c.sponsorshipId).order("created_at")).data,
      terms: (await admin.from("sponsor_terms_acceptances").select("version").eq("sponsor_id", c.sponsor.sponsorId)).data,
      exposure: (await admin.from("sponsorship_exposure_events").select("event_type").eq("sponsorship_id", c.sponsorshipId)).data,
      account: (await admin.from("sponsor_accounts").select("user_id").eq("sponsor_id", c.sponsor.sponsorId)).data,
      auditNonVisibility: ((await admin.from("audit_logs").select("action").eq("entity_id", c.sponsorshipId)).data ?? []).map((r) => r.action),
    });
    const before = await snapshot();
    await setHidden(c.sponsor.sponsorId, true);
    expect(await snapshot()).toEqual(before);
    await setHidden(c.sponsor.sponsorId, false);
    expect(await snapshot()).toEqual(before);
  });

  it("a hidden ACTIVE Sponsor's campaign stays public — hidden-ness is not an eligibility input", async () => {
    const c = await liveCampaign();
    expect((await loadPublicSponsorships([c.postId])).get(c.postId)?.presentedBy).toBe("Acme");
    await setHidden(c.sponsor.sponsorId, true);
    expect((await loadPublicSponsorships([c.postId])).get(c.postId)?.presentedBy).toBe("Acme");
    await setHidden(c.sponsor.sponsorId, false);
    expect((await loadPublicSponsorships([c.postId])).get(c.postId)?.presentedBy).toBe("Acme");
  });
});

describe("hiding can't bury review work", () => {
  it("a hidden Sponsor application that is genuinely pending still surfaces in the Review queue (marked hidden) and in the count", async () => {
    const pending = await seedSponsorAccount("hidepending", "PENDING_REVIEW");
    const before = await repo.countReviewItems();
    await setHidden(pending.sponsorId, true);
    expect((await repo.countReviewItems()).sponsorApplications).toBe(before.sponsorApplications);
    const queued = (await repo.listSponsorApplicationsAwaitingReview(1000)).find((s) => s.id === pending.sponsorId);
    expect(queued).toBeTruthy();
    expect(queued!.hiddenAt).toBeTruthy();
    expect((await ids("visible")).has(pending.sponsorId)).toBe(false); // absent from the default Sponsors list, but still reviewable via the queue
  });

  it("hiding itself never creates a review item", async () => {
    const active = await seedSponsorAccount("hidenoreview", "ACTIVE");
    const before = await repo.countReviewItems();
    await setHidden(active.sponsorId, true);
    expect(await repo.countReviewItems()).toEqual(before);
  });
});

describe("audit: who, which Sponsor, when — once per real change", () => {
  it("hide and unhide are each audited with the actor and the Sponsor id; a repeat changes and audits nothing", async () => {
    const s = await seedSponsorAccount("hideaudit");
    await setHidden(s.sponsorId, true);
    await setHidden(s.sponsorId, true); // idempotent
    await setHidden(s.sponsorId, false);
    await setHidden(s.sponsorId, false); // idempotent
    const log = await audits(s.sponsorId);
    expect(log.map((l) => l.action)).toEqual(["sponsor.hidden", "sponsor.unhidden"]);
    expect(log.every((l) => l.actor_id === adminId && l.before === null && l.after === null)).toBe(true); // no duplicate Sponsor data stored
  });

  it("an unknown Sponsor is refused", async () => {
    expect((await setHidden(randomUUID(), true)).error?.message).toMatch(/sponsor_not_found/);
  });
});

describe("authorization: only Super Admin, only through the server", () => {
  it("an ordinary admin, a Sponsor user and a Member are refused by the database function — and nothing changes", async () => {
    const target = await seedSponsorAccount("hideauth");
    const ordinaryAdmin = await seedUser("hideordadmin");
    await admin.from("user_profiles").update({ role: "admin" }).eq("id", ordinaryAdmin);
    staffIds.push(ordinaryAdmin);
    const member = await seedUser("hidemember");
    for (const actor of [ordinaryAdmin, target.userId, member]) expect((await setHidden(target.sponsorId, true, actor)).error, actor).not.toBeNull();
    expect((await ids("hidden")).has(target.sponsorId)).toBe(false);
    expect(await audits(target.sponsorId)).toEqual([]);
  });

  it("a Sponsor's own signed-in client can neither call the function nor read the visibility table (it is an admin-only flag)", async () => {
    const target = await seedSponsorAccount("hideownlogin");
    await setHidden(target.sponsorId, true);
    const client = getTestAnonClient();
    const signIn = await client.auth.signInWithPassword({ email: target.email, password: PASSWORD });
    expect(signIn.error).toBeNull();
    const call = await client.rpc("admin_set_sponsor_hidden", { p_admin_id: adminId, p_sponsor_id: target.sponsorId, p_hidden: false });
    expect(call.error).not.toBeNull();
    const read = await client.from("sponsor_admin_hidden").select("sponsor_id");
    expect(read.error !== null || (read.data ?? []).length === 0).toBe(true);
    const ownRow = await client.from("sponsors").select("*").eq("id", target.sponsorId).maybeSingle();
    expect(JSON.stringify(ownRow.data ?? {})).not.toMatch(/hidden/i); // the Sponsor's own row says nothing about it
    expect((await ids("hidden")).has(target.sponsorId)).toBe(true); // still hidden: the Sponsor's attempt changed nothing
    const anon = await getTestAnonClient().rpc("admin_set_sponsor_hidden", { p_admin_id: adminId, p_sponsor_id: target.sponsorId, p_hidden: false });
    expect(anon.error).not.toBeNull();
  });
});
