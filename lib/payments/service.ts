import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveOnlinePayment } from "./active-provider";
import { getAdapter } from "./registry";
import { PaymentProviderError, type CommercialPaymentProvider, type NormalizedPaymentEvent, type ProviderPaymentState } from "./types";
import { notifySponsorAccount } from "@/lib/sponsorship/notify";

// The commercial payment service: the only code that connects the database's payment functions to a provider adapter. It contains no provider words (that is the
// adapter) and no sponsorship policy (that is the database): its job is to order the steps safely — authorize and fix the amount in the database, talk to the
// provider outside any transaction, and turn only TRUSTED provider state (a verified webhook, or a server-side read of the provider) into local state.
export class PaymentError extends Error {
  constructor(
    readonly code: "unavailable" | "not_payable" | "already_paid" | "not_authorized" | "provider_unavailable" | "in_progress_other_provider" | "unknown",
    message: string,
  ) {
    super(message);
  }
}

type Deps = { env?: Record<string, string | undefined> };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function mapRpcError(message: string): PaymentError {
  if (/not_authorized/.test(message)) return new PaymentError("not_authorized", "Not found.");
  if (/already_paid/.test(message)) return new PaymentError("already_paid", "This sponsorship is already paid.");
  if (/open_attempt_other_provider/.test(message)) return new PaymentError("in_progress_other_provider", "Your earlier payment is still in progress. Finish it, or wait for it to expire, before starting a new one.");
  if (/sponsor_not_active|sponsorship_disabled|sponsorship_not_payable|price_missing|sponsorship_not_found/.test(message)) return new PaymentError("not_payable", "This sponsorship can't be paid right now.");
  return new PaymentError("unknown", "Something went wrong. Try again.");
}

async function applyEvent(event: NormalizedPaymentEvent, source: "WEBHOOK" | "RECONCILE" | "RETURN"): Promise<Json> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("commercial_payment_apply_result", {
    p_provider: event.provider,
    p_environment: event.environment,
    p_dedup_key: event.dedupKey,
    p_event_type: event.eventType,
    p_source: source,
    p_attempt_id: event.attemptId,
    p_session_id: event.sessionId,
    p_payment_ref: event.paymentRef,
    p_outcome: event.outcome,
    p_amount_cents: event.amountCents,
    p_currency: event.currency,
    p_provider_status: event.providerStatus,
    p_failure_code: event.failureCode,
  });
  if (error) throw error;
  const result = data as Json;
  await afterApplied(result);
  return result;
}

/** Side effects of a state change that ACTUALLY happened (a duplicate delivery returns DUPLICATE and never gets here), so nobody is notified twice. */
async function afterApplied(result: Json): Promise<void> {
  if (!result?.sponsorshipId) return;
  if (result.result !== "APPLIED_PAID" && result.result !== "APPLIED_FAILED") {
    if (["DUPLICATE_PAYMENT", "AMOUNT_MISMATCH", "UNAPPLIED"].includes(result.result)) console.error(`[payments] needs reconciliation: ${result.result} sponsorship=${result.sponsorshipId} attempt=${result.attemptId}`);
    return;
  }
  const admin = createAdminClient();
  const { data: s } = await admin.from("sponsorships").select("sponsor_id, lifecycle, review_status").eq("id", result.sponsorshipId).single();
  if (!s) return;
  if (result.result === "APPLIED_FAILED") {
    await notifySponsorAccount(s.sponsor_id, "Your sponsorship payment didn't go through", ["Your payment wasn't completed.", "You can try again from the sponsorship page."]);
    return;
  }
  // Say what is TRUE: payment alone never approves or schedules anything.
  const scheduled = s.lifecycle === "SCHEDULED" || s.lifecycle === "LIVE";
  await notifySponsorAccount(s.sponsor_id, "Payment received", scheduled ? ["Payment received. Your sponsorship is scheduled."] : ["Payment received. Your sponsorship is still awaiting Brohda approval.", "It runs only once Brohda has approved it."]);
}

function stateToEvent(attempt: Json, state: ProviderPaymentState, source: string): NormalizedPaymentEvent {
  return {
    provider: attempt.provider,
    environment: attempt.environment,
    dedupKey: `${source.toLowerCase()}:${attempt.id}:${state.outcome}:${state.providerStatus}`,
    eventType: `${source.toLowerCase()}.read`,
    attemptId: attempt.id,
    sessionId: state.sessionId ?? attempt.provider_session_id,
    paymentRef: state.paymentRef ?? attempt.provider_payment_ref,
    outcome: state.outcome,
    amountCents: state.amountCents,
    currency: state.currency,
    providerStatus: state.providerStatus,
    failureCode: null,
  };
}

