import { describe, expect, it, vi } from "vitest";
import { fromProviderAmount, formatMinor, isProviderSupportedCurrency, toProviderAmount, UnsupportedCurrencyError } from "@/lib/payments/amount";
import { checkoutOffered, isProductionDeployment } from "@/lib/payments/config";
import { onvoAvailability, resolveOnvoConfig } from "@/lib/payments/onvo/config";
import { parseOnvoWebhook, secretMatches, sessionIdFromUrl } from "@/lib/payments/onvo/webhook";
import { OnvoClient, OnvoError } from "@/lib/payments/onvo/client";
import { OnvoProvider } from "@/lib/payments/onvo/adapter";
import { OnvoSandbox } from "../../helpers/onvo-sandbox";

vi.mock("server-only", () => ({}));

const TEST_KEY = "onvo_test_secret_key_abc123";
const LIVE_KEY = "onvo_live_secret_key_abc123";
const WH = "webhook_secret_xyz";
const good = { ONVO_SECRET_KEY: TEST_KEY, ONVO_WEBHOOK_SECRET: WH, ONVO_ENVIRONMENT: "TEST" };

describe("amounts: ONE canonical conversion", () => {
  it("minor units pass through exactly for every supported currency, and only whole positive numbers are accepted", () => {
    expect(toProviderAmount(250000, "CRC")).toBe(250000);
    expect(toProviderAmount(150, "USD")).toBe(150);
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity]) expect(() => toProviderAmount(bad, "USD"), String(bad)).toThrow(RangeError);
  });
  it("an unsupported currency is refused, never guessed", () => {
    expect(() => toProviderAmount(100, "EUR")).toThrow(UnsupportedCurrencyError);
    expect(isProviderSupportedCurrency("EUR")).toBe(false);
    expect(isProviderSupportedCurrency("CRC")).toBe(true);
  });
  it("reads provider amounts back strictly (no floats, no zero, no strings)", () => {
    expect(fromProviderAmount(500000, "CRC")).toBe(500000);
    for (const bad of [0, -5, 10.5, "500", null, undefined, Number.NaN]) expect(fromProviderAmount(bad, "CRC"), String(bad)).toBeNull();
    expect(fromProviderAmount(100, "EUR")).toBeNull();
  });
  it("formats for display with the currency's own exponent", () => {
    expect(formatMinor(210089, "CRC")).toBe("2100.89");
    expect(formatMinor(150, "USD")).toBe("1.50");
  });
  it("rounding: a cents total never drifts through the round trip", () => {
    for (const cents of [1, 99, 100, 101, 199999, 2147483, 123456789]) expect(fromProviderAmount(toProviderAmount(cents, "USD"), "USD")).toBe(cents);
  });
});

describe("configuration fails closed", () => {
  it("a good TEST configuration is TEST", () => {
    expect(onvoAvailability(good)).toEqual({ state: "test", environment: "TEST" });
    const r = resolveOnvoConfig(good);
    expect(r.ok && r.config.apiBase).toBe("https://api.onvopay.com");
  });
  it("missing key / webhook secret / declared environment → unavailable (each separately)", () => {
    expect(onvoAvailability({}).state).toBe("unavailable");
    expect(onvoAvailability({ ...good, ONVO_SECRET_KEY: undefined }).state).toBe("unavailable");
    expect(onvoAvailability({ ...good, ONVO_WEBHOOK_SECRET: undefined }).state).toBe("unavailable");
    expect(onvoAvailability({ ...good, ONVO_ENVIRONMENT: undefined }).state).toBe("unavailable");
    expect(onvoAvailability({ ...good, ONVO_SECRET_KEY: "sk_whatever" }).state).toBe("unavailable");
  });
  it("the declared environment must agree with the key", () => {
    expect(onvoAvailability({ ...good, ONVO_ENVIRONMENT: "LIVE" }).state).toBe("unavailable");
    expect(onvoAvailability({ ...good, ONVO_SECRET_KEY: LIVE_KEY, ONVO_ENVIRONMENT: "TEST", ONVO_LIVE_ENABLED: "true" }).state).toBe("unavailable");
  });
  it("a LIVE key alone does NOT turn live payments on; it needs the explicit enablement", () => {
    const live = { ...good, ONVO_SECRET_KEY: LIVE_KEY, ONVO_ENVIRONMENT: "LIVE" };
    expect(onvoAvailability(live).state).toBe("unavailable");
    expect(onvoAvailability({ ...live, ONVO_LIVE_ENABLED: "yes" }).state).toBe("unavailable");
    expect(onvoAvailability({ ...live, ONVO_LIVE_ENABLED: "true" })).toEqual({ state: "live", environment: "LIVE" });
  });
  it("the API base must be https (a local http sandbox is allowed only for a TEST key)", () => {
    expect(onvoAvailability({ ...good, ONVO_API_BASE: "http://api.example.com" }).state).toBe("unavailable");
    expect(onvoAvailability({ ...good, ONVO_API_BASE: "http://127.0.0.1:54399" }).state).toBe("test");
    expect(onvoAvailability({ ...good, ONVO_SECRET_KEY: LIVE_KEY, ONVO_ENVIRONMENT: "LIVE", ONVO_LIVE_ENABLED: "true", ONVO_API_BASE: "http://127.0.0.1:54399" }).state).toBe("unavailable");
  });
  it("TEST checkout is never offered to Sponsors on the production deployment unless explicitly authorized there", () => {
    expect(isProductionDeployment({ VERCEL_ENV: "production" })).toBe(true);
    expect(isProductionDeployment({ VERCEL_ENV: "preview" })).toBe(false);
    expect(checkoutOffered({ state: "test", environment: "TEST" }, { VERCEL_ENV: "production" })).toBe(false);
    expect(checkoutOffered({ state: "test", environment: "TEST" }, { VERCEL_ENV: "production", PAYMENTS_ALLOW_TEST_IN_PRODUCTION: "true" })).toBe(true);
    expect(checkoutOffered({ state: "test", environment: "TEST" }, { VERCEL_ENV: "preview" })).toBe(true);
    expect(checkoutOffered({ state: "unavailable", reason: "x" }, {})).toBe(false);
  });
});

