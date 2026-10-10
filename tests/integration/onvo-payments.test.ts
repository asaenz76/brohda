/**
 * ONVO sponsorship payments against the real database, the real payment service and the real ONVO adapter — with ONVO's network replaced by a deterministic sandbox
 * modelled on its published API. No network, no money. What is proved: the amount comes from the database; only a verified, authenticated, idempotent provider fact can
 * mark a sponsorship PAID; PAID never publishes anything by itself (Super Admin approval is still required); and double payment, manual collision, out-of-order events,
 * unknown outcomes, refunds and environment mix-ups all end in a safe, auditable state.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient, getTestSupabaseConfig } from "./helpers/test-env";
import { seedGame, seedSponsorAccount, seedUser } from "./helpers/game-seed";
import { OnvoSandbox } from "../helpers/onvo-sandbox";
import { loadPublicSponsorships } from "@/lib/sponsorship/public";
import { OnvoProvider } from "@/lib/payments/onvo/adapter";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const admin = getTestAdminClient();
const PASSWORD = "integration-test-password-123";
const HOUR = 3_600_000;
const KEY = "onvo_test_secret_key_integration";
const WH = "webhook_secret_integration";
const ENV = { ONVO_SECRET_KEY: KEY, ONVO_WEBHOOK_SECRET: WH, ONVO_ENVIRONMENT: "TEST" };
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let service: typeof import("@/lib/payments/service");
let sandbox: OnvoSandbox;
let provider: OnvoProvider;

beforeAll(async () => {
  const cfg = getTestSupabaseConfig();
  process.env.NEXT_PUBLIC_SUPABASE_URL = cfg.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = cfg.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = cfg.serviceRoleKey;
  service = await import("@/lib/payments/service");
});
beforeEach(() => {
  sandbox = new OnvoSandbox(KEY, "http://sandbox", "test");
  provider = new OnvoProvider({ ...ENV }, sandbox.fetcher);
});
const staffIds: string[] = [];
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
async function superAdmin() {
  const id = await seedUser("onvoadmin");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", id);
  staffIds.push(id);
  return id;
}

/** A SUBMITTED sponsorship (payment PENDING) priced 123400 USD, owned by an ACTIVE Sponsor. `approved`: Super Admin has approved it already. */
async function campaign(opts: { approved?: boolean } = {}) {
  const adminId = await superAdmin();
  await admin.from("platform_settings").update({ sponsorship_enabled: true }).eq("id", true);
  const sponsor = await seedSponsorAccount("onvo");
  const { fixtureId } = await seedGame({ startsInMinutes: 24 * 60 });
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  const inv = await ok("admin_set_sponsorship_inventory", { p_admin_id: adminId, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 123400, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 30 * HOUR).toISOString() });
  const created = await ok("sponsor_create_sponsorship", { p_user_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.id, p_campaign_name: "Onvo" });
  await ok("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: created.id, p_fields: { presented_by: "Acme Sports", tagline: "Fuel the game", cta_text: "Learn more", destination_url: "https://acme.example.com/promo" } });
  await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: created.id });
  const c = { adminId, sponsor, sponsorshipId: created.id as string, postId: post!.id as string, inventoryId: inv.id as string };
  if (opts.approved) await approve(c);
  return c;
}
const approve = async (c: { adminId: string; sponsorshipId: string }) => {
  const { data } = await admin.from("sponsorships").select("revision").eq("id", c.sponsorshipId).single();
  return ok("admin_approve_sponsorship", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_expected_revision: data!.revision });
};
const urls = { successUrl: "https://app.test/return?result=success", cancelUrl: "https://app.test/return?result=cancel" };
const pay = (c: { sponsor: { userId: string }; sponsorshipId: string }, key: string = randomUUID()) =>
  service.startSponsorPayment({ userId: c.sponsor.userId, sponsorshipId: c.sponsorshipId, idempotencyKey: key, customerEmail: "biz@test.local", description: "Sponsored Game Post", ...urls }, { provider, env: {} });
const row = async (id: string) => (await admin.from("sponsorships").select("lifecycle, payment_status, review_status").eq("id", id).single()).data!;
const attempts = async (id: string) => (await admin.from("commercial_payment_attempts").select("*").eq("sponsorship_id", id).order("created_at")).data!;
const hook = (event: { type: string; data: Record<string, unknown> }, secret: string | null = WH) => {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret !== null) headers.set("X-Webhook-Secret", secret);
  return service.handleProviderWebhook(headers, JSON.stringify(event), { provider, env: {} });
};
const paidEvents = async (id: string) => (await admin.from("sponsorship_payment_events").select("*").eq("sponsorship_id", id).eq("event_type", "PAID")).data!;
const sessionOf = async (id: string) => (await attempts(id))[0].provider_session_id as string;

