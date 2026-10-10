// The provider-neutral commercial payment boundary. The sponsorship domain (eligibility, approval, scheduling, public rendering) never imports anything
// provider-specific; it sees only these shapes. MANUAL payments keep working through sponsorship_payment_events exactly as before; a provider is one adapter
// behind this interface (see ./registry), for SPONSORSHIP payments only (Sponsor -> Brohda, for advertising media). It is never the player money provider.
export type ProviderName = string;
export type ProviderEnvironment = "TEST" | "LIVE";

/** What the provider says, already translated into Brohda's own words (the adapter is the only place provider vocabulary exists). */
export type NormalizedOutcome = "PENDING" | "FAILED" | "EXPIRED" | "SUCCEEDED";

export type ProviderAvailability =
  | { state: "unavailable"; reason: string }
  | { state: "test"; environment: "TEST" }
  | { state: "live"; environment: "LIVE" };

export interface NormalizedPaymentEvent {
  provider: ProviderName;
  environment: ProviderEnvironment;
  /** Identifies this fact (not this delivery): the same fact delivered twice has the same key. */
  dedupKey: string;
  eventType: string;
  attemptId: string | null;
  sessionId: string | null;
  paymentRef: string | null;
  outcome: NormalizedOutcome;
  amountCents: number | null;
  currency: string | null;
  providerStatus: string | null;
  failureCode: string | null;
}

export interface PaymentCheckout {
  sessionId: string;
  url: string;
  providerStatus: string;
}

/** The provider's own current view of one payment, fetched server-side (never taken from a browser). */
export interface ProviderPaymentState {
  outcome: NormalizedOutcome;
  providerStatus: string;
  sessionId: string | null;
  paymentRef: string | null;
  amountCents: number | null;
  currency: string | null;
  environment: ProviderEnvironment | null;
}

export interface ProviderRefundState {
  refundId: string;
  status: "pending" | "succeeded" | "failed";
  failureCode: string | null;
}

/** A provider-neutral failure from an adapter. `status` is null when the provider could not be reached (so the outcome of a write is UNKNOWN). */
export class PaymentProviderError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string,
    /** Safe to log: never contains a key or a payload. */
    message: string,
  ) {
    super(message);
  }
  get unknownOutcome(): boolean {
    return this.status === null;
  }
}

export type WebhookParse = { ok: true; event: NormalizedPaymentEvent | null } | { ok: false; status: 400 | 401 | 503 };

/** What an adapter can actually do. Core behavior asks THESE, never "which provider is it" — a provider without a capability simply isn't offered that action. */
export interface ProviderCapabilities {
  supportsCheckout: boolean;
  supportsRefund: boolean;
  supportsPartialRefund: boolean;
  supportsReconciliation: boolean;
  /** True when the provider tells us about refund results; false means refund state is checked on demand. */
  supportsRefundWebhook: boolean;
}

export interface CommercialPaymentProvider {
  /** The provider key stored on every attempt (a snapshot: history is never reinterpreted through the currently active provider). */
  readonly key: ProviderName;
  /** A human label for Super Admin only (never shown to Sponsors or the public). */
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  availability(): ProviderAvailability;
  createPayment(input: { attemptId: string; sponsorshipId: string; amountCents: number; currency: string; description: string; customerEmail: string | null; successUrl: string; cancelUrl: string }): Promise<PaymentCheckout>;
  getPayment(ref: { sessionId?: string | null; paymentRef?: string | null }): Promise<ProviderPaymentState>;
  refundPayment(input: { paymentRef: string; amountCents: number; description: string }): Promise<ProviderRefundState>;
  getRefund(refundId: string): Promise<ProviderRefundState>;
  /** Authenticates the delivery and translates it; `event: null` means "authentic, but not about a payment we act on". */
  parseWebhook(headers: Headers, rawBody: string): WebhookParse;
}