export interface StartInput {
  userId: string;
  sponsorshipId: string;
  /** Per click/page; a repeat with the same key returns the same attempt. */
  idempotencyKey: string;
  customerEmail: string | null;
  description: string;
  successUrl: string;
  cancelUrl: string;
}
export type StartResult = { status: "redirect"; url: string; attemptId: string } | { status: "paid" } | { status: "starting" };

/**
 * A Sponsor pays for ITS OWN sponsorship. The amount is whatever the database says the sponsorship is priced at; nothing the browser sends can change it.
 * Double-click / two tabs / retry converge on one open attempt and at most one provider session.
 */
export async function startSponsorPayment(input: StartInput, deps: Deps = {}): Promise<StartResult> {
  // NEW payments use the provider the Super Admin has selected (and only if it is installed AND its runtime configuration is valid). Nothing here names a provider.
  const active = await resolveOnlinePayment(deps.env);
  if (active.state !== "available" || !active.offered || !active.adapter) throw new PaymentError("unavailable", "Online payment isn't available right now.");
  const provider: CommercialPaymentProvider = active.adapter;
  const environment = active.environment;
  const admin = createAdminClient();

  // An open attempt that belongs to ANOTHER provider (the selection changed since it started) is never converted or retired: it is settled through its own provider first.
  await settleOtherProviderAttempt(input.sponsorshipId, provider.key);

  const begin = async (key: string) => {
    const { data, error } = await admin.rpc("commercial_payment_begin", { p_user_id: input.userId, p_id: input.sponsorshipId, p_provider: provider.key, p_environment: environment, p_idempotency_key: key });
    if (error) throw mapRpcError(error.message);
    return data as Json;
  };

  let attempt = await begin(input.idempotencyKey);

  // An existing session: ask the provider (server-side) where it stands before sending the Sponsor back to it.
  if (attempt.provider_session_id) {
    try {
      const state = await provider.getPayment({ sessionId: attempt.provider_session_id, paymentRef: attempt.provider_payment_ref });
      if (state.environment && state.environment !== attempt.environment) throw new PaymentError("unknown", "Environment mismatch.");
      if (state.outcome === "SUCCEEDED") {
        await applyEvent(stateToEvent(attempt, state, "RETURN"), "RETURN");
        return { status: "paid" };
      }
      if (state.outcome === "EXPIRED" || state.outcome === "FAILED") {
        await applyEvent(stateToEvent(attempt, state, "RETURN"), "RETURN");
        attempt = await begin(`${input.idempotencyKey}:${state.outcome.toLowerCase()}:${attempt.id}`); // a fresh attempt; the old one stays on record
      } else if (attempt.checkout_url) {
        return { status: "redirect", url: attempt.checkout_url, attemptId: attempt.id };
      }
    } catch (e) {
      if (e instanceof PaymentError) throw e;
      // Could not read the provider right now: do not guess. The Sponsor is sent back to the session they already have.
      if (attempt.checkout_url) return { status: "redirect", url: attempt.checkout_url, attemptId: attempt.id };
    }
  }

  if (attempt.provider_session_id && attempt.checkout_url && attempt.status === "PENDING") return { status: "redirect", url: attempt.checkout_url, attemptId: attempt.id };

  // Create the provider session — exactly one request may do this per attempt.
  const { data: claimed } = await admin.rpc("commercial_payment_claim_creation", { p_attempt_id: attempt.id });
  if (!claimed) {
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const { data } = await admin.from("commercial_payment_attempts").select("id, status, checkout_url").eq("id", attempt.id).single();
      if (data?.checkout_url) return { status: "redirect", url: data.checkout_url, attemptId: data.id };
    }
    return { status: "starting" };
  }
  try {
    const checkout = await provider.createPayment({ attemptId: attempt.id, sponsorshipId: input.sponsorshipId, amountCents: attempt.amount_cents, currency: attempt.currency, description: input.description, customerEmail: input.customerEmail, successUrl: input.successUrl, cancelUrl: input.cancelUrl });
    const { error: attachError } = await admin.rpc("commercial_payment_attach", { p_attempt_id: attempt.id, p_session_id: checkout.sessionId, p_checkout_url: checkout.url, p_provider_status: checkout.providerStatus });
    // The provider session exists; if we cannot record it, say so loudly — the metadata on the session still lets a payment be matched to this attempt.
    if (attachError) throw new PaymentError("unknown", `could not record the provider session: ${attachError.message}`);
    return { status: "redirect", url: checkout.url, attemptId: attempt.id };
  } catch (e) {
    const code = e instanceof PaymentProviderError ? e.code : "creation_failed";
    if (!(e instanceof PaymentProviderError)) console.error(`[payments] ${e instanceof Error ? e.message.slice(0, 200) : "error"}`);
    await admin.rpc("commercial_payment_creation_failed", { p_attempt_id: attempt.id, p_code: code });
    console.error(`[payments] checkout creation failed: attempt=${attempt.id} code=${code}`);
    throw new PaymentError("provider_unavailable", "We couldn't start the payment. Please try again in a moment.");
  }
}