describe("creating an ONVO payment", () => {
  it("an ACTIVE Sponsor + eligible sponsorship → a hosted session for EXACTLY the frozen price, and an attempt on record", async () => {
    const c = await campaign();
    const r = await pay(c);
    expect(r.status).toBe("redirect");
    if (r.status !== "redirect") return;
    expect(r.url).toMatch(/^http:\/\/sandbox\/pay\/cs_/);
    const [a] = await attempts(c.sponsorshipId);
    expect(a).toMatchObject({ provider: "ONVO", environment: "TEST", status: "PENDING", amount_cents: 123400, currency: "USD", sponsor_id: c.sponsor.sponsorId });
    expect(a.provider_session_id).toBeTruthy();
    expect(a.checkout_url).toBe(r.url);
    const create = sandbox.requests.find((q) => q.method === "POST")!;
    expect(create.body).toMatchObject({ lineItems: [{ quantity: 1, unitAmount: 123400, currency: "USD" }], metadata: { brohdaPaymentAttemptId: a.id } });
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING"); // starting a payment is not paying
  });

  it("the amount is the FROZEN snapshot: changing the inventory price afterwards changes nothing", async () => {
    const c = await campaign();
    await admin.from("sponsorship_inventory").update({ price_cents: 999999 }).eq("id", c.inventoryId);
    await pay(c);
    expect(sandbox.requests.find((q) => q.method === "POST")!.body).toMatchObject({ lineItems: [{ unitAmount: 123400 }] });
    expect((await attempts(c.sponsorshipId))[0].amount_cents).toBe(123400);
  });

  it("is refused for: a pending / suspended Sponsor, a Member, another Sponsor, an unsubmitted draft, a cancelled or already-paid sponsorship, and when sponsorship is OFF", async () => {
    const c = await campaign();
    await admin.from("sponsors").update({ status: "SUSPENDED" }).eq("id", c.sponsor.sponsorId);
    await expect(pay(c)).rejects.toMatchObject({ code: "not_payable" });
    await admin.from("sponsors").update({ status: "PENDING_REVIEW" }).eq("id", c.sponsor.sponsorId);
    await expect(pay(c)).rejects.toMatchObject({ code: "not_payable" });
    await admin.from("sponsors").update({ status: "ACTIVE" }).eq("id", c.sponsor.sponsorId);

    const member = await seedUser("onvomember");
    await expect(service.startSponsorPayment({ userId: member, sponsorshipId: c.sponsorshipId, idempotencyKey: randomUUID(), customerEmail: null, description: "x", ...urls }, { provider, env: {} })).rejects.toMatchObject({ code: "not_authorized" });
    const other = await seedSponsorAccount("otheronvo");
    await expect(service.startSponsorPayment({ userId: other.userId, sponsorshipId: c.sponsorshipId, idempotencyKey: randomUUID(), customerEmail: null, description: "x", ...urls }, { provider, env: {} })).rejects.toMatchObject({ code: "not_authorized" });

    await admin.from("platform_settings").update({ sponsorship_enabled: false }).eq("id", true);
    await expect(pay(c)).rejects.toMatchObject({ code: "not_payable" });
    await admin.from("platform_settings").update({ sponsorship_enabled: true }).eq("id", true);
    expect(sandbox.requests).toHaveLength(0); // nothing reached the provider for any of the refusals

    await ok("admin_mark_sponsorship_paid", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_reference: "INV", p_note: "n", p_idempotency_key: randomUUID() });
    await expect(pay(c)).rejects.toMatchObject({ code: "already_paid" });

    const d = await campaign();
    await ok("sponsor_cancel_sponsorship", { p_user_id: d.sponsor.userId, p_id: d.sponsorshipId });
    await expect(pay(d)).rejects.toMatchObject({ code: "not_payable" });
    expect(sandbox.requests).toHaveLength(0);
  });

  it("a draft that was never submitted is not payable", async () => {
    const c = await campaign();
    const e = await campaign();
    const { data: draft } = await admin.from("sponsorships").select("id").eq("id", e.sponsorshipId).single();
    await admin.from("sponsorships").update({ lifecycle: "DRAFT", payment_status: "UNPAID" }).eq("id", draft!.id);
    await expect(pay(e)).rejects.toMatchObject({ code: "not_payable" });
    void c;
  });

  it("an unsupported currency fails safely before any money moves, and leaves a retryable FAILED attempt", async () => {
    const c = await campaign();
    await admin.from("sponsorships").update({ currency: "EUR" }).eq("id", c.sponsorshipId);
    await expect(pay(c)).rejects.toMatchObject({ code: "provider_unavailable" });
    const [a] = await attempts(c.sponsorshipId);
    expect(a.status).toBe("FAILED");
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");
  });

  it("a network failure creating the session is an UNKNOWN outcome: nothing is marked paid, the attempt is FAILED/retryable, and a retry makes a fresh attempt", async () => {
    const c = await campaign();
    sandbox.failNext(/POST \/v1\/checkout/, "network");
    await expect(pay(c)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect((await attempts(c.sponsorshipId))[0]).toMatchObject({ status: "FAILED", failure_code: "network" });
    const r = await pay(c);
    expect(r.status).toBe("redirect");
    expect((await attempts(c.sponsorshipId)).map((a) => a.status)).toEqual(["FAILED", "PENDING"]);
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");
  });
});

