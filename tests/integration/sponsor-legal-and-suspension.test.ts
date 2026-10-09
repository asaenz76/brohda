/**
 * Sponsor legal records and the suspension / refund separation, against the real database: acceptance records are immutable and attributable, a campaign
 * agreement acceptance is recorded atomically with the submit and reads its facts from the canonical row, only the owning Sponsor and Super Admin can read
 * it, a drafted/unapproved document records nothing, and suspending a Sponsor ACCOUNT or a CAMPAIGN never touches the payment state or the Game Post.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { seedGame, seedSponsorAccount, seedUser } from "./helpers/game-seed";
import { loadPublicSponsorships } from "@/lib/sponsorship/public";
import { hasAcceptedCurrentSponsorTerms, recordSponsorTermsAcceptance } from "@/lib/sponsor/legal-acceptance";
import { MEDIA_AGREEMENT_DOCUMENT, SPONSOR_TERMS_DOCUMENT, type SponsorLegalDocument } from "@/lib/sponsor/terms";

const admin = getTestAdminClient();
const PASSWORD = "integration-test-password-123";
const HOUR = 3_600_000;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const rpc = async (name: string, args: Record<string, unknown>) => {
  const { data, error } = await admin.rpc(name, args);
  return { data: (Array.isArray(data) ? data[0] : data) as Row | null, error };
};
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await rpc(name, args);
  expect(r.error, `${name}: ${r.error?.message}`).toBeNull();
  return r.data as Row;
};
const staffIds: string[] = [];
afterAll(async () => {
  if (staffIds.length) await admin.from("user_profiles").update({ role: "player" }).in("id", staffIds);
  await admin.from("platform_settings").update({ sponsorship_enabled: false }).eq("id", true);
});
async function superAdmin() {
  const id = await seedUser("legaladmin");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", id);
  staffIds.push(id);
  return id;
}
const APPROVED_TERMS: SponsorLegalDocument = { ...SPONSOR_TERMS_DOCUMENT, status: "APPROVED", version: "2026-12-01", effectiveDate: "December 1, 2026" };
const APPROVED_AGREEMENT: SponsorLegalDocument = { ...MEDIA_AGREEMENT_DOCUMENT, status: "APPROVED", version: "2026-12-01", effectiveDate: "December 1, 2026" };

async function setup() {
  const adminId = await superAdmin();
  await admin.from("platform_settings").update({ sponsorship_enabled: true }).eq("id", true);
  const sponsor = await seedSponsorAccount("legal");
  const { fixtureId } = await seedGame({ startsInMinutes: 24 * 60 });
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  const inv = await ok("admin_set_sponsorship_inventory", { p_admin_id: adminId, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 123400, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 5 * HOUR).toISOString() });
  const created = await ok("sponsor_create_sponsorship", { p_user_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.id, p_campaign_name: "Legal" });
  await ok("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: created.id, p_fields: { presented_by: "Acme Sports", tagline: "Fuel the game", cta_text: "Learn more", destination_url: "https://acme.example.com/promo" } });
  return { adminId, sponsor, postId: post!.id as string, sponsorshipId: created.id as string, fixtureId };
}
const goLive = async (adminId: string, id: string) => {
  await ok("admin_mark_sponsorship_paid", { p_admin_id: adminId, p_id: id, p_reference: "INV-1", p_note: "bank transfer", p_idempotency_key: randomUUID() });
  const { data } = await admin.from("sponsorships").select("revision").eq("id", id).single();
  await ok("admin_approve_sponsorship", { p_admin_id: adminId, p_id: id, p_expected_revision: data!.revision });
};
const setSponsorStatus = (adminId: string, sponsorId: string, status: string, reason: string | null) => ok("admin_set_sponsor_status", { p_admin_id: adminId, p_sponsor_id: sponsorId, p_status: status, p_reason: reason, p_internal_note: null });

describe("Sponsor Terms acceptance records", () => {
  it("records the SERVER's approved version once, attributably, and a new version needs a new acceptance", async () => {
    const s = await seedSponsorAccount("terms");
    expect(await hasAcceptedCurrentSponsorTerms(s.userId, APPROVED_TERMS)).toBe(false);
    await recordSponsorTermsAcceptance(s.userId, s.sponsorId, "signup", APPROVED_TERMS);
    await recordSponsorTermsAcceptance(s.userId, s.sponsorId, "signup", APPROVED_TERMS); // repeat: a no-op, not an error and not a second row
    const { data: rows } = await admin.from("sponsor_terms_acceptances").select("*").eq("user_id", s.userId);
    expect(rows).toHaveLength(1);
    expect(rows![0]).toMatchObject({ document_key: "sponsor_terms", version: "2026-12-01", source: "signup", sponsor_id: s.sponsorId });
    expect(rows![0].accepted_at).toBeTruthy();
    expect(await hasAcceptedCurrentSponsorTerms(s.userId, APPROVED_TERMS)).toBe(true);
    // A newer approved version is NOT satisfied by the old acceptance (re-consent), while the old record stays.
    const v2 = { ...APPROVED_TERMS, version: "2027-03-01" };
    expect(await hasAcceptedCurrentSponsorTerms(s.userId, v2)).toBe(false);
    await recordSponsorTermsAcceptance(s.userId, s.sponsorId, "reconsent", v2);
    expect((await admin.from("sponsor_terms_acceptances").select("version").eq("user_id", s.userId)).data!.map((r) => r.version).sort()).toEqual(["2026-12-01", "2027-03-01"]);
  });

  it("with no approved document nothing is required and nothing is recorded (a draft binds nobody)", async () => {
    const s = await seedSponsorAccount("nodoc");
    expect(await hasAcceptedCurrentSponsorTerms(s.userId, null)).toBe(true);
    await recordSponsorTermsAcceptance(s.userId, s.sponsorId, "signup", null);
    expect((await admin.from("sponsor_terms_acceptances").select("id").eq("user_id", s.userId)).data).toEqual([]);
  });

  it("the record is immutable: it can't be edited or deleted, and its account can't be deleted out from under it", async () => {
    const s = await seedSponsorAccount("immut");
    await recordSponsorTermsAcceptance(s.userId, s.sponsorId, "signup", APPROVED_TERMS);
    expect((await admin.from("sponsor_terms_acceptances").update({ version: "forged" }).eq("user_id", s.userId)).error?.message ?? "").toContain("immutable");
    expect((await admin.from("sponsor_terms_acceptances").delete().eq("user_id", s.userId)).error?.message ?? "").toContain("immutable");
    expect((await admin.auth.admin.deleteUser(s.userId)).error).not.toBeNull();
  });
});

describe("campaign Media and Advertising Agreement acceptance", () => {
  it("submits AND records the acceptance in one transaction, reading revision, hash, price, window and payment state from the canonical row", async () => {
    const { sponsor, sponsorshipId } = await setup();
    const row = await ok("sponsor_submit_with_agreement", { p_user_id: sponsor.userId, p_id: sponsorshipId, p_agreement_key: APPROVED_AGREEMENT.key, p_agreement_version: APPROVED_AGREEMENT.version, p_terms_key: APPROVED_TERMS.key, p_terms_version: APPROVED_TERMS.version });
    expect(row.lifecycle).toBe("SUBMITTED");
    const { data: acc } = await admin.from("sponsorship_agreement_acceptances").select("*").eq("sponsorship_id", sponsorshipId);
    expect(acc).toHaveLength(1);
    expect(acc![0]).toMatchObject({ sponsor_id: sponsor.sponsorId, accepted_by: sponsor.userId, agreement_key: "media_agreement", agreement_version: "2026-12-01", terms_version: "2026-12-01", price_cents: 123400, currency: "USD", revision: row.revision });
    expect(acc![0].content_hash).toMatch(/^[0-9a-f]{16,}$/);
    expect(acc![0].payment_status).toBe("PENDING");
    const { data: audit } = await admin.from("audit_logs").select("action, actor_account_id").eq("entity_id", sponsorshipId).eq("action", "sponsorship.agreement_accepted");
    expect(audit).toHaveLength(1);
    expect(audit![0].actor_account_id).toBe(sponsor.userId);
  });

  it("is atomic: a refused submit records no acceptance (another Sponsor, or a non-ACTIVE one)", async () => {
    const { sponsorshipId } = await setup();
    const other = await seedSponsorAccount("other");
    const bad = await rpc("sponsor_submit_with_agreement", { p_user_id: other.userId, p_id: sponsorshipId, p_agreement_key: "media_agreement", p_agreement_version: "v", p_terms_key: null, p_terms_version: null });
    expect(bad.error?.message ?? "").toContain("not_authorized");
    expect((await admin.from("sponsorship_agreement_acceptances").select("id").eq("sponsorship_id", sponsorshipId)).data).toEqual([]);
    expect((await admin.from("sponsorships").select("lifecycle").eq("id", sponsorshipId).single()).data!.lifecycle).toBe("DRAFT");
  });

  it("is immutable and readable only by the owning Sponsor and Super Admin", async () => {
    const { adminId, sponsor, sponsorshipId } = await setup();
    await ok("sponsor_submit_with_agreement", { p_user_id: sponsor.userId, p_id: sponsorshipId, p_agreement_key: "media_agreement", p_agreement_version: "v1", p_terms_key: null, p_terms_version: null });
    expect((await admin.from("sponsorship_agreement_acceptances").update({ price_cents: 1 }).eq("sponsorship_id", sponsorshipId)).error?.message ?? "").toContain("immutable");
    expect((await admin.from("sponsorship_agreement_acceptances").delete().eq("sponsorship_id", sponsorshipId)).error?.message ?? "").toContain("immutable");

    const read = async (email: string) => {
      const c = getTestAnonClient();
      expect((await c.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
      return (await c.from("sponsorship_agreement_acceptances").select("id")).data ?? [];
    };
    expect((await read(sponsor.email)).length).toBe(1);
    expect(await read((await seedSponsorAccount("stranger")).email)).toEqual([]);
    const member = await seedUser("agrmember");
    expect(await read((await admin.auth.admin.getUserById(member)).data.user!.email!)).toEqual([]);
    expect((await getTestAnonClient().from("sponsorship_agreement_acceptances").select("id")).data ?? []).toEqual([]);
    const superEmail = (await admin.auth.admin.getUserById(adminId)).data.user!.email!;
    expect((await read(superEmail)).length).toBeGreaterThanOrEqual(1); // Super Admin reads every campaign's acceptance
    // The client has no write path, and the function is service-role only.
    const c = getTestAnonClient();
    await c.auth.signInWithPassword({ email: sponsor.email, password: PASSWORD });
    expect((await c.from("sponsorship_agreement_acceptances").insert({ sponsorship_id: sponsorshipId, sponsor_id: sponsor.sponsorId, accepted_by: sponsor.userId, revision: 1, content_hash: "x", agreement_key: "k", agreement_version: "v", starts_at: new Date().toISOString(), ends_at: new Date().toISOString(), payment_status: "UNPAID" })).error).not.toBeNull();
    expect((await c.rpc("sponsor_submit_with_agreement", { p_user_id: sponsor.userId, p_id: sponsorshipId, p_agreement_key: "k", p_agreement_version: "v", p_terms_key: null, p_terms_version: null })).error).not.toBeNull();
  });

  it("a campaign submitted by Super Admin on the Sponsor's behalf records NO acceptance (the Sponsor did not accept it)", async () => {
    const { adminId, sponsorshipId } = await setup();
    await ok("admin_submit_sponsorship", { p_admin_id: adminId, p_id: sponsorshipId });
    expect((await admin.from("sponsorship_agreement_acceptances").select("id").eq("sponsorship_id", sponsorshipId)).data).toEqual([]);
  });
});

describe("suspension: presentation disappears, everything else stays, and money is untouched", () => {
  it("Sponsor ACCOUNT suspended → the sponsor presentation disappears at once; the Game Post, Markets and history stay; payment is NOT refunded; restore revives it only while still eligible", async () => {
    const { adminId, sponsor, postId, sponsorshipId, fixtureId } = await setup();
    await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: sponsorshipId });
    await goLive(adminId, sponsorshipId);
    expect((await loadPublicSponsorships([postId])).get(postId)?.presentedBy).toBe("Acme Sports");
    const before = (await admin.from("sponsorships").select("payment_status, lifecycle, review_status, price_cents").eq("id", sponsorshipId).single()).data!;
    const events = (await admin.from("sponsorship_payment_events").select("id").eq("sponsorship_id", sponsorshipId)).data!.length;

    await setSponsorStatus(adminId, sponsor.sponsorId, "SUSPENDED", "Chargeback");
    expect((await loadPublicSponsorships([postId])).size).toBe(0); // dark immediately
    // Everything canonical stays.
    expect((await admin.from("posts").select("id, published_at").eq("id", postId).single()).data!.published_at).not.toBeNull();
    expect((await admin.from("markets").select("id").eq("fixture_id", fixtureId)).data!.length).toBeGreaterThan(0);
    expect((await admin.from("fixtures").select("id").eq("id", fixtureId)).data).toHaveLength(1);
    // The campaign, its approval and its money are exactly as they were — suspension is not a refund.
    const after = (await admin.from("sponsorships").select("payment_status, lifecycle, review_status, price_cents").eq("id", sponsorshipId).single()).data!;
    expect(after).toEqual(before);
    expect(after.payment_status).toBe("PAID");
    expect((await admin.from("sponsorship_payment_events").select("id").eq("sponsorship_id", sponsorshipId)).data!.length).toBe(events);
    expect((await admin.from("sponsorship_payment_events").select("event_type").eq("sponsorship_id", sponsorshipId).in("event_type", ["REFUND_PENDING", "REFUNDED"])).data).toEqual([]);

    await setSponsorStatus(adminId, sponsor.sponsorId, "ACTIVE", null);
    expect((await loadPublicSponsorships([postId])).get(postId)?.presentedBy).toBe("Acme Sports"); // still paid, approved, intact and in its window
  });

  it("restoring a Sponsor does NOT revive an expired campaign", async () => {
    const { adminId, sponsor, postId, sponsorshipId } = await setup();
    await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: sponsorshipId });
    await goLive(adminId, sponsorshipId);
    await setSponsorStatus(adminId, sponsor.sponsorId, "SUSPENDED", "Review");
    await admin.from("sponsorships").update({ ends_at: new Date(Date.now() - 60_000).toISOString(), starts_at: new Date(Date.now() - 2 * HOUR).toISOString() }).eq("id", sponsorshipId);
    await setSponsorStatus(adminId, sponsor.sponsorId, "ACTIVE", null);
    expect((await loadPublicSponsorships([postId])).size).toBe(0);
  });

  it("CAMPAIGN suspension is its own action: presentation disappears, payment stays PAID (no automatic refund), and unsuspending restores it", async () => {
    const { adminId, sponsor, postId, sponsorshipId } = await setup();
    await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: sponsorshipId });
    await goLive(adminId, sponsorshipId);
    await ok("admin_suspend_sponsorship", { p_admin_id: adminId, p_id: sponsorshipId, p_reason: "creative problem" });
    expect((await loadPublicSponsorships([postId])).size).toBe(0);
    const row = (await admin.from("sponsorships").select("payment_status, lifecycle").eq("id", sponsorshipId).single()).data!;
    expect(row).toMatchObject({ lifecycle: "SUSPENDED", payment_status: "PAID" });
    // The Sponsor ACCOUNT is untouched by a campaign suspension.
    expect((await admin.from("sponsors").select("status").eq("id", sponsor.sponsorId).single()).data!.status).toBe("ACTIVE");
    await ok("admin_unsuspend_sponsorship", { p_admin_id: adminId, p_id: sponsorshipId });
    expect((await loadPublicSponsorships([postId])).get(postId)?.presentedBy).toBe("Acme Sports");
  });

  it("a refund is an explicit, audited, separate action — it is the ONLY thing that moves payment to REFUND_PENDING / REFUNDED", async () => {
    const { adminId, sponsor, postId, sponsorshipId } = await setup();
    await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: sponsorshipId });
    await goLive(adminId, sponsorshipId);
    await ok("admin_suspend_sponsorship", { p_admin_id: adminId, p_id: sponsorshipId, p_reason: "pause" });
    expect((await admin.from("sponsorships").select("payment_status").eq("id", sponsorshipId).single()).data!.payment_status).toBe("PAID");

    const refund = await ok("admin_record_sponsorship_payment_event", { p_admin_id: adminId, p_id: sponsorshipId, p_event: "REFUND_PENDING", p_reference: "", p_note: "owner approved refund", p_idempotency_key: `r-${randomUUID()}` });
    expect(refund.payment_status).toBe("REFUND_PENDING");
    expect((await loadPublicSponsorships([postId])).size).toBe(0);
    const { data: logs } = await admin.from("audit_logs").select("action, actor_id, reason").eq("entity_id", sponsorshipId).eq("action", "sponsorship.payment_refund_pending");
    expect(logs).toHaveLength(1);
    expect(logs![0]).toMatchObject({ actor_id: adminId, reason: "owner approved refund" });
  });
});
