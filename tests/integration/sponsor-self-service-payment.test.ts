/**
 * Sponsor self-service payment, end to end against the real database and payment service (a fake provider through the production registry; the Sponsor legal documents stood in
 * as APPROVED). Proved: one canonical eligibility decides Pay now (and agrees with what the payment service will accept); payment success makes the sponsorship PAID and nothing
 * else — approval stays Super Admin's; a double click or two tabs make one attempt; Sponsor-only emails go to the Sponsor's own login (received / failed / refund completed) and
 * to nobody else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import { seedGame, seedSponsorAccount, seedUser } from "./helpers/game-seed";
import { FakeProvider } from "../helpers/fake-provider";
import { clearTestAdapters, registerTestAdapter } from "@/lib/payments/registry";
import { loadPublicSponsorships } from "@/lib/sponsorship/public";

const held = vi.hoisted(() => ({ adminId: "", emails: [] as Array<{ to: string; subject: string; html: string }> }));
vi.mock("@/lib/sponsor/terms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sponsor/terms")>()),
  CURRENT_SPONSOR_TERMS: { key: "sponsor_terms", title: "Sponsor Terms", version: "1.0", effectiveDate: "January 1, 2027", status: "APPROVED", href: "/sponsor/terms", refundCutoffHours: 12 },
  CURRENT_MEDIA_AGREEMENT: { key: "media_agreement", title: "Media and Advertising Agreement", version: "1.0", effectiveDate: "January 1, 2027", status: "APPROVED", href: "/sponsor/terms#media-agreement" },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: async (m: { to: string; subject: string; html: string }) => void held.emails.push(m) }));
vi.mock("@/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth/session")>()), requireSuperAdmin: async () => ({ id: held.adminId }) }));

const admin = getTestAdminClient();
const HOUR = 3_600_000;
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let service: typeof import("@/lib/payments/service");
let eligibilityMod: typeof import("@/lib/sponsorship/payment-eligibility");
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
  eligibilityMod = await import("@/lib/sponsorship/payment-eligibility");
  acceptance = await import("@/lib/sponsor/legal-acceptance");
  adminActions = await import("@/lib/actions/admin-sponsorship");
});
beforeEach(async () => {
  held.emails.length = 0;
  fake = new FakeProvider();
  clearTestAdapters();
  registerTestAdapter(fake);
  await admin.from("platform_settings").update({ sponsorship_enabled: true, sponsorship_online_payments_enabled: true, sponsorship_online_payment_provider: "TEST_PROVIDER" }).eq("id", true);
});
afterAll(async () => {
  clearTestAdapters();
  if (staffIds.length) await admin.from("user_profiles").update({ role: "player" }).in("id", staffIds);
  await admin.from("platform_settings").update({ sponsorship_enabled: false, sponsorship_online_payments_enabled: false, sponsorship_online_payment_provider: null }).eq("id", true);
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
  held.adminId = await seedUser("selfsvcadmin");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", held.adminId);
  staffIds.push(held.adminId);
  return held.adminId;
}

/** A SUBMITTED sponsorship (payment PENDING); `legal: true` also records the Sponsor's Terms and agreement acceptances. */
async function campaign(opts: { legal?: boolean } = {}) {
  const adminId = await superAdmin();
  const sponsor = await seedSponsorAccount("selfsvc");
  const { fixtureId } = await seedGame({ startsInMinutes: 48 * 60 });
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  const inv = await ok("admin_set_sponsorship_inventory", { p_admin_id: adminId, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 90000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 60 * HOUR).toISOString() });
  const created = await ok("sponsor_create_sponsorship", { p_user_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.id, p_campaign_name: "SelfSvc" });
  await ok("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: created.id, p_fields: { presented_by: "Acme Sports", tagline: "Fuel the game", cta_text: "Learn more", destination_url: "https://acme.example.com/promo" } });
  await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: created.id });
  const c = { adminId, sponsor, sponsorshipId: created.id as string, postId: post!.id as string };
  if (opts.legal) await accept(c);
  return c;
}
const TERMS = { key: "sponsor_terms", title: "Sponsor Terms", version: "1.0", effectiveDate: "January 1, 2027", status: "APPROVED" as const, href: "/sponsor/terms" };
async function accept(c: { sponsor: { userId: string; sponsorId: string }; sponsorshipId: string }) {
  await acceptance.recordSponsorTermsAcceptance(c.sponsor.userId, c.sponsor.sponsorId, "signup", TERMS);
  await ok("sponsor_accept_agreement", { p_user_id: c.sponsor.userId, p_id: c.sponsorshipId, p_agreement_key: "media_agreement", p_agreement_version: "1.0", p_terms_key: "sponsor_terms", p_terms_version: "1.0" });
}
const eligibility = async (c: { sponsor: { userId: string }; sponsorshipId: string }, sponsorStatus = "ACTIVE", capabilityEnabled = true) => {
  const { data: s } = await admin.from("sponsorships").select("lifecycle, payment_status").eq("id", c.sponsorshipId).single();
  return eligibilityMod.sponsorPaymentEligibility({ userId: c.sponsor.userId, sponsorStatus, capabilityEnabled, sponsorship: { id: c.sponsorshipId, lifecycle: s!.lifecycle, paymentStatus: s!.payment_status } });
};
const urls = { successUrl: "https://app.test/return?result=success", cancelUrl: "https://app.test/return?result=cancel" };
const pay = (c: { sponsor: { userId: string }; sponsorshipId: string }, key: string = randomUUID()) =>
  service.startSponsorPayment({ userId: c.sponsor.userId, sponsorshipId: c.sponsorshipId, idempotencyKey: key, customerEmail: "biz@test.local", description: "Sponsored Game Post", ...urls }, { env: {} });