export interface WebhookResult {
  status: 200 | 400 | 401 | 500 | 503;
  body: { received: boolean; result?: string };
}

/**
 * A provider webhook delivery. The endpoint says WHICH provider's adapter verifies it (a provider-specific URL is infrastructure); the policy setting plays no part, so a
 * late callback for an attempt that provider started is still processed after online payments were switched off or another provider was selected. Authenticated first; success
 * is VERIFIED against the provider server-side before any state changes; every outcome is idempotent.
 */
export async function handleProviderWebhook(providerKey: string, headers: Headers, rawBody: string): Promise<WebhookResult> {
  const provider = getAdapter(providerKey);
  if (!provider) return { status: 503, body: { received: false } }; // not installed here: behaves as absent
  const parsed = provider.parseWebhook(headers, rawBody);
  if (!parsed.ok) {
    if (parsed.status === 401) console.error("[payments] webhook rejected: bad or missing secret");
    return { status: parsed.status, body: { received: false } }; // no detail about why
  }
  if (!parsed.event) return { status: 200, body: { received: true, result: "IGNORED" } };

  try {
    let event = parsed.event;
    if (event.outcome === "SUCCEEDED") {
      // Do not take "paid" (or the amount) on the webhook's word alone: read the provider's own record.
      const state = await provider.getPayment({ sessionId: event.sessionId, paymentRef: event.paymentRef });
      if (state.outcome !== "SUCCEEDED") return { status: 500, body: { received: false } }; // not confirmed (yet): let the provider retry
      if (state.environment && state.environment !== event.environment) return { status: 400, body: { received: false } };
      event = { ...event, paymentRef: state.paymentRef ?? event.paymentRef, amountCents: state.amountCents, currency: state.currency, providerStatus: state.providerStatus };
    }
    const result = await applyEvent(event, "WEBHOOK");
    return { status: 200, body: { received: true, result: String(result.result) } };
  } catch (e) {
    console.error(`[payments] webhook processing failed: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`);
    return { status: 500, body: { received: false } };
  }
}

export interface ReconcileOutcome {
  attemptId: string;
  providerOutcome: string;
  applied: string;
}

/** Super Admin: compare one attempt with the provider's own record and correct local state if they differ. Idempotent; audited by the ledger and the state change. */
export async function reconcileAttempt(attemptId: string): Promise<ReconcileOutcome> {
  const admin = createAdminClient();
  const { data: attempt } = await admin.from("commercial_payment_attempts").select("*").eq("id", attemptId).single();
  if (!attempt) throw new PaymentError("not_payable", "Payment not found.");
  // The attempt is reconciled through the provider that PROCESSED it (its snapshot), never through whichever provider is active now.
  const provider = getAdapter(attempt.provider);
  if (!provider) throw new PaymentError("unavailable", "That payment's provider isn't installed in this deployment.");
  if (!provider.capabilities.supportsReconciliation) throw new PaymentError("unavailable", "That provider can't be reconciled online.");
  if (!attempt.provider_session_id && !attempt.provider_payment_ref) throw new PaymentError("not_payable", "This attempt never reached the provider.");
  const state = await provider.getPayment({ sessionId: attempt.provider_session_id, paymentRef: attempt.provider_payment_ref });
  if (state.environment && state.environment !== attempt.environment) throw new PaymentError("unknown", "The provider reports a different environment than this attempt.");
  const result = await applyEvent(stateToEvent(attempt, state, "RECONCILE"), "RECONCILE");
  return { attemptId, providerOutcome: state.outcome, applied: String(result.result) };
}

export interface RefundOutcome {
  refundId: string;
  status: "pending" | "succeeded" | "failed";
  manualFallback: boolean;
}

/**
 * Super Admin asks the PROVIDER to return a payment. Whether a refund is owed is Brohda's policy and is decided before this is called; this is only one way to pay it.
 * Local state moves to REFUND_PENDING / REFUNDED only on the provider's confirmed answer; anything else leaves a manual refund as the fallback.
 */