describe("webhooks: only an authenticated, verified, idempotent provider fact marks PAID", () => {
  it("valid secret + checkout success → PAID, with the provider reference, TEST environment and a full audit — and the campaign is NOT live", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    const intent = sandbox.pay(sessionId);
    const res = await hook(sandbox.webhook("checkout-session.succeeded", sessionId));
    expect(res).toMatchObject({ status: 200, body: { received: true, result: "APPLIED_PAID" } });
    const [a] = await attempts(c.sponsorshipId);
    expect(a).toMatchObject({ status: "SUCCEEDED", provider_payment_ref: intent.id });
    expect(a.paid_at).toBeTruthy();
    expect(await row(c.sponsorshipId)).toEqual({ lifecycle: "SUBMITTED", payment_status: "PAID", review_status: "PENDING" }); // paid, still awaiting approval
    const [event] = await paidEvents(c.sponsorshipId);
    expect(event).toMatchObject({ provider: "ONVO", environment: "TEST", amount_cents: 123400, currency: "USD", provider_reference: intent.id });
    const { data: logs } = await admin.from("audit_logs").select("action, after").eq("entity_id", c.sponsorshipId).eq("action", "sponsorship.payment_confirmed");
    expect(logs).toHaveLength(1);
    expect(logs![0].after).toMatchObject({ paymentProvider: "ONVO", paymentEnvironment: "TEST" });
    expect((await loadPublicSponsorships([c.postId])).size).toBe(0); // NOT LIVE
  });

  it("an invalid or missing secret is rejected with no mutation and no detail", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    sandbox.pay(sessionId);
    const event = sandbox.webhook("checkout-session.succeeded", sessionId);
    expect(await hook(event, "wrong")).toEqual({ status: 401, body: { received: false } });
    expect(await hook(event, null)).toEqual({ status: 401, body: { received: false } });
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");
    expect((await admin.from("commercial_payment_provider_events").select("id")).data!.filter(() => false)).toEqual([]);
    expect((await attempts(c.sponsorshipId))[0].status).toBe("PENDING");
  });

  it("a DUPLICATE delivery changes nothing: one payment row, one audit row, one notification-worthy change", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    sandbox.pay(sessionId);
    const event = sandbox.webhook("checkout-session.succeeded", sessionId);
    expect((await hook(event)).body.result).toBe("APPLIED_PAID");
    for (let i = 0; i < 3; i++) expect((await hook(event)).body.result).toBe("DUPLICATE");
    expect(await paidEvents(c.sponsorshipId)).toHaveLength(1);
    expect((await admin.from("audit_logs").select("id").eq("entity_id", c.sponsorshipId).eq("action", "sponsorship.payment_confirmed")).data).toHaveLength(1);
    expect((await attempts(c.sponsorshipId)).filter((a) => a.status === "SUCCEEDED")).toHaveLength(1);
  });

  it("the paid state is taken from the PROVIDER, not the webhook body: a 'paid' webhook for an unpaid session is not accepted", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    const forged = sandbox.webhook("checkout-session.succeeded", sessionId); // the sandbox session is still UNPAID
    const res = await hook(forged);
    expect(res.status).toBe(500); // not confirmed (yet): the provider will retry; nothing changed
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");
    expect((await attempts(c.sponsorshipId))[0].status).toBe("PENDING");
  });

  it("an amount that differs from the frozen price is NEVER accepted: the attempt is a MISMATCH for review and nothing is paid", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    sandbox.pay(sessionId, { amount: 100 }); // the payer somehow paid a different amount
    const res = await hook(sandbox.webhook("checkout-session.succeeded", sessionId));
    expect(res.body.result).toBe("AMOUNT_MISMATCH");
    expect((await attempts(c.sponsorshipId))[0].status).toBe("MISMATCH");
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");
    expect((await admin.from("audit_logs").select("action").eq("entity_id", c.sponsorshipId).eq("action", "sponsorship.payment_amount_mismatch")).data).toHaveLength(1);
  });

  it("a payment in another currency is a mismatch too", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    sandbox.pay(sessionId, { currency: "CRC" });
    expect((await hook(sandbox.webhook("checkout-session.succeeded", sessionId))).body.result).toBe("AMOUNT_MISMATCH");
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");
  });

  it("failed → FAILED (the Sponsor can retry); deferred → PENDING and NEVER paid", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    const deferred = sandbox.defer(sessionId);
    expect((await hook(sandbox.webhook("payment-intent.deferred", sessionId, deferred, { withMetadata: true }))).body.result).toBe("APPLIED_PENDING");
    expect((await attempts(c.sponsorshipId))[0].status).toBe("PENDING");
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");

    const failedIntent = sandbox.fail(sessionId);
    expect((await hook(sandbox.webhook("payment-intent.failed", sessionId, failedIntent, { withMetadata: true }))).body.result).toBe("APPLIED_FAILED");
    expect((await attempts(c.sponsorshipId))[0]).toMatchObject({ status: "FAILED", failure_code: "declined" });
    expect((await row(c.sponsorshipId)).payment_status).toBe("FAILED");
    expect((await admin.from("sponsorship_payment_events").select("event_type").eq("sponsorship_id", c.sponsorshipId).eq("event_type", "FAILED")).data).toHaveLength(1);
    // The inventory is still held exactly as before, and the Sponsor can try again with a fresh attempt.
    expect((await row(c.sponsorshipId)).lifecycle).toBe("SUBMITTED");
    const retry = await pay(c);
    expect(retry.status).toBe("redirect");
    expect((await attempts(c.sponsorshipId)).map((a) => a.status)).toEqual(["FAILED", "PENDING"]);
  });

  it("OUT-OF-ORDER: failed then succeeded ends PAID; succeeded then failed/pending stays PAID", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    const failed = sandbox.fail(sessionId);
    await hook(sandbox.webhook("payment-intent.failed", sessionId, failed, { withMetadata: true }));
    expect((await attempts(c.sponsorshipId))[0].status).toBe("FAILED");
    // ...but a success for the same attempt then arrives (a later retry inside Checkout), and wins.
    sandbox.pay(sessionId);
    expect((await hook(sandbox.webhook("checkout-session.succeeded", sessionId))).body.result).toBe("APPLIED_PAID");
    expect((await row(c.sponsorshipId)).payment_status).toBe("PAID");
    // A stale FAILED / PENDING that arrives LATE never downgrades it.
    const late = sandbox.fail(sessionId);
    expect((await hook(sandbox.webhook("payment-intent.failed", sessionId, late, { withMetadata: true }))).body.result).toBe("IGNORED_STALE");
    const lateDeferred = sandbox.defer(sessionId);
    expect((await hook(sandbox.webhook("payment-intent.deferred", sessionId, lateDeferred, { withMetadata: true }))).body.result).toBe("IGNORED_STALE");
    expect((await row(c.sponsorshipId)).payment_status).toBe("PAID");
    expect(await paidEvents(c.sponsorshipId)).toHaveLength(1);
  });

  it("an event for a provider object we do not know is acknowledged safely: recorded, nothing changed", async () => {
    const c = await campaign();
    await pay(c);
    const stray = sandbox.pay(await sessionOf(c.sponsorshipId));
    const res = await hook({ type: "payment-intent.succeeded", data: { id: "pi_never_heard_of", mode: "test", amount: 5000, currency: "USD", status: "succeeded" } });
    expect([200, 500]).toContain(res.status); // verification against the provider fails (no such intent) → retryable, never applied
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");
    void stray;
    // An UNKNOWN but provider-verified intent (no attempt carries it): recorded as UNKNOWN_OBJECT, nothing changed.
    const other = new OnvoSandbox(KEY, "http://sandbox", "test");
    void other;
    const orphanSession = await provider.createPayment({ attemptId: randomUUID(), sponsorshipId: c.sponsorshipId, amountCents: 5000, currency: "USD", description: "x", customerEmail: null, successUrl: "https://a/s", cancelUrl: "https://a/c" });
    const orphanIntent = sandbox.pay(orphanSession.sessionId);
    const r2 = await hook({ type: "payment-intent.succeeded", data: { id: orphanIntent.id, mode: "test", amount: 5000, currency: "USD", status: "succeeded", metadata: {} } });
    expect(r2.body.result).toBe("UNKNOWN_OBJECT");
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");
  });

  it("a LIVE-mode event can never settle a TEST configuration", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    sandbox.pay(sessionId);
    const event = sandbox.webhook("checkout-session.succeeded", sessionId);
    (event.data as Record<string, unknown>).mode = "live";
    expect((await hook(event)).status).toBe(400);
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");
    // And at the database: a LIVE event for a TEST attempt is a recorded mismatch, not a payment.
    const [a] = await attempts(c.sponsorshipId);
    const r = await ok("commercial_payment_apply_result", { p_provider: "ONVO", p_environment: "LIVE", p_dedup_key: `t:${randomUUID()}`, p_event_type: "x", p_source: "WEBHOOK", p_attempt_id: a.id, p_session_id: null, p_payment_ref: null, p_outcome: "SUCCEEDED", p_amount_cents: 123400, p_currency: "USD", p_provider_status: "succeeded", p_failure_code: null });
    expect(r).toEqual({ result: "ENVIRONMENT_MISMATCH" } as never);
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");
  });

  it("events a sponsorship payment doesn't act on (mobile-transfer.received, subscriptions) are acknowledged and change nothing", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    expect(await hook(sandbox.webhook("mobile-transfer.received", sessionId))).toEqual({ status: 200, body: { received: true, result: "IGNORED" } });
    expect(await hook({ type: "subscription.renewal.succeeded", data: {} })).toEqual({ status: 200, body: { received: true, result: "IGNORED" } });
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");
  });

  it("an unconfigured deployment treats the webhook as absent (fail closed)", async () => {
    const off = new OnvoProvider({}, sandbox.fetcher);
    const res = await service.handleProviderWebhook(new Headers({ "x-webhook-secret": WH }), "{}", { provider: off, env: {} });
    expect(res.status).toBe(503);
  });
});