describe("webhook authentication and translation", () => {
  const sandbox = new OnvoSandbox(TEST_KEY, "http://sandbox", "test");
  const parse = (secret: string | null, body: unknown, env: "TEST" | "LIVE" = "TEST") => {
    const h = new Headers();
    if (secret !== null) h.set("X-Webhook-Secret", secret);
    return parseOnvoWebhook(h, typeof body === "string" ? body : JSON.stringify(body), WH, env);
  };
  const session = () => {
    const s = sandbox.sessions.size;
    void s;
    return null;
  };
  void session;

  it("compares the secret in constant time and rejects missing / wrong / different-length secrets", () => {
    expect(secretMatches(WH, WH)).toBe(true);
    expect(secretMatches(null, WH)).toBe(false);
    expect(secretMatches("", WH)).toBe(false);
    expect(secretMatches("webhook_secret_xy", WH)).toBe(false);
    expect(secretMatches(WH + "x", WH)).toBe(false);
  });
  it("rejects BEFORE reading the body: a bad secret is 401 even for garbage", () => {
    expect(parse("wrong", "not json at all")).toEqual({ ok: false, status: 401 });
    expect(parse(null, { type: "payment-intent.succeeded", data: {} })).toEqual({ ok: false, status: 401 });
  });
  it("rejects malformed bodies once authenticated", () => {
    expect(parse(WH, "not json")).toEqual({ ok: false, status: 400 });
    expect(parse(WH, { nope: 1 })).toEqual({ ok: false, status: 400 });
    expect(parse(WH, { type: "payment-intent.succeeded" })).toEqual({ ok: false, status: 400 });
  });
  it("maps each event explicitly: succeeded → SUCCEEDED, failed → FAILED, deferred → PENDING (never paid)", () => {
    const succeeded = parse(WH, { type: "payment-intent.succeeded", data: { id: "pi_1", mode: "test", amount: 5000, currency: "USD", status: "succeeded", metadata: { brohdaPaymentAttemptId: "a-1" } } });
    expect(succeeded).toMatchObject({ ok: true, event: { outcome: "SUCCEEDED", paymentRef: "pi_1", amountCents: 5000, currency: "USD", attemptId: "a-1", environment: "TEST" } });
    const failed = parse(WH, { type: "payment-intent.failed", data: { id: "pi_2", mode: "test", amount: 5000, currency: "USD", status: "requires_payment_method", error: { code: "declined", type: "processing_error" } } });
    expect(failed).toMatchObject({ ok: true, event: { outcome: "FAILED", failureCode: "declined" } });
    const deferred = parse(WH, { type: "payment-intent.deferred", data: { id: "pi_3", mode: "test", amount: 5000, currency: "USD", status: "processing" } });
    expect(deferred).toMatchObject({ ok: true, event: { outcome: "PENDING" } });
  });
  it("checkout-session.succeeded is SUCCEEDED only when paymentStatus is paid, and carries the session id from its url", () => {
    const paid = parse(WH, { type: "checkout-session.succeeded", data: { mode: "test", paymentStatus: "paid", currency: "CRC", amountTotal: 350000, url: "https://checkout.onvopay.com/pay/cs_abc", metadata: { brohdaPaymentAttemptId: "a-9" }, paymentIntentId: "pi_9" } });
    expect(paid).toMatchObject({ ok: true, event: { outcome: "SUCCEEDED", sessionId: "cs_abc", attemptId: "a-9", amountCents: 350000, currency: "CRC", paymentRef: "pi_9" } });
    const unpaid = parse(WH, { type: "checkout-session.succeeded", data: { mode: "test", paymentStatus: "unpaid", currency: "CRC", amountTotal: 350000, url: "https://checkout.onvopay.com/pay/cs_abc" } });
    expect(unpaid).toMatchObject({ ok: true, event: { outcome: "PENDING" } });
  });
  it("the SAME fact has the SAME dedup key (so a retried delivery is recognised), different facts differ", () => {
    const body = { type: "payment-intent.succeeded", data: { id: "pi_1", mode: "test", amount: 5000, currency: "USD", status: "succeeded" } };
    const a = parse(WH, body);
    const b = parse(WH, body);
    const c = parse(WH, { type: "payment-intent.failed", data: { id: "pi_1", mode: "test", amount: 5000, currency: "USD" } });
    expect(a.ok && b.ok && c.ok && a.event && b.event && c.event && a.event.dedupKey === b.event.dedupKey && a.event.dedupKey !== c.event.dedupKey).toBe(true);
  });
  it("a TEST event can never reach a LIVE configuration (and the reverse)", () => {
    expect(parse(WH, { type: "payment-intent.succeeded", data: { id: "pi_1", mode: "test", amount: 5000, currency: "USD" } }, "LIVE")).toEqual({ ok: false, status: 400 });
    expect(parse(WH, { type: "payment-intent.succeeded", data: { id: "pi_1", mode: "live", amount: 5000, currency: "USD" } }, "TEST")).toEqual({ ok: false, status: 400 });
  });
  it("events a sponsorship payment does not act on are authentic but ignored — including mobile-transfer.received, which proves nothing", () => {
    expect(parse(WH, { type: "mobile-transfer.received", data: { amount: 5000 } })).toEqual({ ok: true, event: null });
    expect(parse(WH, { type: "subscription.renewal.succeeded", data: {} })).toEqual({ ok: true, event: null });
    expect(parse(WH, { type: "something.new", data: {} })).toEqual({ ok: true, event: null });
  });
  it("session ids come only from a checkout url's last path segment", () => {
    expect(sessionIdFromUrl("https://checkout.onvopay.com/pay/cl502zv0d0127ebdp3zt27651")).toBe("cl502zv0d0127ebdp3zt27651");
    expect(sessionIdFromUrl("nonsense")).toBeNull();
    expect(sessionIdFromUrl(undefined)).toBeNull();
  });
});