const row = async (id: string) => (await admin.from("sponsorships").select("lifecycle, payment_status, review_status, approved_by").eq("id", id).single()).data!;
const attempts = async (id: string) => (await admin.from("commercial_payment_attempts").select("*").eq("sponsorship_id", id).order("created_at")).data!;
const approve = async (c: { adminId: string; sponsorshipId: string }) => {
  const { data } = await admin.from("sponsorships").select("revision").eq("id", c.sponsorshipId).single();
  return ok("admin_approve_sponsorship", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_expected_revision: data!.revision });
};
const succeed = async (c: { sponsorshipId: string }) => {
  const [a] = await attempts(c.sponsorshipId);
  fake.settle(a.provider_session_id, "SUCCEEDED");
  return service.handleProviderWebhook("TEST_PROVIDER", new Headers({ "x-fake-secret": fake.secret }), JSON.stringify({ sessionId: a.provider_session_id, outcome: "SUCCEEDED" }));
};
const emailsFor = (to: string) => held.emails.filter((e) => e.to === to);

describe("one canonical eligibility decides Pay now — and agrees with what the payment service will accept", () => {
  it("ACTIVE Sponsor + own submitted unpaid sponsorship + provider available + legal acceptances → PAY_NOW, and starting the payment works", async () => {
    const c = await campaign({ legal: true });
    expect(await eligibility(c)).toEqual({ state: "PAY_NOW" });
    expect(await pay(c)).toMatchObject({ status: "redirect" });
  });

  it("a missing legal acceptance → LEGAL_BLOCKED (no button), and the service refuses for the same reason", async () => {
    const c = await campaign();
    expect(await eligibility(c)).toEqual({ state: "LEGAL_BLOCKED", missing: ["SPONSOR_TERMS", "MEDIA_AGREEMENT"] });
    await expect(pay(c)).rejects.toMatchObject({ code: "legal_acceptance_required" });
  });

  it("online payments disabled → ONLINE_UNAVAILABLE; the service refuses too (manual payment is untouched)", async () => {
    const c = await campaign({ legal: true });
    await admin.from("platform_settings").update({ sponsorship_online_payments_enabled: false }).eq("id", true);
    expect(await eligibility(c)).toEqual({ state: "ONLINE_UNAVAILABLE" });
    await expect(pay(c)).rejects.toMatchObject({ code: "unavailable" });
    await ok("admin_mark_sponsorship_paid", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_reference: "INV", p_note: "bank", p_idempotency_key: randomUUID() }); // manual fallback works
    expect((await row(c.sponsorshipId)).payment_status).toBe("PAID");
  });

  it("provider selected but not configured → ONLINE_UNAVAILABLE (never a broken button)", async () => {
    const c = await campaign({ legal: true });
    fake.configured = false;
    expect(await eligibility(c)).toEqual({ state: "ONLINE_UNAVAILABLE" });
    await expect(pay(c)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("already paid → NOT_PAYABLE; cancelled → NOT_PAYABLE; a non-ACTIVE Sponsor account → NOT_PAYABLE; capability OFF → NOT_PAYABLE", async () => {
    const paid = await campaign({ legal: true });
    await ok("admin_mark_sponsorship_paid", { p_admin_id: paid.adminId, p_id: paid.sponsorshipId, p_reference: "INV", p_note: "", p_idempotency_key: randomUUID() });
    expect(await eligibility(paid)).toEqual({ state: "NOT_PAYABLE", reason: "ALREADY_PAID" });
    await expect(pay(paid)).rejects.toMatchObject({ code: "already_paid" });

    const cancelled = await campaign({ legal: true });
    await ok("sponsor_cancel_sponsorship", { p_user_id: cancelled.sponsor.userId, p_id: cancelled.sponsorshipId });
    expect(await eligibility(cancelled)).toEqual({ state: "NOT_PAYABLE", reason: "CANCELLED_OR_ENDED" });
    await expect(pay(cancelled)).rejects.toMatchObject({ code: "not_payable" });

    const pendingSponsor = await campaign({ legal: true });
    for (const status of ["PENDING_REVIEW", "REJECTED", "SUSPENDED", "DISABLED"] as const) {
      await admin.from("sponsors").update({ status }).eq("id", pendingSponsor.sponsor.sponsorId);
      expect(await eligibility(pendingSponsor, status)).toEqual({ state: "NOT_PAYABLE", reason: "ACCOUNT_NOT_ACTIVE" });
      await expect(pay(pendingSponsor), status).rejects.toMatchObject({ code: "not_payable" });
    }
    const off = await campaign({ legal: true });
    expect(await eligibility(off, "ACTIVE", false)).toEqual({ state: "NOT_PAYABLE", reason: "CAPABILITY_OFF" });
  });

  it("a Member and another Sponsor can't start someone else's payment", async () => {
    const c = await campaign({ legal: true });
    const member = await seedUser("selfsvcmember");
    const other = await seedSponsorAccount("othersvc");
    for (const userId of [member, other.userId]) {
      await expect(service.startSponsorPayment({ userId, sponsorshipId: c.sponsorshipId, idempotencyKey: randomUUID(), customerEmail: null, description: "x", ...urls }, { env: {} })).rejects.toMatchObject({ code: expect.stringMatching(/not_authorized|legal_acceptance_required/) });
    }
    expect(await attempts(c.sponsorshipId)).toHaveLength(0);
  });

  it("whenever the canonical check says PAY_NOW the service accepts, and whenever it says anything else the service refuses (no broken buttons, no hidden gates)", async () => {
    for (const setup of ["ok", "legal", "off", "unconfigured"] as const) {
      const c = await campaign({ legal: setup !== "legal" });
      if (setup === "off") await admin.from("platform_settings").update({ sponsorship_online_payments_enabled: false }).eq("id", true);
      if (setup === "unconfigured") fake.configured = false;
      const e = await eligibility(c);
      const result = await pay(c).then(() => "accepted", () => "refused");
      expect(result, setup).toBe(e.state === "PAY_NOW" ? "accepted" : "refused");
      await admin.from("platform_settings").update({ sponsorship_online_payments_enabled: true }).eq("id", true);
      fake.configured = true;
    }
  });
});

describe("payment success makes the sponsorship PAID — and nothing else", () => {
  it("PAID + unapproved: review untouched, no approver, not live, not public; the Sponsor gets 'Payment received' — and then no longer sees Pay now", async () => {
    const c = await campaign({ legal: true });
    await pay(c);
    expect(await succeed(c)).toMatchObject({ status: 200 });
    const r = await row(c.sponsorshipId);
    expect(r).toMatchObject({ payment_status: "PAID", review_status: "PENDING", approved_by: null, lifecycle: "SUBMITTED" });
    expect((await attempts(c.sponsorshipId))[0]).toMatchObject({ status: "SUCCEEDED" }); // the provider attempt is recorded internally with when it was paid
    expect((await attempts(c.sponsorshipId))[0].paid_at).toBeTruthy();
    expect((await loadPublicSponsorships([c.postId])).size).toBe(0);
    expect(await eligibility(c)).toEqual({ state: "NOT_PAYABLE", reason: "ALREADY_PAID" });
    const mails = emailsFor(c.sponsor.email);
    expect(mails.map((m) => m.subject)).toEqual(["Payment received"]);
    expect(mails[0].html).toMatch(/awaiting Brohda approval/);
    expect(held.emails.every((m) => m.to === c.sponsor.email)).toBe(true); // nobody else is told — never a Member
    const { data: events } = await admin.from("sponsorship_payment_events").select("event_type, provider").eq("sponsorship_id", c.sponsorshipId).eq("event_type", "PAID");
    expect(events).toEqual([{ event_type: "PAID", provider: "TEST_PROVIDER" }]); // audited as a payment event with its provider
  });

  it("then Super Admin approval is what puts it on the clock (existing scheduling policy)", async () => {
    const c = await campaign({ legal: true });
    await pay(c);
    await succeed(c);
    expect((await row(c.sponsorshipId)).review_status).toBe("PENDING");
    await approve(c);
    expect(["SCHEDULED", "LIVE"]).toContain((await row(c.sponsorshipId)).lifecycle);
    expect((await loadPublicSponsorships([c.postId])).size).toBe(1);
  });

  it("approved first, paid second → on the clock once payment is confirmed; payment itself approved nothing", async () => {
    const c = await campaign({ legal: true });
    await approve(c);
    expect((await row(c.sponsorshipId)).lifecycle).toBe("SUBMITTED");
    await pay(c);
    await succeed(c);
    expect(["SCHEDULED", "LIVE"]).toContain((await row(c.sponsorshipId)).lifecycle);
    expect((await row(c.sponsorshipId)).approved_by).toBe(c.adminId);
  });

  it("the browser-return step alone can't mark anything paid: with the provider still unpaid, reconciling leaves it pending", async () => {
    const c = await campaign({ legal: true });
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    await service.reconcileAttempt(a.id); // what the return page does
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");
    expect((await attempts(c.sponsorshipId))[0].status).toBe("PENDING");
  });

  it("a failed payment tells the Sponsor, leaves the sponsorship payable, and a retry is offered", async () => {
    const c = await campaign({ legal: true });
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    fake.settle(a.provider_session_id, "FAILED");
    await service.handleProviderWebhook("TEST_PROVIDER", new Headers({ "x-fake-secret": fake.secret }), JSON.stringify({ sessionId: a.provider_session_id, outcome: "FAILED" }));
    expect((await row(c.sponsorshipId)).payment_status).toBe("FAILED");
    expect(emailsFor(c.sponsor.email).map((m) => m.subject)).toEqual(["Your sponsorship payment didn't go through"]);
    expect(await eligibility(c)).toEqual({ state: "PAY_NOW" });
    expect(await pay(c)).toMatchObject({ status: "redirect" });
  });
});

describe("double payment protection", () => {
  it("a double click, two tabs and a retry make ONE attempt and ONE provider session", async () => {
    const c = await campaign({ legal: true });
    const key = randomUUID();
    const results = await Promise.all([pay(c, key), pay(c, key), pay(c), pay(c)]);
    expect(results.every((r) => r.status === "redirect" || r.status === "starting")).toBe(true);
    expect(await attempts(c.sponsorshipId)).toHaveLength(1);
    expect(fake.calls.filter((x) => x === "createPayment")).toHaveLength(1);
  });

  it("manual payment recorded while the online payment is pending closes the open attempt; a later provider success is flagged, not counted twice", async () => {
    const c = await campaign({ legal: true });
    await pay(c);
    await ok("admin_mark_sponsorship_paid", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_reference: "INV", p_note: "bank", p_idempotency_key: randomUUID() });
    expect((await attempts(c.sponsorshipId))[0].status).toBe("SUPERSEDED"); // closed by the manual payment, still on record
    await succeed(c);
    const { data: paid } = await admin.from("sponsorship_payment_events").select("id").eq("sponsorship_id", c.sponsorshipId).eq("event_type", "PAID");
    expect(paid).toHaveLength(1);
  });
});

describe("Sponsor-only notifications for refunds", () => {
  const paidThroughProvider = async () => {
    const c = await campaign({ legal: true });
    await pay(c);
    await succeed(c);
    held.emails.length = 0;
    return c;
  };

  it("a provider refund that succeeds tells the Sponsor once — and only the Sponsor", async () => {
    const c = await paidThroughProvider();
    const [a] = await attempts(c.sponsorshipId);
    expect(await service.refundThroughProvider(c.adminId, a.id)).toMatchObject({ status: "succeeded" });
    expect(held.emails.map((m) => [m.to, m.subject])).toEqual([[c.sponsor.email, "Refund completed"]]);
  });

  it("a refund that is pending says nothing until the check finds it succeeded — and checking again doesn't repeat it", async () => {
    const c = await paidThroughProvider();
    fake.refundMode = "pending";
    const [a] = await attempts(c.sponsorshipId);
    const first = await service.refundThroughProvider(c.adminId, a.id);
    expect(first.status).toBe("pending");
    expect(held.emails).toHaveLength(0);
    await service.reconcileRefund(c.adminId, first.refundId);
    await service.reconcileRefund(c.adminId, first.refundId);
    expect(held.emails.map((m) => m.subject)).toEqual(["Refund completed"]);
  });

  it("a manually recorded refund tells the Sponsor too; other payment events don't send refund mail", async () => {
    const c = await campaign({ legal: true });
    await ok("admin_mark_sponsorship_paid", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_reference: "INV", p_note: "bank", p_idempotency_key: randomUUID() });
    held.emails.length = 0;
    const r = await adminActions.recordPaymentEventAction(c.sponsorshipId, "REFUNDED", "bank", "manual refund", randomUUID());
    expect(r.success).toBe(true);
    expect(held.emails.map((m) => [m.to, m.subject])).toEqual([[c.sponsor.email, "Refund completed"]]);
    expect(held.emails[0].html).not.toMatch(/onvo|stripe|paypal/i);
  });
});