describe("the sponsorship invariant: payment is only ONE half", () => {
  it("A. pays first → PAID but not live; Super Admin approves → it runs", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    sandbox.pay(sessionId);
    await hook(sandbox.webhook("checkout-session.succeeded", sessionId));
    expect(await row(c.sponsorshipId)).toMatchObject({ payment_status: "PAID", lifecycle: "SUBMITTED", review_status: "PENDING" });
    expect((await loadPublicSponsorships([c.postId])).size).toBe(0);
    await approve(c);
    expect(["SCHEDULED", "LIVE"]).toContain((await row(c.sponsorshipId)).lifecycle);
    expect((await loadPublicSponsorships([c.postId])).get(c.postId)?.presentedBy).toBe("Acme Sports");
  });

  it("B. approved first → still not live while payment is unpaid, pending or failed; paying then puts it on the clock — payment never approved it", async () => {
    const c = await campaign({ approved: true });
    expect((await loadPublicSponsorships([c.postId])).size).toBe(0);
    await pay(c);
    expect((await row(c.sponsorshipId)).lifecycle).toBe("SUBMITTED"); // approved + payment pending: not live
    const sessionId = await sessionOf(c.sponsorshipId);
    const failed = sandbox.fail(sessionId);
    await hook(sandbox.webhook("payment-intent.failed", sessionId, failed, { withMetadata: true }));
    expect(await row(c.sponsorshipId)).toMatchObject({ payment_status: "FAILED", lifecycle: "SUBMITTED", review_status: "APPROVED" });
    expect((await loadPublicSponsorships([c.postId])).size).toBe(0); // approved + failed: not live
    sandbox.pay(sessionId);
    await hook(sandbox.webhook("checkout-session.succeeded", sessionId));
    expect(["SCHEDULED", "LIVE"]).toContain((await row(c.sponsorshipId)).lifecycle);
    expect((await loadPublicSponsorships([c.postId])).get(c.postId)?.presentedBy).toBe("Acme Sports");
  });

  it("a provider success can never approve anything: review status and approver are untouched", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    sandbox.pay(sessionId);
    await hook(sandbox.webhook("checkout-session.succeeded", sessionId));
    const { data } = await admin.from("sponsorships").select("review_status, approved_by, approved_at, approved_hash, lifecycle").eq("id", c.sponsorshipId).single();
    expect(data).toEqual({ review_status: "PENDING", approved_by: null, approved_at: null, approved_hash: null, lifecycle: "SUBMITTED" });
  });

  it("manual payment + approval behaves exactly as before", async () => {
    const c = await campaign({ approved: true });
    await ok("admin_mark_sponsorship_paid", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_reference: "INV-1", p_note: "bank transfer", p_idempotency_key: randomUUID() });
    expect(["SCHEDULED", "LIVE"]).toContain((await row(c.sponsorshipId)).lifecycle);
    const [ev] = await paidEvents(c.sponsorshipId);
    expect(ev).toMatchObject({ provider: "MANUAL", environment: null });
  });
});

