import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { fromProviderAmount } from "../amount";
import type { ProviderEnvironment, WebhookParse } from "../types";

// ONVO webhook handling: authentication and translation, nothing else. ONVO's webhook docs: every delivery is a POST with `X-Webhook-Secret` carrying the webhook's
// secret, a body of { type, data }, no top-level event id, and a note that events can repeat and arrive out of order. So authenticity is the secret (compared in
// constant time, BEFORE the body is looked at), idempotency is a key derived from the FACT the event states, and order is handled by the database's monotonic rule.
const SECRET_HEADER = "x-webhook-secret";

export function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  // Hash both so the comparison is constant-time even when the lengths differ.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const asString = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const asRecord = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const modeToEnvironment = (mode: unknown): ProviderEnvironment | null => (mode === "test" ? "TEST" : mode === "live" ? "LIVE" : null);

/** A Checkout URL looks like https://checkout.onvopay.com/pay/<sessionId>; the session id is its last path segment. */
export function sessionIdFromUrl(url: unknown): string | null {
  const u = asString(url);
  if (!u) return null;
  try {
    const parts = new URL(u).pathname.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : null;
  } catch {
    return null;
  }
}

export const ATTEMPT_METADATA_KEY = "brohdaPaymentAttemptId";

export function parseOnvoWebhook(headers: Headers, rawBody: string, expectedSecret: string, configuredEnvironment: ProviderEnvironment): WebhookParse {
  // 1. Authenticate first. A missing or wrong secret is rejected without reading the payload.
  if (!secretMatches(headers.get(SECRET_HEADER), expectedSecret)) return { ok: false, status: 401 };

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400 };
  }
  const root = asRecord(payload);
  const type = asString(root?.type);
  const data = asRecord(root?.data);
  if (!root || !type || !data) return { ok: false, status: 400 };

  const ignored: WebhookParse = { ok: true, event: null };

  if (type === "checkout-session.succeeded") {
    const environment = modeToEnvironment(data.mode) ?? configuredEnvironment;
    if (environment !== configuredEnvironment) return { ok: false, status: 400 }; // a test event can never reach a live configuration, nor the reverse
    const metadata = asRecord(data.metadata);
    const sessionId = sessionIdFromUrl(data.url);
    const attemptId = asString(metadata?.[ATTEMPT_METADATA_KEY]);
    const paid = data.paymentStatus === "paid";
    const currency = asString(data.currency);
    return {
      ok: true,
      event: {
        provider: "ONVO",
        environment,
        dedupKey: `onvo:cs:${paid ? "paid" : "unpaid"}:${sessionId ?? attemptId ?? "unknown"}`,
        eventType: type,
        attemptId,
        sessionId,
        paymentRef: asString(data.paymentIntentId),
        outcome: paid ? "SUCCEEDED" : "PENDING",
        amountCents: currency ? fromProviderAmount(data.amountTotal, currency) : null,
        currency,
        providerStatus: asString(data.paymentStatus),
        failureCode: null,
      },
    };
  }

  if (type === "payment-intent.succeeded" || type === "payment-intent.failed" || type === "payment-intent.deferred") {
    const id = asString(data.id);
    if (!id) return { ok: false, status: 400 };
    const environment = modeToEnvironment(data.mode) ?? configuredEnvironment;
    if (environment !== configuredEnvironment) return { ok: false, status: 400 };
    const metadata = asRecord(data.metadata);
    const err = asRecord(data.error);
    const currency = asString(data.currency);
    const outcome = type === "payment-intent.succeeded" ? "SUCCEEDED" : type === "payment-intent.failed" ? "FAILED" : "PENDING"; // deferred is NEVER paid
    return {
      ok: true,
      event: {
        provider: "ONVO",
        environment,
        dedupKey: `onvo:pi:${outcome}:${id}`,
        eventType: type,
        attemptId: asString(metadata?.[ATTEMPT_METADATA_KEY]),
        sessionId: null,
        paymentRef: id,
        outcome,
        amountCents: currency ? fromProviderAmount(data.amount, currency) : null,
        currency,
        providerStatus: asString(data.status),
        failureCode: asString(err?.code) ?? asString(err?.type),
      },
    };
  }

  // subscription.*, mobile-transfer.received and anything unknown: authentic, but not something a sponsorship payment acts on (mobile-transfer.received explicitly
  // does not prove a payment). Acknowledged so ONVO does not retry; nothing is changed.
  return ignored;
}
