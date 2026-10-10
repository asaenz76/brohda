/**
 * Provider selection is OPERATIONAL CONFIGURATION. A real second adapter is not needed to prove it: a fake provider (tests only) is installed through the production registry and
 * selected through the production platform setting, and Sponsor payments are driven ONVO → fake → disabled → ONVO with no source edit between steps. Also proved: unknown or
 * unconfigured providers fail closed (never a silent fallback), history stays with the provider that processed it, an open attempt is never converted to another provider, and
 * disabling stops only NEW online payments while manual payment, webhooks and reconciliation keep working. Payment still never approves a sponsorship.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";
import { seedGame, seedSponsorAccount, seedUser } from "./helpers/game-seed";
import { OnvoSandbox } from "../helpers/onvo-sandbox";
import { FakeProvider } from "../helpers/fake-provider";
import { OnvoProvider } from "@/lib/payments/onvo/adapter";
import { clearTestAdapters, isRegisteredProvider, registeredProviders, registerTestAdapter } from "@/lib/payments/registry";
import { loadPublicSponsorships } from "@/lib/sponsorship/public";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const admin = getTestAdminClient();
const HOUR = 3_600_000;
const KEY = "onvo_test_secret_key_integration";
const WH = "webhook_secret_integration";
const ENV = { ONVO_SECRET_KEY: KEY, ONVO_WEBHOOK_SECRET: WH, ONVO_ENVIRONMENT: "TEST" };
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let service: typeof import("@/lib/payments/service");
let active: typeof import("@/lib/payments/active-provider");
let sandbox: OnvoSandbox;
let onvo: OnvoProvider;
let fake: FakeProvider;
const staffIds: string[] = [];

beforeAll(async () => {
  const cfg = getTestSupabaseConfig();
  process.env.NEXT_PUBLIC_SUPABASE_URL = cfg.url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = cfg.anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = cfg.serviceRoleKey;
  service = await import("@/lib/payments/service");
  active = await import("@/lib/payments/active-provider");
});
beforeEach(() => {
  sandbox = new OnvoSandbox(KEY, "http://sandbox", "test");
  onvo = new OnvoProvider({ ...ENV }, sandbox.fetcher);
  fake = new FakeProvider();
  clearTestAdapters();
  registerTestAdapter(onvo);
  registerTestAdapter(fake);
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
let adminId: string;
async function superAdmin() {
  if (adminId) return adminId;
  adminId = await seedUser("cfgadmin");
  await admin.from("user_profiles").update({ role: "super_admin" }).eq("id", adminId);
  staffIds.push(adminId);
  return adminId;
}
/** What the Super Admin card does: one audited call. */
const configure = async (provider: string | null) => {
  const id = await superAdmin();
  return rpc("admin_set_online_payment_config", { p_admin_id: id, p_enabled: provider !== null, p_provider: provider });
};

