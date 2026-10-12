/**
 * The Review queue's canonical queries against the real database. Reviewable = Sponsor account PENDING_REVIEW, and Sponsorship lifecycle SUBMITTED with review_status PENDING
 * (lib/sponsorship/review-policy.ts). Every other status — active/rejected/suspended/disabled Sponsors; draft, changes-requested, approved, scheduled/live, suspended, cancelled,
 * completed or paid-and-approved sponsorships — is NOT review work, and the tab count equals exactly the listed items.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import { seedGame, seedSponsorAccount, seedUser } from "./helpers/game-seed";

const admin = getTestAdminClient();
const HOUR = 3_600_000;
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
  adminId = await seedUser("rqadmin");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", adminId);
  staffIds.push(adminId);
  await admin.from("platform_settings").update({ sponsorship_enabled: true }).eq("id", true); // sponsorships can only be created while the capability is on
});
afterAll(async () => {
  if (staffIds.length) await admin.from("user_profiles").update({ role: "player" }).in("id", staffIds);
  await admin.from("platform_settings").update({ sponsorship_enabled: false }).eq("id", true);
});

const ok = async (name: string, args: Record<string, unknown>) => {
  const { data, error } = await admin.rpc(name, args);
  expect(error, `${name}: ${error?.message}`).toBeNull();
  return (Array.isArray(data) ? data[0] : data) as Row;
};

async function sponsorship(label: string) {
  const sponsor = await seedSponsorAccount(label);
  const { fixtureId } = await seedGame({ startsInMinutes: 48 * 60 });
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  const inv = await ok("admin_set_sponsorship_inventory", { p_admin_id: adminId, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 40000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 60 * HOUR).toISOString() });
  const created = await ok("sponsor_create_sponsorship", { p_user_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.id, p_campaign_name: label });
  await ok("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: created.id, p_fields: { presented_by: "Acme", tagline: "x", cta_text: "More", destination_url: "https://acme.example.com" } });
  return { sponsor, id: created.id as string };
}
const submit = (s: { sponsor: { userId: string }; id: string }) => ok("sponsor_submit_sponsorship", { p_user_id: s.sponsor.userId, p_id: s.id });
const approve = async (id: string) => ok("admin_approve_sponsorship", { p_admin_id: adminId, p_id: id, p_expected_revision: (await admin.from("sponsorships").select("revision").eq("id", id).single()).data!.revision });

describe("Sponsorship requests: only SUBMITTED + PENDING review", () => {
  it("lists a submitted, un-reviewed request — paid or not — and nothing in any other state", async () => {
    const pending = await sponsorship("rqpending"); await submit(pending);
    const pendingPaid = await sponsorship("rqpaid"); await submit(pendingPaid);
    await ok("admin_mark_sponsorship_paid", { p_admin_id: adminId, p_id: pendingPaid.id, p_reference: "INV", p_note: "", p_idempotency_key: randomUUID() }); // paid but NOT approved: still review work
    const draft = await sponsorship("rqdraft");
    const approvedUnpaid = await sponsorship("rqapproved"); await submit(approvedUnpaid); await approve(approvedUnpaid.id);
    const live = await sponsorship("rqlive"); await submit(live); await ok("admin_mark_sponsorship_paid", { p_admin_id: adminId, p_id: live.id, p_reference: "INV", p_note: "", p_idempotency_key: randomUUID() }); await approve(live.id);
    const cancelled = await sponsorship("rqcancelled"); await submit(cancelled); await ok("sponsor_cancel_sponsorship", { p_user_id: cancelled.sponsor.userId, p_id: cancelled.id });
    const changes = await sponsorship("rqchanges"); await submit(changes);
    await ok("admin_request_sponsorship_changes", { p_admin_id: adminId, p_id: changes.id, p_note: "please fix" });
    const rejected = await sponsorship("rqrejected"); await submit(rejected);
    await ok("admin_reject_sponsorship", { p_admin_id: adminId, p_id: rejected.id, p_reason: "no" });

    const ids = new Set((await repo.listSponsorshipsAwaitingReview()).map((s) => s.id));
    expect(ids.has(pending.id)).toBe(true);
    expect(ids.has(pendingPaid.id)).toBe(true);
    for (const other of [draft, approvedUnpaid, live, cancelled, changes, rejected]) expect(ids.has(other.id)).toBe(false);
    // every listed row really is SUBMITTED + PENDING
    for (const s of await repo.listSponsorshipsAwaitingReview()) expect([s.lifecycle, s.reviewStatus]).toEqual(["SUBMITTED", "PENDING"]);
  });
});

describe("Sponsor applications: only PENDING_REVIEW", () => {
  it("lists pending applications and no Sponsor in any other status", async () => {
    const pending = await seedSponsorAccount("rqapp", "PENDING_REVIEW");
    const others = [] as string[];
    for (const status of ["ACTIVE", "REJECTED", "SUSPENDED", "DISABLED"] as const) others.push((await seedSponsorAccount(`rq${status.toLowerCase()}`, status)).sponsorId);
    const ids = new Set((await repo.listSponsorApplicationsAwaitingReview()).map((s) => s.id));
    expect(ids.has(pending.sponsorId)).toBe(true);
    for (const o of others) expect(ids.has(o)).toBe(false);
    for (const s of await repo.listSponsorApplicationsAwaitingReview()) expect(s.status).toBe("PENDING_REVIEW");
  });
});

describe("the tab count is exactly the reviewable objects", () => {
  it("count = applications + requests, and equals the lengths of the two lists", async () => {
    const before = await repo.countReviewItems();
    const s = await sponsorship("rqcount"); await submit(s);
    await seedSponsorAccount("rqcountapp", "PENDING_REVIEW");
    const after = await repo.countReviewItems();
    expect(after.sponsorships).toBe(before.sponsorships + 1);
    expect(after.sponsorApplications).toBe(before.sponsorApplications + 1);
    expect(after.total).toBe(after.sponsorships + after.sponsorApplications);
    expect((await repo.listSponsorshipsAwaitingReview(1000)).length).toBe(after.sponsorships);
    expect((await repo.listSponsorApplicationsAwaitingReview(1000)).length).toBe(after.sponsorApplications);
  });

  it("reviewing an item removes it from the queue and from the count", async () => {
    const s = await sponsorship("rqdecide"); await submit(s);
    const withIt = await repo.countReviewItems();
    await approve(s.id);
    const without = await repo.countReviewItems();
    expect(without.sponsorships).toBe(withIt.sponsorships - 1);
    expect((await repo.listSponsorshipsAwaitingReview(1000)).some((x) => x.id === s.id)).toBe(false);
  });
});
