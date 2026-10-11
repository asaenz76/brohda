/**
 * The commercial legal gate, the campaign-agreement acceptance and the frozen refund policy — against the real database and the real payment service, with the Sponsor legal
 * documents stood in as APPROVED (the real registry correctly keeps them DRAFT until counsel approves wording). A fake payment provider proves the gate is provider-neutral.
 * Proved: a new online payment waits for BOTH the Sponsor Terms and the campaign agreement (separately from the provider switch); acceptances are server-resolved, per exact
 * revision and immutable; a new Terms version re-requires acceptance while history stays; manual payment can't silently bypass a required agreement; and changing the refund
 * cutoff setting never re-decides an existing Sponsorship.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import { seedGame, seedSponsorAccount, seedUser } from "./helpers/game-seed";
import { FakeProvider } from "../helpers/fake-provider";
import { clearTestAdapters, registerTestAdapter } from "@/lib/payments/registry";
import type { SponsorLegalDocument } from "@/lib/sponsor/terms";

const held = vi.hoisted(() => ({ adminId: "" }));
const TERMS_V1: SponsorLegalDocument = { key: "sponsor_terms", title: "Sponsor Terms", version: "1.0", effectiveDate: "January 1, 2027", status: "APPROVED", href: "/sponsor/terms", refundCutoffHours: 12 };
const AGREEMENT_V1: SponsorLegalDocument = { key: "media_agreement", title: "Media and Advertising Agreement", version: "1.0", effectiveDate: "January 1, 2027", status: "APPROVED", href: "/sponsor/terms#media-agreement" };
vi.mock("@/lib/sponsor/terms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sponsor/terms")>()),
  CURRENT_SPONSOR_TERMS: { key: "sponsor_terms", title: "Sponsor Terms", version: "1.0", effectiveDate: "January 1, 2027", status: "APPROVED", href: "/sponsor/terms", refundCutoffHours: 12 },
  CURRENT_MEDIA_AGREEMENT: { key: "media_agreement", title: "Media and Advertising Agreement", version: "1.0", effectiveDate: "January 1, 2027", status: "APPROVED", href: "/sponsor/terms#media-agreement" },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth/session")>()), requireSuperAdmin: async () => ({ id: held.adminId }) }));

const admin = getTestAdminClient();
const HOUR = 3_600_000;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let service: typeof import("@/lib/payments/service");
let gate: typeof import("@/lib/sponsor/commercial-legal-gate");
let acceptance: typeof import("@/lib/sponsor/legal-acceptance");
let adminActions: typeof import("@/lib/actions/admin-sponsorship");
let fake: FakeProvider;
const staffIds: string[] = [];

beforeAll(async () => {
  const cfg = getTestSupabaseConfig();
  process.env.NEXT_PUBLIC_SUPABASE_URL = cfg.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = cfg.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = cfg.serviceRoleKey;
  service = await import("@/lib/payments/service");
  gate = await import("@/lib/sponsor/commercial-legal-gate");
  acceptance = await import("@/lib/sponsor/legal-acceptance");
  adminActions = await import("@/lib/actions/admin-sponsorship");
});
beforeEach(async () => {
  fake = new FakeProvider();
  clearTestAdapters();
  registerTestAdapter(fake);
  await admin.from("platform_settings").update({ sponsorship_enabled: true, sponsorship_refund_cutoff_hours: 12, sponsorship_online_payments_enabled: true, sponsorship_online_payment_provider: "TEST_PROVIDER" }).eq("id", true);
});
afterAll(async () => {
  clearTestAdapters();
  if (staffIds.length) await admin.from("user_profiles").update({ role: "player" }).in("id", staffIds);
  await admin.from("platform_settings").update({ sponsorship_enabled: false, sponsorship_refund_cutoff_hours: 12, sponsorship_online_payments_enabled: false, sponsorship_online_payment_provider: null }).eq("id", true);
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
async function superAdmin() {
  if (held.adminId) return held.adminId;
  held.adminId = await seedUser("legaladmin");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", held.adminId);
  staffIds.push(held.adminId);
  return held.adminId;
}

/** A SUBMITTED sponsorship (payment PENDING) of an ACTIVE Sponsor, optionally with the agreement accepted at submit. */
async function campaign(opts: { submit?: boolean; startsInHours?: number } = {}) {
  const adminId = await superAdmin();
  const sponsor = await seedSponsorAccount("legal");
  const { fixtureId } = await seedGame({ startsInMinutes: (opts.startsInHours ?? 48) * 60 });
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  const inv = await ok("admin_set_sponsorship_inventory", { p_admin_id: adminId, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 70000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 60 * HOUR).toISOString() });
  const created = await ok("sponsor_create_sponsorship", { p_user_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.id, p_campaign_name: "Legal" });
  await ok("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: created.id, p_fields: { presented_by: "Acme Sports", tagline: "Fuel the game", cta_text: "Learn more", destination_url: "https://acme.example.com/promo" } });
  if (opts.submit !== false) await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: created.id });
  return { adminId, sponsor, sponsorshipId: created.id as string, fixtureId };
}
const acceptTerms = (c: { sponsor: { userId: string; sponsorId: string } }, doc: SponsorLegalDocument = TERMS_V1) => acceptance.recordSponsorTermsAcceptance(c.sponsor.userId, c.sponsor.sponsorId, "signup", doc);
const acceptAgreement = (c: { sponsor: { userId: string }; sponsorshipId: string }, userId = c.sponsor.userId) => rpc("sponsor_accept_agreement", { p_user_id: userId, p_id: c.sponsorshipId, p_agreement_key: AGREEMENT_V1.key, p_agreement_version: AGREEMENT_V1.version, p_terms_key: TERMS_V1.key, p_terms_version: TERMS_V1.version });
const urls = { successUrl: "https://app.test/return?result=success", cancelUrl: "https://app.test/return?result=cancel" };
const pay = (c: { sponsor: { userId: string }; sponsorshipId: string }) => service.startSponsorPayment({ userId: c.sponsor.userId, sponsorshipId: c.sponsorshipId, idempotencyKey: randomUUID(), customerEmail: "biz@test.local", description: "Sponsored Game Post", ...urls }, { env: {} });
const agreementRows = async (id: string) => (await admin.from("sponsorship_agreement_acceptances").select("*").eq("sponsorship_id", id).order("accepted_at")).data!;
const attempts = async (id: string) => (await admin.from("commercial_payment_attempts").select("*").eq("sponsorship_id", id)).data!;