async function campaign(opts: { approved?: boolean } = {}) {
  const id = await superAdmin();
  await admin.from("platform_settings").update({ sponsorship_enabled: true }).eq("id", true);
  const sponsor = await seedSponsorAccount("cfg");
  const { fixtureId } = await seedGame({ startsInMinutes: 24 * 60 });
  const { data: post } = await admin.from("posts").insert({ fixture_id: fixtureId, published_at: new Date().toISOString() }).select("id").single();
  const inv = await ok("admin_set_sponsorship_inventory", { p_admin_id: id, p_post_id: post!.id, p_market_code: "GLOBAL", p_is_sponsorable: true, p_price_cents: 50000, p_currency: "USD", p_starts_at: new Date(Date.now() - HOUR).toISOString(), p_ends_at: new Date(Date.now() + 30 * HOUR).toISOString() });
  const created = await ok("sponsor_create_sponsorship", { p_user_id: sponsor.userId, p_sponsor_id: sponsor.sponsorId, p_inventory_id: inv.id, p_campaign_name: "Cfg" });
  await ok("sponsor_update_sponsorship", { p_user_id: sponsor.userId, p_id: created.id, p_fields: { presented_by: "Acme Sports", tagline: "Fuel the game", cta_text: "Learn more", destination_url: "https://acme.example.com/promo" } });
  await ok("sponsor_submit_sponsorship", { p_user_id: sponsor.userId, p_id: created.id });
  const c = { adminId: id, sponsor, sponsorshipId: created.id as string, postId: post!.id as string };
  if (opts.approved) {
    const { data } = await admin.from("sponsorships").select("revision").eq("id", c.sponsorshipId).single();
    await ok("admin_approve_sponsorship", { p_admin_id: id, p_id: c.sponsorshipId, p_expected_revision: data!.revision });
  }
  return c;
}
const urls = { successUrl: "https://app.test/return?result=success", cancelUrl: "https://app.test/return?result=cancel" };
const pay = (c: { sponsor: { userId: string }; sponsorshipId: string }) => service.startSponsorPayment({ userId: c.sponsor.userId, sponsorshipId: c.sponsorshipId, idempotencyKey: randomUUID(), customerEmail: "biz@test.local", description: "Sponsored Game Post", ...urls }, { env: {} });
const attempts = async (id: string) => (await admin.from("commercial_payment_attempts").select("*").eq("sponsorship_id", id).order("created_at")).data!;
const row = async (id: string) => (await admin.from("sponsorships").select("lifecycle, payment_status, review_status").eq("id", id).single()).data!;
const onvoHook = (sessionId: string) => {
  const intent = sandbox.pay(sessionId);
  void intent;
  return service.handleProviderWebhook("ONVO", new Headers({ "content-type": "application/json", "X-Webhook-Secret": WH }), JSON.stringify(sandbox.webhook("checkout-session.succeeded", sessionId)));
};
const fakeHook = (sessionId: string, outcome: string) => service.handleProviderWebhook("TEST_PROVIDER", new Headers({ "x-fake-secret": fake.secret }), JSON.stringify({ sessionId, outcome }));

describe("the registry and the stored provider key", () => {
  it("knows exactly the installed adapters; an unknown key is simply not found", () => {
    expect(registeredProviders().map((p) => p.key)).toEqual(["ONVO", "TEST_PROVIDER"]);
    expect(isRegisteredProvider("ONVO")).toBe(true);
    expect(isRegisteredProvider("FOOBAR")).toBe(false);
    expect(isRegisteredProvider(null)).toBe(false);
    expect(isRegisteredProvider("constructor")).toBe(false); // never resolved through the object prototype
  });

  it("the database stores any WELL-FORMED provider key (no ONVO-only constraint) and refuses malformed ones", async () => {
    const good = await configure("TEST_PROVIDER");
    expect(good.error).toBeNull();
    for (const bad of ["onvo", "has space", "X", "1ONVO", "A".repeat(41), "DROP;TABLE"]) {
      const r = await configure(bad);
      expect(r.error?.message, bad).toMatch(/invalid_provider/);
    }
    const enabledNoProvider = await rpc("admin_set_online_payment_config", { p_admin_id: await superAdmin(), p_enabled: true, p_provider: null });
    expect(enabledNoProvider.error?.message).toMatch(/provider_required/);
  });

  it("only a Super Admin can change it", async () => {
    const member = await seedUser("cfgmember");
    const r = await rpc("admin_set_online_payment_config", { p_admin_id: member, p_enabled: true, p_provider: "ONVO" });
    expect(r.error).not.toBeNull();
  });

  it("every change is audited with the previous and new provider, the enabled flag, the actor and the time — and nothing secret", async () => {
    await configure(null);
    await configure("ONVO");
    await configure("TEST_PROVIDER");
    const { data } = await admin.from("audit_logs").select("actor_id, before, after, created_at, action").eq("action", "settings.online_payments_updated").order("created_at", { ascending: false }).limit(2);
    expect(data![0]).toMatchObject({ actor_id: adminId, before: { enabled: true, provider: "ONVO" }, after: { enabled: true, provider: "TEST_PROVIDER" } });
    expect(data![0].created_at).toBeTruthy();
    expect(JSON.stringify(data)).not.toMatch(/secret|key/i);
    // saving the same value again records nothing new
    const n = (await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "settings.online_payments_updated")).count;
    await configure("TEST_PROVIDER");
    expect((await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("action", "settings.online_payments_updated")).count).toBe(n);
  });
});