export async function refundThroughProvider(adminId: string, attemptId: string): Promise<RefundOutcome> {
  const admin = createAdminClient();
  const { data: owner } = await admin.from("commercial_payment_attempts").select("provider").eq("id", attemptId).single();
  const provider = getAdapter(owner?.provider);
  if (!provider) throw new PaymentError("unavailable", "That payment's provider isn't installed in this deployment — refund manually.");
  if (!provider.capabilities.supportsRefund) throw new PaymentError("unavailable", "That provider can't refund online — refund manually.");
  const { data: refund, error } = await admin.rpc("commercial_refund_begin", { p_admin_id: adminId, p_attempt_id: attemptId });
  if (error) throw new PaymentError(/refund_already_requested/.test(error.message) ? "already_paid" : "not_payable", error.message.replace(/^.*?:\s*/, ""));
  const r = refund as Json;
  const { data: attempt } = await admin.from("commercial_payment_attempts").select("provider_payment_ref").eq("id", attemptId).single();
  try {
    const state = await provider.refundPayment({ paymentRef: attempt!.provider_payment_ref, amountCents: r.amount_cents, description: "Sponsorship refund" });
    await admin.rpc("commercial_refund_record", { p_admin_id: adminId, p_refund_id: r.id, p_provider_refund_id: state.refundId, p_status: state.status, p_failure_code: state.failureCode });
    return { refundId: r.id, status: state.status, manualFallback: state.status === "failed" };
  } catch (e) {
    // The provider said no (or could not be reached): nothing is marked refunded. The attempt is closed as failed so a manual refund — or a retry — can follow; if the
    // outcome was unknown the operator is told to check the provider dashboard before retrying.
    const code = e instanceof PaymentProviderError ? (e.unknownOutcome ? "unknown_outcome" : e.code) : "refund_error";
    await admin.rpc("commercial_refund_record", { p_admin_id: adminId, p_refund_id: r.id, p_provider_refund_id: null, p_status: "failed", p_failure_code: code });
    console.error(`[payments] provider refund failed: refund=${r.id} code=${code}`);
    return { refundId: r.id, status: "failed", manualFallback: true };
  }
}

/** Refresh a pending provider refund from the provider (some providers send no refund webhook). */
export async function reconcileRefund(adminId: string, refundId: string): Promise<RefundOutcome> {
  const admin = createAdminClient();
  const { data: refund } = await admin.from("commercial_payment_refunds").select("*").eq("id", refundId).single();
  const provider = getAdapter(refund?.provider);
  if (!provider || !provider.capabilities.supportsRefund) throw new PaymentError("unavailable", "That refund's provider can't be checked online.");
  if (!refund?.provider_refund_id) throw new PaymentError("not_payable", "This refund has no provider reference to check.");
  const state = await provider.getRefund(refund.provider_refund_id);
  await admin.rpc("commercial_refund_record", { p_admin_id: adminId, p_refund_id: refundId, p_provider_refund_id: state.refundId, p_status: state.status, p_failure_code: state.failureCode });
  return { refundId, status: state.status, manualFallback: state.status === "failed" };
}


/** Super Admin explicitly closes an open attempt (for example to move a Sponsor onto a newly selected provider). It stays on record; a later provider success is still recognised. */
export async function cancelOpenAttempt(adminId: string, attemptId: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc("commercial_payment_cancel_attempt", { p_admin_id: adminId, p_attempt_id: attemptId });
  if (error) throw new PaymentError("not_payable", "Could not cancel that payment attempt.");
}

/**
 * Before starting a new payment with the ACTIVE provider: if an open attempt belongs to another provider, ask THAT provider (through its own adapter) where it stands. If it has
 * ended (failed / expired / paid) it is recorded and the new payment can go ahead; if it is still open the Sponsor is told so — it is never converted, superseded or doubled.
 */
async function settleOtherProviderAttempt(sponsorshipId: string, activeKey: string): Promise<void> {
  const admin = createAdminClient();
  const { data: open } = await admin.from("commercial_payment_attempts").select("*").eq("sponsorship_id", sponsorshipId).in("status", ["CREATED", "PENDING"]).limit(1);
  const attempt = open?.[0];
  if (!attempt || attempt.provider === activeKey) return;
  const adapter = getAdapter(attempt.provider);
  if (adapter?.capabilities.supportsReconciliation && (attempt.provider_session_id || attempt.provider_payment_ref)) {
    try {
      const state = await adapter.getPayment({ sessionId: attempt.provider_session_id, paymentRef: attempt.provider_payment_ref });
      if (!state.environment || state.environment === attempt.environment) await applyEvent(stateToEvent(attempt, state, "RETURN"), "RETURN");
    } catch {
      /* the other provider can't be reached: nothing is guessed — the attempt stays open */
    }
  }
}
