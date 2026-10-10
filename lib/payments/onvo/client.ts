import "server-only";
import type { OnvoConfig } from "../config";
import { PaymentProviderError } from "../types";

// Thin, server-only HTTP client for the ONVO REST API (https://api.onvopay.com/v1, Bearer secret key — see ONVO's Authentication docs). The secret key is
// attached here and nowhere else; it is never logged, returned or placed in an error message. Only the endpoints Brohda uses exist: hosted Checkout
// sessions (one-time link), retrieving a session / payment intent, and refunds.
export class OnvoError extends PaymentProviderError {}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface OnvoCheckoutSession {
  id: string;
  url: string;
  status: string; // open | complete | expired
  paymentStatus?: string; // unpaid | paid
  paymentIntentId?: string | null;
  mode?: string | null; // test | live
}

export interface OnvoPaymentIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  mode?: string | null;
  lastPaymentError?: { code?: string | null } | null;
}

export interface OnvoRefund {
  id: string;
  status: string; // pending | succeeded | failed
  amount?: number;
  paymentIntentId?: string;
}

const TIMEOUT_MS = 15_000;

export class OnvoClient {
  constructor(
    private readonly config: OnvoConfig,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init),
  ) {}

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.apiBase}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.config.secretKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch {
      throw new OnvoError(null, "network", `ONVO ${method} ${path}: no response`);
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const code = typeof (json as { code?: unknown } | null)?.code === "string" ? (json as { code: string }).code : `http_${response.status}`;
      throw new OnvoError(response.status, code, `ONVO ${method} ${path}: HTTP ${response.status} ${code}`);
    }
    if (json === null || typeof json !== "object") throw new OnvoError(response.status, "bad_response", `ONVO ${method} ${path}: unreadable response`);
    return json as T;
  }

  createCheckoutSession(input: { unitAmount: number; currency: string; description: string; customerEmail: string | null; redirectUrl: string; cancelUrl: string; metadata: Record<string, string> }): Promise<OnvoCheckoutSession> {
    return this.request<OnvoCheckoutSession>("POST", "/v1/checkout/sessions/one-time-link", {
      lineItems: [{ quantity: 1, unitAmount: input.unitAmount, currency: input.currency, description: input.description }],
      ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
      redirectUrl: input.redirectUrl,
      cancelUrl: input.cancelUrl,
      captureMethod: "automatic",
      metadata: input.metadata,
    });
  }

  getCheckoutSession(id: string): Promise<OnvoCheckoutSession> {
    return this.request<OnvoCheckoutSession>("GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`);
  }

  getPaymentIntent(id: string): Promise<OnvoPaymentIntent> {
    return this.request<OnvoPaymentIntent>("GET", `/v1/payment-intents/${encodeURIComponent(id)}`);
  }

  createRefund(input: { paymentIntentId: string; amount: number; description: string }): Promise<OnvoRefund> {
    return this.request<OnvoRefund>("POST", "/v1/refunds", { paymentIntentId: input.paymentIntentId, amount: input.amount, reason: "other", description: input.description });
  }

  getRefund(id: string): Promise<OnvoRefund> {
    return this.request<OnvoRefund>("GET", `/v1/refunds/${encodeURIComponent(id)}`);
  }
}