describe("disabled, selected, unknown and unconfigured", () => {
  it("DISABLED: no online payment is offered or can be started; nothing reaches any provider", async () => {
    await configure(null);
    expect(await active.resolveOnlinePayment({})).toEqual({ state: "disabled" });
    const c = await campaign();
    await expect(pay(c)).rejects.toMatchObject({ code: "unavailable" });
    expect(sandbox.requests).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(await attempts(c.sponsorshipId)).toHaveLength(0);
  });

  it("ONVO selected → the attempt is created through ONVO and snapshots 'ONVO'", async () => {
    await configure("ONVO");
    const c = await campaign();
    const r = await pay(c);
    expect(r.status).toBe("redirect");
    expect((await attempts(c.sponsorshipId))[0]).toMatchObject({ provider: "ONVO", environment: "TEST" });
    expect(fake.calls).toHaveLength(0);
  });

  it("fake provider selected → the SAME code path creates the attempt through the fake adapter (no source edit)", async () => {
    await configure("TEST_PROVIDER");
    const c = await campaign();
    const r = await pay(c);
    expect(r).toMatchObject({ status: "redirect" });
    if (r.status === "redirect") expect(r.url).toMatch(/^https:\/\/fake\.test\/pay\//);
    expect((await attempts(c.sponsorshipId))[0]).toMatchObject({ provider: "TEST_PROVIDER", environment: "TEST", amount_cents: 50000 });
    expect(sandbox.requests).toHaveLength(0);
  });

  it("an UNKNOWN provider key in the database fails closed: unavailable, never a fallback to another provider", async () => {
    await admin.from("platform_settings").update({ sponsorship_online_payments_enabled: true, sponsorship_online_payment_provider: "FOOBAR" }).eq("id", true);
    const state = await active.resolveOnlinePayment({});
    expect(state).toMatchObject({ state: "unavailable", providerKey: "FOOBAR" });
    const c = await campaign();
    await expect(pay(c)).rejects.toMatchObject({ code: "unavailable" });
    expect(sandbox.requests).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("a selected provider with missing credentials is unavailable (and not offered) — it does not fall back", async () => {
    await configure("TEST_PROVIDER");
    fake.configured = false;
    expect(await active.resolveOnlinePayment({})).toMatchObject({ state: "unavailable", providerKey: "TEST_PROVIDER" });
    const c = await campaign();
    await expect(pay(c)).rejects.toMatchObject({ code: "unavailable" });
    registerTestAdapter(new OnvoProvider({}, sandbox.fetcher));
    await configure("ONVO");
    expect(await active.resolveOnlinePayment({})).toMatchObject({ state: "unavailable", providerKey: "ONVO" });
  });

  it("a provider that can't take checkout payments is not offered, whatever the setting says", async () => {
    fake.capabilities = { ...fake.capabilities, supportsCheckout: false };
    await configure("TEST_PROVIDER");
    expect(await active.resolveOnlinePayment({})).toMatchObject({ state: "unavailable" });
  });
});

describe("switching without a deploy: ONVO → fake → disabled → ONVO", () => {
  it("each step takes effect on the next payment, with the setting alone", async () => {
    const providers: string[] = [];
    for (const choice of ["ONVO", "TEST_PROVIDER", null, "ONVO"] as const) {
      await configure(choice);
      const c = await campaign();
      if (choice === null) {
        await expect(pay(c)).rejects.toMatchObject({ code: "unavailable" });
        providers.push("none");
      } else {
        await pay(c);
        providers.push((await attempts(c.sponsorshipId))[0].provider);
      }
    }
    expect(providers).toEqual(["ONVO", "TEST_PROVIDER", "none", "ONVO"]);
  });
});

describe("history belongs to the provider that processed it", () => {
  it("an ONVO attempt created before the switch is still reconciled, webhooked and refunded through ONVO — even with the fake provider selected or payments disabled", async () => {
    await configure("ONVO");
    const c = await campaign();
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    await configure("TEST_PROVIDER"); // switch while the ONVO attempt is open

    // a late ONVO webhook is verified by ONVO's adapter and settles the attempt
    expect(await onvoHook(a.provider_session_id)).toMatchObject({ status: 200 });
    expect((await row(c.sponsorshipId)).payment_status).toBe("PAID");
    expect(fake.calls).toHaveLength(0);

    await configure(null); // and with online payments disabled, the refund still goes through ONVO
    const r = await service.refundThroughProvider(c.adminId, a.id);
    expect(r).toMatchObject({ status: "succeeded" });
    expect(sandbox.requests.some((q) => q.path === "/v1/refunds" && q.method === "POST")).toBe(true);
    expect(fake.calls).not.toContain("refundPayment");
    expect((await attempts(c.sponsorshipId))[0].provider).toBe("ONVO"); // never reinterpreted
  });

  it("reconciling a historical attempt uses its own provider's adapter", async () => {
    await configure("ONVO");
    const c = await campaign();
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    sandbox.pay(a.provider_session_id);
    await configure("TEST_PROVIDER");
    expect(await service.reconcileAttempt(a.id)).toMatchObject({ providerOutcome: "SUCCEEDED", applied: "APPLIED_PAID" });
    expect(fake.calls).toHaveLength(0);
  });

  it("a provider that isn't installed in this deployment can't be reconciled or refunded (and says so) — nothing is guessed", async () => {
    await configure("TEST_PROVIDER");
    const c = await campaign();
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    await admin.from("commercial_payment_attempts").update({ provider: "RETIRED_PROVIDER" }).eq("id", a.id);
    await expect(service.reconcileAttempt(a.id)).rejects.toMatchObject({ code: "unavailable" });
    await expect(service.refundThroughProvider(c.adminId, a.id)).rejects.toMatchObject({ code: "unavailable" });
    expect((await service.handleProviderWebhook("RETIRED_PROVIDER", new Headers(), "{}")).status).toBe(503);
  });

  it("a provider without a refund capability is never asked to refund", async () => {
    await configure("TEST_PROVIDER");
    const c = await campaign();
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    fake.settle(a.provider_session_id, "SUCCEEDED");
    await service.reconcileAttempt(a.id);
    fake.capabilities = { ...fake.capabilities, supportsRefund: false };
    await expect(service.refundThroughProvider(c.adminId, a.id)).rejects.toMatchObject({ code: "unavailable" });
    expect(fake.calls).not.toContain("refundPayment");
  });
});

describe("an open attempt is never converted to another provider", () => {
  it("while the ONVO attempt is open, a Sponsor can't start a payment with the newly selected provider", async () => {
    await configure("ONVO");
    const c = await campaign();
    await pay(c);
    await configure("TEST_PROVIDER");
    await expect(pay(c)).rejects.toMatchObject({ code: "in_progress_other_provider" });
    const rows = await attempts(c.sponsorshipId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "ONVO", status: "PENDING" });
    expect(fake.calls).toHaveLength(0);
  });

  it("once the old attempt has ended at its own provider (expired), the new provider can take over — the old one stays on record", async () => {
    await configure("ONVO");
    const c = await campaign();
    await pay(c);
    const [old] = await attempts(c.sponsorshipId);
    sandbox.expire(old.provider_session_id);
    await configure("TEST_PROVIDER");
    expect(await pay(c)).toMatchObject({ status: "redirect" });
    const rows = await attempts(c.sponsorshipId);
    expect(rows.map((r) => [r.provider, r.status])).toEqual([["ONVO", "EXPIRED"], ["TEST_PROVIDER", "PENDING"]]);
  });

  it("Super Admin can cancel the open attempt explicitly (audited); the new provider then proceeds, and a late success of the cancelled one is still recognised", async () => {
    await configure("ONVO");
    const c = await campaign();
    await pay(c);
    const [old] = await attempts(c.sponsorshipId);
    await configure("TEST_PROVIDER");
    await service.cancelOpenAttempt(c.adminId, old.id);
    expect((await attempts(c.sponsorshipId))[0].status).toBe("CANCELLED");
    const { data: audit } = await admin.from("audit_logs").select("actor_id, after").eq("action", "sponsorship.payment_attempt_cancelled").eq("entity_id", c.sponsorshipId);
    expect(audit).toEqual([{ actor_id: c.adminId, after: { attemptId: old.id, provider: "ONVO" } }]);
    expect(await pay(c)).toMatchObject({ status: "redirect" });
    expect((await attempts(c.sponsorshipId)).map((r) => r.provider)).toEqual(["ONVO", "TEST_PROVIDER"]);
  });

  it("only a Super Admin can cancel, and only an OPEN attempt", async () => {
    await configure("TEST_PROVIDER");
    const c = await campaign();
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    const r = await rpc("commercial_payment_cancel_attempt", { p_admin_id: c.sponsor.userId, p_attempt_id: a.id });
    expect(r.error).not.toBeNull();
    fake.settle(a.provider_session_id, "SUCCEEDED");
    await service.reconcileAttempt(a.id);
    await service.cancelOpenAttempt(c.adminId, a.id).catch(() => undefined);
    expect((await attempts(c.sponsorshipId))[0].status).toBe("SUCCEEDED"); // a settled payment is never cancelled
  });
});

describe("disabling stops only NEW online payments", () => {
  it("an open attempt keeps receiving its provider's webhook after online payments are disabled", async () => {
    await configure("ONVO");
    const c = await campaign();
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    await configure(null);
    await expect(pay(c)).rejects.toMatchObject({ code: "unavailable" });
    expect(await onvoHook(a.provider_session_id)).toMatchObject({ status: 200 });
    expect((await row(c.sponsorshipId)).payment_status).toBe("PAID");
  });

  it("manual payment is independent of the setting", async () => {
    await configure(null);
    const c = await campaign({ approved: true });
    await ok("admin_mark_sponsorship_paid", { p_admin_id: c.adminId, p_id: c.sponsorshipId, p_reference: "INV-1", p_note: "bank transfer", p_idempotency_key: randomUUID() });
    expect(["SCHEDULED", "LIVE"]).toContain((await row(c.sponsorshipId)).lifecycle);
  });
});

describe("the sponsorship invariant holds for any provider: PAID + Super Admin approval", () => {
  it("a payment through the fake provider marks PAID and nothing else — never approval, never live", async () => {
    await configure("TEST_PROVIDER");
    const c = await campaign();
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    fake.settle(a.provider_session_id, "SUCCEEDED");
    expect(await fakeHook(a.provider_session_id, "SUCCEEDED")).toMatchObject({ status: 200 });
    const { data } = await admin.from("sponsorships").select("review_status, approved_by, lifecycle, payment_status").eq("id", c.sponsorshipId).single();
    expect(data).toEqual({ review_status: "PENDING", approved_by: null, lifecycle: "SUBMITTED", payment_status: "PAID" });
    expect((await loadPublicSponsorships([c.postId])).size).toBe(0);
  });

  it("approved first, then paid through the fake provider → on the clock; approval is still what made it eligible", async () => {
    await configure("TEST_PROVIDER");
    const c = await campaign({ approved: true });
    expect((await loadPublicSponsorships([c.postId])).size).toBe(0);
    await pay(c);
    const [a] = await attempts(c.sponsorshipId);
    fake.settle(a.provider_session_id, "SUCCEEDED");
    await fakeHook(a.provider_session_id, "SUCCEEDED");
    expect(["SCHEDULED", "LIVE"]).toContain((await row(c.sponsorshipId)).lifecycle);
  });

  it("a forged delivery for the fake provider is rejected before anything is read", async () => {
    await configure("TEST_PROVIDER");
    const res = await service.handleProviderWebhook("TEST_PROVIDER", new Headers({ "x-fake-secret": "wrong" }), JSON.stringify({ sessionId: "x", outcome: "SUCCEEDED" }));
    expect(res.status).toBe(401);
  });
});