describe("the payment gate: legal acceptance is checked before a NEW online payment, whichever provider is active", () => {
  it("an ACTIVE Sponsor who hasn't accepted the current Sponsor Terms can't start a payment — nothing reaches the provider", async () => {
    const c = await campaign();
    await expect(pay(c)).rejects.toMatchObject({ code: "legal_acceptance_required" });
    expect(fake.calls).toHaveLength(0);
    expect(await attempts(c.sponsorshipId)).toHaveLength(0);
  });

  it("Terms accepted but the campaign agreement is not → still refused", async () => {
    const c = await campaign();
    await acceptTerms(c);
    await expect(pay(c)).rejects.toMatchObject({ code: "legal_acceptance_required" });
    expect(await gate.sponsorCommercialLegalStatus({ userId: c.sponsor.userId, sponsorshipId: c.sponsorshipId, stage: "PAYMENT" })).toEqual({ ok: false, missing: ["MEDIA_AGREEMENT"] });
  });

  it("both accepted → the normal payment rules take over and the attempt is created", async () => {
    const c = await campaign();
    await acceptTerms(c);
    expect((await acceptAgreement(c)).error).toBeNull();
    expect(await gate.sponsorCommercialLegalStatus({ userId: c.sponsor.userId, sponsorshipId: c.sponsorshipId, stage: "PAYMENT" })).toEqual({ ok: true });
    expect(await pay(c)).toMatchObject({ status: "redirect" });
    expect((await attempts(c.sponsorshipId))[0]).toMatchObject({ provider: "TEST_PROVIDER", amount_cents: 70000 });
  });

  it("the provider switch and the legal gate are independent: provider disabled → unavailable even with every acceptance in place", async () => {
    const c = await campaign();
    await acceptTerms(c);
    await acceptAgreement(c);
    await admin.from("platform_settings").update({ sponsorship_online_payments_enabled: false }).eq("id", true);
    await expect(pay(c)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("a content change after acceptance is a NEW revision: the agreement must be accepted again before paying", async () => {
    const c = await campaign();
    await acceptTerms(c);
    await acceptAgreement(c);
    await admin.from("sponsorships").update({ revision: 99 }).eq("id", c.sponsorshipId); // stands in for an edit that bumped the revision
    await expect(pay(c)).rejects.toMatchObject({ code: "legal_acceptance_required" });
    await acceptAgreement(c);
    expect(await pay(c)).toMatchObject({ status: "redirect" });
    expect((await agreementRows(c.sponsorshipId)).map((r) => r.revision).sort()).toHaveLength(2);
  });

  it("a Super Admin never pays on a Sponsor's behalf through this path: another Sponsor's acceptance doesn't count", async () => {
    const c = await campaign();
    const other = await campaign();
    await acceptTerms(c);
    await acceptTerms(other);
    await acceptAgreement(other);
    await expect(pay(c)).rejects.toMatchObject({ code: "legal_acceptance_required" });
  });
});

describe("campaign agreement acceptance: server-resolved, exact, immutable", () => {
  it("records the exact version, the revision, the content hash, the commercial snapshot and the Terms version — and audits it once", async () => {
    const c = await campaign();
    await acceptAgreement(c);
    await acceptAgreement(c); // repeat: a no-op
    const rows = await agreementRows(c.sponsorshipId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agreement_key: "media_agreement", agreement_version: "1.0", terms_version: "1.0", price_cents: 70000, currency: "USD", payment_status: "PENDING", accepted_by: c.sponsor.userId });
    expect(rows[0].content_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(rows[0].accepted_at).toBeTruthy();
    const { data: audit } = await admin.from("audit_logs").select("action").eq("entity_id", c.sponsorshipId).eq("action", "sponsorship.agreement_accepted");
    expect(audit).toHaveLength(1);
  });

  it("only the owning Sponsor can accept; a draft can't be accepted; nobody else can read or forge it", async () => {
    const c = await campaign();
    const other = await seedSponsorAccount("intruder");
    const forged = await acceptAgreement(c, other.userId);
    expect(forged.error).not.toBeNull();
    expect(await agreementRows(c.sponsorshipId)).toHaveLength(0);
    const draft = await campaign({ submit: false });
    expect((await acceptAgreement(draft)).error?.message).toMatch(/invalid_transition/);
    const member = await seedUser("legalmember");
    expect((await acceptAgreement(c, member)).error).not.toBeNull();
  });

  it("a suspended Sponsor account can't accept", async () => {
    const c = await campaign();
    await admin.from("sponsors").update({ status: "SUSPENDED" }).eq("id", c.sponsor.sponsorId);
    expect((await acceptAgreement(c)).error).not.toBeNull();
  });

  it("acceptance records can't be edited or deleted", async () => {
    const c = await campaign();
    await acceptAgreement(c);
    const [row] = await agreementRows(c.sponsorshipId);
    expect((await admin.from("sponsorship_agreement_acceptances").update({ agreement_version: "9.9" }).eq("id", row.id)).error).not.toBeNull();
    expect((await admin.from("sponsorship_agreement_acceptances").delete().eq("id", row.id)).error).not.toBeNull();
  });

  it("the database function is not callable by a browser (anon or signed-in) — only the server can record an acceptance", async () => {
    const c = await campaign();
    const { getTestAnonClient } = await import("./helpers/test-env");
    const r = await getTestAnonClient().rpc("sponsor_accept_agreement", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId, p_agreement_key: "media_agreement", p_agreement_version: "1.0", p_terms_key: null, p_terms_version: null });
    expect(r.error).not.toBeNull();
    expect(await agreementRows(c.sponsorshipId)).toHaveLength(0);
  });
});

describe("a new Sponsor Terms version re-requires acceptance; history stays", () => {
  it("v1 accepted → v2 becomes current → protected commercial steps need v2; the v1 acceptance and the Sponsorship's link to it are untouched", async () => {
    const c = await campaign();
    await acceptTerms(c, TERMS_V1);
    await acceptAgreement(c);
    const V2: SponsorLegalDocument = { ...TERMS_V1, version: "2.0", effectiveDate: "July 1, 2027" };
    expect(await acceptance.hasAcceptedCurrentSponsorTerms(c.sponsor.userId, TERMS_V1)).toBe(true);
    expect(await acceptance.hasAcceptedCurrentSponsorTerms(c.sponsor.userId, V2)).toBe(false);
    expect(await gate.sponsorCommercialLegalStatus({ userId: c.sponsor.userId, sponsorshipId: c.sponsorshipId, stage: "PAYMENT" }, { terms: V2, agreement: AGREEMENT_V1 })).toEqual({ ok: false, missing: ["SPONSOR_TERMS"] });
    await acceptTerms(c, V2);
    expect(await gate.sponsorCommercialLegalStatus({ userId: c.sponsor.userId, sponsorshipId: c.sponsorshipId, stage: "PAYMENT" }, { terms: V2, agreement: AGREEMENT_V1 })).toEqual({ ok: true });
    const { data: rows } = await admin.from("sponsor_terms_acceptances").select("version").eq("user_id", c.sponsor.userId).order("version");
    expect(rows!.map((r) => r.version)).toEqual(["1.0", "2.0"]);
    expect((await agreementRows(c.sponsorshipId))[0].terms_version).toBe("1.0"); // still tied to what it accepted then
  });

  it("a draft requires nothing: with no approved documents the gate is open (a draft binds nobody)", async () => {
    const c = await campaign();
    expect(await gate.sponsorCommercialLegalStatus({ userId: c.sponsor.userId, sponsorshipId: c.sponsorshipId, stage: "PAYMENT" }, { terms: null, agreement: null })).toEqual({ ok: true });
  });
});

describe("manual payment can't silently bypass a REQUIRED agreement", () => {
  it("without acceptance, mark-paid is refused unless Super Admin confirms an offline arrangement — which is recorded, not fabricated", async () => {
    const c = await campaign();
    const refused = await adminActions.markSponsorshipPaidAction(c.sponsorshipId, "INV-1", "bank", randomUUID());
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/offline arrangement/i);
    const offline = await adminActions.markSponsorshipPaidAction(c.sponsorshipId, "INV-1", "bank", randomUUID(), true);
    expect(offline.success).toBe(true);
    const { data: ev } = await admin.from("sponsorship_payment_events").select("provider, note").eq("sponsorship_id", c.sponsorshipId).eq("event_type", "PAID");
    expect(ev![0].provider).toBe("MANUAL");
    expect(ev![0].note).toMatch(/^\[Offline \/ admin-mediated arrangement — no Sponsor agreement acceptance on file\]/);
    expect(await agreementRows(c.sponsorshipId)).toHaveLength(0); // no acceptance was invented
  });

  it("with the Sponsor's acceptance on file, mark-paid works as before with no override", async () => {
    const c = await campaign();
    await acceptAgreement(c);
    const r = await adminActions.markSponsorshipPaidAction(c.sponsorshipId, "INV-2", "bank", randomUUID());
    expect(r.success).toBe(true);
    const { data: ev } = await admin.from("sponsorship_payment_events").select("note").eq("sponsorship_id", c.sponsorshipId).eq("event_type", "PAID");
    expect(ev![0].note ?? "").not.toMatch(/Offline/);
  });
});

describe("the refund policy in force is frozen on each Sponsorship", () => {
  const evaluate = async (id: string, reason = "SPONSOR_CANCELLATION") => (await ok("sponsorship_refund_evaluation", { p_id: id, p_reason: reason })) as unknown as Row;

  it("is copied when the Sponsorship first leaves DRAFT; a draft has none yet", async () => {
    const draft = await campaign({ submit: false });
    expect((await admin.from("sponsorships").select("refund_cutoff_hours_agreed").eq("id", draft.sponsorshipId).single()).data!.refund_cutoff_hours_agreed).toBeNull();
    await ok("sponsor_submit_sponsorship", { p_user_id: draft.sponsor.userId, p_id: draft.sponsorshipId });
    expect((await admin.from("sponsorships").select("refund_cutoff_hours_agreed").eq("id", draft.sponsorshipId).single()).data!.refund_cutoff_hours_agreed).toBe(12);
  });

  it("changing the configured cutoff 12 → 2 does NOT re-decide an existing Sponsorship — and applies to ones submitted afterwards", async () => {
    const old = await campaign({ startsInHours: 6 }); // kickoff in 6h: inside a 12h cutoff, outside a 2h one
    expect(await evaluate(old.sponsorshipId)).toMatchObject({ cutoffHours: 12, eligible: false });
    await admin.from("platform_settings").update({ sponsorship_refund_cutoff_hours: 2 }).eq("id", true);
    expect(await evaluate(old.sponsorshipId)).toMatchObject({ cutoffHours: 12, eligible: false }); // unchanged: the policy it was submitted under
    const fresh = await campaign({ startsInHours: 6 });
    expect(await evaluate(fresh.sponsorshipId)).toMatchObject({ cutoffHours: 2, eligible: true });
  });

  it("is immutable: nobody can rewrite the frozen value, and the cancellation snapshot keeps the decision as made", async () => {
    const c = await campaign({ startsInHours: 48 });
    expect((await admin.from("sponsorships").update({ refund_cutoff_hours_agreed: 1 }).eq("id", c.sponsorshipId)).error?.message).toMatch(/immutable/);
    await ok("sponsor_cancel_sponsorship", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId });
    const before = (await admin.from("sponsorship_cancellations").select("cutoff_hours, refund_eligible, cutoff_at").eq("sponsorship_id", c.sponsorshipId).single()).data!;
    await admin.from("platform_settings").update({ sponsorship_refund_cutoff_hours: 60 }).eq("id", true);
    const after = (await admin.from("sponsorship_cancellations").select("cutoff_hours, refund_eligible, cutoff_at").eq("sponsorship_id", c.sponsorshipId).single()).data!;
    expect(after).toEqual(before);
    expect(before.cutoff_hours).toBe(12);
  });

  it("the exact T-cutoff boundary is still eligible, and one second later is not (Sponsor-initiated cancellation only)", async () => {
    const c = await campaign({ startsInHours: 48 });
    const { data: fx } = await admin.from("fixtures").select("scheduled_start_utc").eq("id", c.fixtureId).single();
    const kickoff = new Date(fx!.scheduled_start_utc).getTime();
    const at = async (ms: number, reason = "SPONSOR_CANCELLATION") => (await ok("sponsorship_refund_evaluation", { p_id: c.sponsorshipId, p_reason: reason, p_now: new Date(ms).toISOString() })) as unknown as Row;
    expect((await at(kickoff - 12 * HOUR)).eligible).toBe(true);
    expect((await at(kickoff - 12 * HOUR + 1000)).eligible).toBe(false);
    expect((await at(kickoff - 1000, "BROHDA_REJECTED")).eligible).toBe(true); // Brohda-caused: the cutoff never applies
  });
});

