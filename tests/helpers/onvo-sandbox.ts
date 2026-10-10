/**
 * A deterministic stand-in for ONVO's TEST API, modelled on ONVO's published API (docs.onvopay.com, openapi.yaml): hosted Checkout one-time-link sessions,
 * retrieving a session / payment intent, refunds, and the webhook payload shapes. It exists so automated tests never touch the network or spend anything; the real
 * TEST-API proof is a separate, credentialed script (scripts/onvo-test-proof.ts). Used two ways: as a `fetch` replacement (integration/unit) and behind a tiny HTTP
 * server (end-to-end).
 */
export interface SandboxSession {
  id: string;
  url: string;
  status: "open" | "complete" | "expired";
  paymentStatus: "unpaid" | "paid";
  paymentIntentId: string | null;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
  customerEmail: string | null;
  redirectUrl: string;
  cancelUrl: string;
}
export interface SandboxIntent {
  id: string;
  status: "succeeded" | "failed" | "pending";
  amount: number;
  currency: string;
  sessionId: string;
  refunded: number;
}
export interface SandboxRefund {
  id: string;
  paymentIntentId: string;
  amount: number;
  status: "pending" | "succeeded" | "failed";
}

export class OnvoSandbox {
  sessions = new Map<string, SandboxSession>();
  intents = new Map<string, SandboxIntent>();
  refunds = new Map<string, SandboxRefund>();
  requests: Array<{ method: string; path: string; body: unknown }> = [];
  /** What a refund request returns: 'succeeded' | 'pending' | 'reject'. */
  refundBehavior: "succeeded" | "pending" | "reject" = "succeeded";
  private n = 0;
  /** Provider ids are globally unique in the real API; each sandbox instance has its own namespace so ids never collide across tests. */
  private readonly ns = Math.random().toString(36).slice(2, 8);
  private faults: Array<{ match: RegExp; status: number | "network" }> = [];

  constructor(
    readonly secretKey: string,
    readonly publicBase: string,
    readonly mode: "test" | "live" = "test",
  ) {}

  failNext(match: RegExp, status: number | "network") {
    this.faults.push({ match, status });
  }

  private id(prefix: string) {
    return `${prefix}_${this.ns}_${(++this.n).toString().padStart(4, "0")}`;
  }

  /** Handle one API request. `auth` is the Authorization header value. */
  async handle(method: string, path: string, auth: string | null, body: unknown): Promise<{ status: number; json: unknown }> {
    this.requests.push({ method, path, body });
    const faultIndex = this.faults.findIndex((f) => f.match.test(`${method} ${path}`));
    if (faultIndex >= 0) {
      const f = this.faults.splice(faultIndex, 1)[0];
      if (f.status === "network") throw new Error("network down");
      return { status: f.status, json: { code: "server_error", message: "boom" } };
    }
    if (auth !== `Bearer ${this.secretKey}`) return { status: 401, json: { code: "unauthorized", message: "bad key" } };
    const b = (body ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

    if (method === "POST" && path === "/v1/checkout/sessions/one-time-link") {
      const items = Array.isArray(b.lineItems) ? b.lineItems : [];
      if (items.length === 0 || !b.redirectUrl || !b.cancelUrl) return { status: 400, json: { code: "validation_error", message: "bad request" } };
      const currency = items[0].currency;
      const amount = items.reduce((sum: number, i: any) => sum + Number(i.unitAmount) * Number(i.quantity ?? 1), 0); // eslint-disable-line @typescript-eslint/no-explicit-any
      if (!Number.isInteger(amount) || amount <= 0) return { status: 400, json: { code: "validation_error", message: "bad amount" } };
      const id = this.id("cs");
      const session: SandboxSession = { id, url: `${this.publicBase}/pay/${id}`, status: "open", paymentStatus: "unpaid", paymentIntentId: null, amount, currency, metadata: b.metadata ?? {}, customerEmail: b.customerEmail ?? null, redirectUrl: b.redirectUrl, cancelUrl: b.cancelUrl };
      this.sessions.set(id, session);
      return { status: 201, json: { id, url: session.url, status: "open", paymentStatus: "unpaid", mode: this.mode, successUrl: session.redirectUrl, cancelUrl: session.cancelUrl } };
    }
    const sessionMatch = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(path);
    if (method === "GET" && sessionMatch) {
      const s = this.sessions.get(sessionMatch[1]);
      if (!s) return { status: 404, json: { code: "not_found", message: "no such session" } };
      return { status: 200, json: { id: s.id, url: s.url, status: s.status, paymentStatus: s.paymentStatus, paymentIntentId: s.paymentIntentId, mode: this.mode } };
    }
    const intentMatch = /^\/v1\/payment-intents\/([^/]+)$/.exec(path);
    if (method === "GET" && intentMatch) {
      const pi = this.intents.get(intentMatch[1]);
      if (!pi) return { status: 404, json: { code: "not_found", message: "no such intent" } };
      return { status: 200, json: { id: pi.id, status: pi.status, amount: pi.amount, currency: pi.currency, mode: this.mode } };
    }
    if (method === "POST" && path === "/v1/refunds") {
      const pi = this.intents.get(b.paymentIntentId);
      if (!pi || pi.status !== "succeeded") return { status: 400, json: { code: "validation_error", message: "not refundable" } };
      const amount = Number(b.amount ?? pi.amount);
      if (this.refundBehavior === "reject" || amount + pi.refunded > pi.amount) return { status: 400, json: { code: "validation_error", message: "refund exceeds payment" } };
      const id = this.id("rf");
      const status = this.refundBehavior === "pending" ? "pending" : "succeeded";
      this.refunds.set(id, { id, paymentIntentId: pi.id, amount, status });
      if (status === "succeeded") pi.refunded += amount;
      return { status: 201, json: { id, status, amount, paymentIntentId: pi.id, mode: this.mode } };
    }
    const refundMatch = /^\/v1\/refunds\/([^/]+)$/.exec(path);
    if (method === "GET" && refundMatch) {
      const r = this.refunds.get(refundMatch[1]);
      if (!r) return { status: 404, json: { code: "not_found", message: "no such refund" } };
      return { status: 200, json: { id: r.id, status: r.status, amount: r.amount, paymentIntentId: r.paymentIntentId } };
    }
    return { status: 404, json: { code: "not_found", message: "unknown route" } };
  }

  /** `fetch` replacement for the adapter. */
  fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const auth = (init.headers as Record<string, string> | undefined)?.Authorization ?? null;
    const result = await this.handle(String(init.method ?? "GET"), u.pathname, auth, init.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(result.json), { status: result.status, headers: { "content-type": "application/json" } });
  };