describe("double payment and manual collision", () => {
  it("double-click / parallel tabs converge on ONE attempt and ONE provider session", async () => {
    const c = await campaign();
    const sharedKey: string = `same-${randomUUID()}`;
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => pay(c, i % 2 ? sharedKey : randomUUID())));
    expect(results.every((r) => r.status === "redirect")).toBe(true);
    expect(new Set(results.map((r) => (r.status === "redirect" ? r.url : ""))).size).toBe(1);
    expect(await attempts(c.sponsorshipId)).toHaveLength(1);
    expect(sandbox.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  it("clicking Pay again later reuses the same open session (it asks the provider where it stands first)", async () => {
    const c = await campaign();
    const first = await pay(c);
    const second = await pay(c);
    expect(first.status === "redirect" && second.status === "redirect" && first.url === second.url).toBe(true);
    expect(sandbox.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  it("if the session expired, the next click makes a NEW attempt and the old one stays on record", async () => {
    const c = await campaign();
    await pay(c);
    sandbox.expire(await sessionOf(c.sponsorshipId));
    const r = await pay(c);
    expect(r.status).toBe("redirect");
    expect((await attempts(c.sponsorshipId)).map((a) => a.status)).toEqual(["EXPIRED", "PENDING"]);
  });

  it("if the Sponsor already paid when they click Pay again, they are told so — no second session", async () => {
    const c = await campaign();
    await pay(c);
    sandbox.pay(await sessionOf(c.sponsorshipId));
    const r = await pay(c);
    expect(r).toEqual({ status: "paid" });
    expect((await row(c.sponsorshipId)).payment_status).toBe("PAID");
    expect(sandbox.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  it("Super Admin marks it paid manually while ONVO is pending: the open attempt is closed, and a LATER ONVO success is FLAGGED — never counted twice, never auto-refunded", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    await ok("admin_mark_sponsorship_paid", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_reference: "INV-X", p_note: "bank", p_idempotency_key: randomUUID() });
    expect((await attempts(c.sponsorshipId))[0].status).toBe("SUPERSEDED");
    sandbox.pay(sessionId);
    const res = await hook(sandbox.webhook("checkout-session.succeeded", sessionId));
    expect(res.body.result).toBe("DUPLICATE_PAYMENT");
    expect((await attempts(c.sponsorshipId))[0].status).toBe("DUPLICATE_PAYMENT");
    expect(await paidEvents(c.sponsorshipId)).toHaveLength(1); // the manual one only
    expect((await admin.from("sponsorship_payment_events").select("event_type").eq("sponsorship_id", c.sponsorshipId).in("event_type", ["REFUND_PENDING", "REFUNDED"])).data).toEqual([]);
    expect((await admin.from("audit_logs").select("action").eq("entity_id", c.sponsorshipId).eq("action", "sponsorship.duplicate_payment_detected")).data).toHaveLength(1);
    expect((await row(c.sponsorshipId)).payment_status).toBe("PAID");
  });

  it("two attempts can never BOTH satisfy a sponsorship (database constraint)", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    sandbox.pay(sessionId);
    await hook(sandbox.webhook("checkout-session.succeeded", sessionId));
    const second = await admin.from("commercial_payment_attempts").insert({ sponsorship_id: c.sponsorshipId, sponsor_id: c.sponsor.sponsorId, provider: "ONVO", environment: "TEST", status: "SUCCEEDED", amount_cents: 123400, currency: "USD", idempotency_key: randomUUID() });
    expect(second.error).not.toBeNull();
    const openTwice = await admin.from("commercial_payment_attempts").insert([{ sponsorship_id: c.sponsorshipId, sponsor_id: c.sponsor.sponsorId, provider: "ONVO", environment: "TEST", status: "PENDING", amount_cents: 123400, currency: "USD", idempotency_key: randomUUID() }, { sponsorship_id: c.sponsorshipId, sponsor_id: c.sponsor.sponsorId, provider: "ONVO", environment: "TEST", status: "CREATED", amount_cents: 123400, currency: "USD", idempotency_key: randomUUID() }]);
    expect(openTwice.error).not.toBeNull();
  });
});

describe("reconciliation", () => {
  it("when the webhook never arrived, reconciling reads the provider and PAYS — once; repeating is harmless", async () => {
    const c = await campaign();
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    sandbox.pay(a.provider_session_id);
    const first = await service.reconcileAttempt(a.id, { provider, env: {} });
    expect(first).toMatchObject({ providerOutcome: "SUCCEEDED", applied: "APPLIED_PAID" });
    expect((await row(c.sponsorshipId)).payment_status).toBe("PAID");
    const again = await service.reconcileAttempt(a.id, { provider, env: {} });
    expect(again.applied).toBe("DUPLICATE");
    expect(await paidEvents(c.sponsorshipId)).toHaveLength(1);
  });

  it("reconciling a still-open session changes nothing; an expired one is recorded EXPIRED", async () => {
    const c = await campaign();
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    expect((await service.reconcileAttempt(a.id, { provider, env: {} })).providerOutcome).toBe("PENDING");
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");
    sandbox.expire(a.provider_session_id);
    expect((await service.reconcileAttempt(a.id, { provider, env: {} })).providerOutcome).toBe("EXPIRED");
    expect((await attempts(c.sponsorshipId))[0].status).toBe("EXPIRED");
  });

  it("a provider that cannot be reached during reconciliation guesses nothing", async () => {
    const c = await campaign();
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    sandbox.failNext(/GET \/v1\/checkout\/sessions/, "network");
    await expect(service.reconcileAttempt(a.id, { provider, env: {} })).rejects.toBeTruthy();
    expect((await row(c.sponsorshipId)).payment_status).toBe("PENDING");
  });
});

describe("refunds: Brohda's policy decides WHETHER; the provider is only a METHOD", () => {
  async function paidThroughOnvo() {
    const c = await campaign();
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    sandbox.pay(a.provider_session_id);
    await service.reconcileAttempt(a.id, { provider, env: {} });
    return { ...c, attemptId: a.id as string };
  }

  it("a confirmed provider refund → REFUNDED (and only then); a duplicate refund is refused", async () => {
    const c = await paidThroughOnvo();
    const r = await service.refundThroughProvider(c.adminId, c.attemptId, { provider, env: {} });
    expect(r).toMatchObject({ status: "succeeded", manualFallback: false });
    expect((await row(c.sponsorshipId)).payment_status).toBe("REFUNDED");
    expect((await attempts(c.sponsorshipId))[0].refunded_at).toBeTruthy();
    await expect(service.refundThroughProvider(c.adminId, c.attemptId, { provider, env: {} })).rejects.toBeTruthy();
    expect(sandbox.requests.filter((q) => q.path === "/v1/refunds" && q.method === "POST")).toHaveLength(1); // the second never reached the provider
    expect((await admin.from("sponsorship_payment_events").select("event_type").eq("sponsorship_id", c.sponsorshipId).eq("event_type", "REFUNDED")).data).toHaveLength(1);
  });

  it("a PENDING provider refund is REFUND_PENDING, not REFUNDED, until the provider confirms (reconcile)", async () => {
    const c = await paidThroughOnvo();
    sandbox.refundBehavior = "pending";
    const r = await service.refundThroughProvider(c.adminId, c.attemptId, { provider, env: {} });
    expect(r.status).toBe("pending");
    expect((await row(c.sponsorshipId)).payment_status).toBe("REFUND_PENDING");
    const { data: refund } = await admin.from("commercial_payment_refunds").select("*").eq("attempt_id", c.attemptId).single();
    sandbox.refunds.get(refund!.provider_refund_id)!.status = "succeeded";
    const done = await service.reconcileRefund(c.adminId, refund!.id, { provider, env: {} });
    expect(done.status).toBe("succeeded");
    expect((await row(c.sponsorshipId)).payment_status).toBe("REFUNDED");
  });

  it("a REFUSED provider refund marks nothing refunded and leaves the manual fallback — which still works", async () => {
    const c = await paidThroughOnvo();
    sandbox.refundBehavior = "reject";
    const r = await service.refundThroughProvider(c.adminId, c.attemptId, { provider, env: {} });
    expect(r).toMatchObject({ status: "failed", manualFallback: true });
    expect((await row(c.sponsorshipId)).payment_status).toBe("PAID");
    expect((await admin.from("commercial_payment_refunds").select("status").eq("attempt_id", c.attemptId)).data).toEqual([{ status: "FAILED" }]);
    // Manual refund remains available and unchanged.
    const manual = await ok("admin_record_sponsorship_payment_event", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_event: "REFUNDED", p_reference: "bank", p_note: "manual refund", p_idempotency_key: randomUUID() });
    expect(manual.payment_status).toBe("REFUNDED");
  });

  it("an unknown outcome (network) is recorded as such and never as refunded", async () => {
    const c = await paidThroughOnvo();
    sandbox.failNext(/POST \/v1\/refunds/, "network");
    const r = await service.refundThroughProvider(c.adminId, c.attemptId, { provider, env: {} });
    expect(r.status).toBe("failed");
    expect((await admin.from("commercial_payment_refunds").select("failure_code").eq("attempt_id", c.attemptId)).data).toEqual([{ failure_code: "unknown_outcome" }]);
    expect((await row(c.sponsorshipId)).payment_status).toBe("PAID");
  });

  it("only Super Admin can refund; suspension, cancellation and Sponsor suspension never refund by themselves", async () => {
    const c = await paidThroughOnvo();
    const ordinary = await seedUser("onvoordinary");
    await admin.from("user_profiles").update({ role: "admin" }).eq("id", ordinary);
    staffIds.push(ordinary);
    await expect(service.refundThroughProvider(ordinary, c.attemptId, { provider, env: {} })).rejects.toBeTruthy();
    await ok("admin_set_sponsor_status", { p_admin_id: c.adminId, p_sponsor_id: c.sponsor.sponsorId, p_status: "SUSPENDED", p_reason: "review", p_internal_note: null });
    await ok("admin_cancel_sponsorship", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_reason: "x", p_cause: "BROHDA_CANCELLED_NO_BREACH" });
    expect((await row(c.sponsorshipId)).payment_status).toBe("PAID");
    expect(sandbox.requests.filter((q) => q.path === "/v1/refunds")).toHaveLength(0);
    expect((await admin.from("commercial_payment_refunds").select("id").eq("attempt_id", c.attemptId)).data).toEqual([]);
  });
});

describe("authorization and isolation", () => {
  it("Sponsors, Members and the public cannot read or write payment records or call the payment functions", async () => {
    const c = await campaign();
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    const as = async (email: string) => {
      const cl = getTestAnonClient();
      expect((await cl.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
      return cl;
    };
    const sponsorClient = await as(c.sponsor.email);
    for (const table of ["commercial_payment_attempts", "commercial_payment_provider_events", "commercial_payment_refunds"]) expect((await sponsorClient.from(table).select("*")).data ?? [], table).toEqual([]);
    expect((await sponsorClient.from("commercial_payment_attempts").update({ status: "SUCCEEDED" }).eq("id", a.id)).error ?? { x: 1 }).toBeTruthy();
    expect((await admin.from("commercial_payment_attempts").select("status").eq("id", a.id).single()).data!.status).toBe("PENDING");
    expect((await sponsorClient.from("commercial_payment_attempts").insert({ sponsorship_id: c.sponsorshipId, sponsor_id: c.sponsor.sponsorId, provider: "ONVO", environment: "TEST", status: "SUCCEEDED", amount_cents: 1, currency: "USD", idempotency_key: randomUUID() })).error).not.toBeNull();
    for (const fn of ["commercial_payment_begin", "commercial_payment_apply_result", "commercial_payment_attach", "commercial_refund_begin", "sponsorship_settle_payment"]) {
      expect((await sponsorClient.rpc(fn, {})).error, fn).not.toBeNull();
      expect((await getTestAnonClient().rpc(fn, {})).error, fn).not.toBeNull();
    }
    const other = await seedSponsorAccount("othersponsor");
    expect(((await (await as(other.email)).from("commercial_payment_attempts").select("id")).data ?? [])).toEqual([]);
    const member = await seedUser("onvoreader");
    const memberEmail = (await admin.auth.admin.getUserById(member)).data.user!.email!;
    expect(((await (await as(memberEmail)).from("commercial_payment_attempts").select("id")).data ?? [])).toEqual([]);
    // Super Admin reads them.
    const superEmail = (await admin.auth.admin.getUserById(c.adminId)).data.user!.email!;
    expect(((await (await as(superEmail)).from("commercial_payment_attempts").select("id")).data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("a Sponsor's payment flow creates no Member data (MEMBER xor SPONSOR holds)", async () => {
    const c = await campaign();
    await pay(c);
    sandbox.pay(await sessionOf(c.sponsorshipId));
    await hook(sandbox.webhook("checkout-session.succeeded", await sessionOf(c.sponsorshipId)));
    expect((await admin.from("user_profiles").select("id").eq("id", c.sponsor.userId)).data).toEqual([]);
    expect((await admin.from("account_types").select("account_type").eq("user_id", c.sponsor.userId).single()).data!.account_type).toBe("SPONSOR");
  });

  it("the ledger and the attempt record hold no card data or secrets", async () => {
    const c = await campaign();
    await pay(c);
    const sessionId = await sessionOf(c.sponsorshipId);
    sandbox.pay(sessionId);
    await hook(sandbox.webhook("checkout-session.succeeded", sessionId));
    const dump = JSON.stringify([(await attempts(c.sponsorshipId)), (await admin.from("commercial_payment_provider_events").select("*")).data]);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain(WH);
    expect(dump).not.toMatch(/\b\d{13,19}\b/); // no card-number-like digits
  });
});