describe("approved Sponsor Terms and the configured cutoff must agree before new submissions", () => {
  it("a configured cutoff that differs from the approved text pauses NEW submissions (stage SUBMIT) and nothing else", async () => {
    const c = await campaign();
    await acceptTerms(c);
    expect(await gate.sponsorCommercialLegalStatus({ userId: c.sponsor.userId, sponsorshipId: null, stage: "SUBMIT" }, { terms: TERMS_V1, agreement: AGREEMENT_V1 })).toEqual({ ok: true });
    await admin.from("platform_settings").update({ sponsorship_refund_cutoff_hours: 2 }).eq("id", true);
    expect(await gate.sponsorCommercialLegalStatus({ userId: c.sponsor.userId, sponsorshipId: null, stage: "SUBMIT" }, { terms: TERMS_V1, agreement: AGREEMENT_V1 })).toEqual({ ok: false, missing: ["REFUND_POLICY"] });
    // an existing, already-submitted campaign's PAYMENT stage is about acceptances, not about the new setting
    await acceptAgreement(c);
    expect(await gate.sponsorCommercialLegalStatus({ userId: c.sponsor.userId, sponsorshipId: c.sponsorshipId, stage: "PAYMENT" }, { terms: TERMS_V1, agreement: AGREEMENT_V1 })).toEqual({ ok: true });
  });
});