describe("the ONVO client and adapter against the sandbox", () => {
  const make = () => {
    const sandbox = new OnvoSandbox(TEST_KEY, "http://sandbox", "test");
    const provider = new OnvoProvider({ ...good }, sandbox.fetcher);
    return { sandbox, provider };
  };

  it("creates a hosted Checkout session with the documented shape: Bearer key, one line item, the frozen amount/currency, fixed return URLs, and our attempt id in metadata", async () => {
    const { sandbox, provider } = make();
    const checkout = await provider.createPayment({ attemptId: "att-1", sponsorshipId: "sp-1", amountCents: 250000, currency: "CRC", description: "Sponsored Game Post", customerEmail: "biz@example.com", successUrl: "https://app/return?result=success", cancelUrl: "https://app/return?result=cancel" });
    expect(checkout.url).toMatch(/^http:\/\/sandbox\/pay\/cs_/);
    const req = sandbox.requests.at(-1)!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/checkout/sessions/one-time-link");
    expect(req.body).toMatchObject({ lineItems: [{ quantity: 1, unitAmount: 250000, currency: "CRC" }], redirectUrl: "https://app/return?result=success", cancelUrl: "https://app/return?result=cancel", customerEmail: "biz@example.com", metadata: { brohdaPaymentAttemptId: "att-1", brohdaSponsorshipId: "sp-1", brohdaEnvironment: "TEST" } });
    expect(JSON.stringify(sandbox.requests)).not.toContain(TEST_KEY); // the key travels in a header only
  });

  it("reads payment state from the provider: open → PENDING, paid → SUCCEEDED with the PROVIDER's amount, expired → EXPIRED, failed intent → FAILED", async () => {
    const { sandbox, provider } = make();
    const c = await provider.createPayment({ attemptId: "a", sponsorshipId: "s", amountCents: 1000, currency: "USD", description: "x", customerEmail: null, successUrl: "https://a/s", cancelUrl: "https://a/c" });
    expect(await provider.getPayment({ sessionId: c.sessionId })).toMatchObject({ outcome: "PENDING", environment: "TEST" });
    sandbox.pay(c.sessionId, { amount: 1000 });
    expect(await provider.getPayment({ sessionId: c.sessionId })).toMatchObject({ outcome: "SUCCEEDED", amountCents: 1000, currency: "USD" });
    const c2 = await provider.createPayment({ attemptId: "b", sponsorshipId: "s", amountCents: 2000, currency: "USD", description: "x", customerEmail: null, successUrl: "https://a/s", cancelUrl: "https://a/c" });
    sandbox.expire(c2.sessionId);
    expect(await provider.getPayment({ sessionId: c2.sessionId })).toMatchObject({ outcome: "EXPIRED" });
    const c3 = await provider.createPayment({ attemptId: "c", sponsorshipId: "s", amountCents: 3000, currency: "USD", description: "x", customerEmail: null, successUrl: "https://a/s", cancelUrl: "https://a/c" });
    const failedIntent = sandbox.fail(c3.sessionId);
    expect(await provider.getPayment({ paymentRef: failedIntent.id })).toMatchObject({ outcome: "FAILED" });
  });

  it("refunds: succeeded / pending map to Brohda's words; a rejected refund throws a provider error", async () => {
    const { sandbox, provider } = make();
    const c = await provider.createPayment({ attemptId: "a", sponsorshipId: "s", amountCents: 1000, currency: "USD", description: "x", customerEmail: null, successUrl: "https://a/s", cancelUrl: "https://a/c" });
    const intent = sandbox.pay(c.sessionId);
    const ok = await provider.refundPayment({ paymentRef: intent.id, amountCents: 1000, description: "r" });
    expect(ok.status).toBe("succeeded");
    await expect(provider.refundPayment({ paymentRef: intent.id, amountCents: 1000, description: "r" })).rejects.toBeInstanceOf(OnvoError); // the provider refuses a second full refund
    expect(sandbox.requests.at(-1)!.body).toMatchObject({ paymentIntentId: intent.id, amount: 1000 });
  });

  it("errors never carry the secret key, and a network failure is an UNKNOWN outcome", async () => {
    const { sandbox, provider } = make();
    sandbox.failNext(/POST \/v1\/checkout/, 500);
    const e500 = await provider.createPayment({ attemptId: "a", sponsorshipId: "s", amountCents: 1000, currency: "USD", description: "x", customerEmail: null, successUrl: "https://a/s", cancelUrl: "https://a/c" }).catch((e) => e);
    expect(e500).toBeInstanceOf(OnvoError);
    expect(e500.status).toBe(500);
    expect(e500.unknownOutcome).toBe(false);
    expect(String(e500.message)).not.toContain(TEST_KEY);
    sandbox.failNext(/POST \/v1\/checkout/, "network");
    const net = await provider.createPayment({ attemptId: "a", sponsorshipId: "s", amountCents: 1000, currency: "USD", description: "x", customerEmail: null, successUrl: "https://a/s", cancelUrl: "https://a/c" }).catch((e) => e);
    expect(net.unknownOutcome).toBe(true);
    expect(String(net.message)).not.toContain(TEST_KEY);
  });

  it("an unconfigured provider refuses to do anything (fail closed), and its webhook endpoint behaves as if absent", async () => {
    const provider = new OnvoProvider({}, new OnvoSandbox(TEST_KEY, "http://sandbox").fetcher);
    expect(provider.availability().state).toBe("unavailable");
    await expect(provider.createPayment({ attemptId: "a", sponsorshipId: "s", amountCents: 1000, currency: "USD", description: "x", customerEmail: null, successUrl: "https://a/s", cancelUrl: "https://a/c" })).rejects.toBeInstanceOf(OnvoError);
    expect(provider.parseWebhook(new Headers({ "x-webhook-secret": WH }), "{}")).toEqual({ ok: false, status: 503 });
  });

  it("an unsupported currency is refused before any request is made", async () => {
    const { sandbox, provider } = make();
    await expect(provider.createPayment({ attemptId: "a", sponsorshipId: "s", amountCents: 1000, currency: "EUR", description: "x", customerEmail: null, successUrl: "https://a/s", cancelUrl: "https://a/c" })).rejects.toBeInstanceOf(UnsupportedCurrencyError);
    expect(sandbox.requests).toHaveLength(0);
  });

  it("the client is the only holder of the key (a direct client call sends it as a Bearer header, nowhere else)", async () => {
    const sandbox = new OnvoSandbox(TEST_KEY, "http://sandbox");
    const r = resolveOnvoConfig(good);
    if (!r.ok) throw new Error("config");
    const client = new OnvoClient(r.config, sandbox.fetcher);
    await client.createCheckoutSession({ unitAmount: 100, currency: "USD", description: "d", customerEmail: null, redirectUrl: "https://a/s", cancelUrl: "https://a/c", metadata: {} });
    expect(JSON.stringify(sandbox.requests)).not.toContain(TEST_KEY);
  });
});