  // --- controls for the test: what the payer did on the hosted page ---------------------------------------------------------------------------------

  /** The payer completed the payment (optionally for a different amount, to prove amount checking). */
  pay(sessionId: string, opts: { amount?: number; currency?: string } = {}): SandboxIntent {
    const s = this.sessions.get(sessionId)!;
    const id = this.id("pi");
    const intent: SandboxIntent = { id, status: "succeeded", amount: opts.amount ?? s.amount, currency: opts.currency ?? s.currency, sessionId, refunded: 0 };
    this.intents.set(id, intent);
    s.status = "complete";
    s.paymentStatus = "paid";
    s.paymentIntentId = id;
    return intent;
  }
  /** The payer's payment was declined (the session stays open — they can retry inside Checkout). */
  fail(sessionId: string): SandboxIntent {
    const s = this.sessions.get(sessionId)!;
    const id = this.id("pi");
    const intent: SandboxIntent = { id, status: "failed", amount: s.amount, currency: s.currency, sessionId, refunded: 0 };
    this.intents.set(id, intent);
    return intent;
  }
  expire(sessionId: string) {
    this.sessions.get(sessionId)!.status = "expired";
  }
  /** A deferred (waiting-for-approval) intent. */
  defer(sessionId: string): SandboxIntent {
    const s = this.sessions.get(sessionId)!;
    const id = this.id("pi");
    const intent: SandboxIntent = { id, status: "pending", amount: s.amount, currency: s.currency, sessionId, refunded: 0 };
    this.intents.set(id, intent);
    return intent;
  }

  // --- webhook payloads, shaped as in ONVO's webhook docs --------------------------------------------------------------------------------------------

  webhook(type: "checkout-session.succeeded" | "payment-intent.succeeded" | "payment-intent.failed" | "payment-intent.deferred" | "mobile-transfer.received", sessionId: string, intent?: SandboxIntent, opts: { withMetadata?: boolean } = {}): { type: string; data: Record<string, unknown> } {
    const s = this.sessions.get(sessionId)!;
    if (type === "checkout-session.succeeded") {
      return { type, data: { mode: this.mode, paymentStatus: "paid", currency: s.currency, url: s.url, amountTotal: s.paymentStatus === "paid" ? (this.intents.get(s.paymentIntentId!)?.amount ?? s.amount) : s.amount, createdAt: new Date().toISOString(), metadata: s.metadata, paymentIntentId: s.paymentIntentId, customer: { email: s.customerEmail }, lineItems: [] } };
    }
    if (type === "mobile-transfer.received") return { type, data: { mode: this.mode, amount: s.amount, currency: s.currency } };
    const pi = intent!;
    return { type, data: { id: pi.id, mode: this.mode, currency: pi.currency, amount: pi.amount, status: type === "payment-intent.succeeded" ? "succeeded" : type === "payment-intent.failed" ? "requires_payment_method" : "processing", metadata: opts.withMetadata ? s.metadata : {}, ...(type === "payment-intent.failed" ? { error: { type: "processing_error", code: "declined", message: "declined" } } : {}) } };
  }
}
