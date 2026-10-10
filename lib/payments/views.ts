import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export interface SponsorPaymentView {
  /** The latest attempt's local status, or null if there has been none. Safe to show (no provider identifiers). */
  latestStatus: string | null;
}

/** What a SPONSOR may see about payment attempts: status only. Provider identifiers never leave the server. */
export async function getSponsorPaymentView(sponsorshipId: string): Promise<SponsorPaymentView> {
  const admin = createAdminClient();
  const { data } = await admin.from("commercial_payment_attempts").select("status").eq("sponsorship_id", sponsorshipId).order("created_at", { ascending: false }).limit(1);
  return { latestStatus: data?.[0]?.status ?? null };
}

export interface AdminPaymentAttempt {
  id: string;
  provider: string;
  environment: "TEST" | "LIVE";
  status: string;
  providerStatus: string | null;
  amountCents: number;
  currency: string;
  providerPaymentRef: string | null;
  providerSessionId: string | null;
  failureCode: string | null;
  createdAt: string;
  paidAt: string | null;
  failedAt: string | null;
  refundedAt: string | null;
  lastProviderEventAt: string | null;
  refunds: Array<{ id: string; status: string; providerRefundId: string | null; failureCode: string | null; createdAt: string }>;
}

/** Super Admin's operational view: every attempt and its refunds, with provider references (never secrets or card data). */
export async function listPaymentAttemptsForAdmin(sponsorshipId: string): Promise<AdminPaymentAttempt[]> {
  const admin = createAdminClient();
  const { data } = await admin.from("commercial_payment_attempts").select("*").eq("sponsorship_id", sponsorshipId).order("created_at", { ascending: false });
  const ids = (data ?? []).map((a) => a.id as string);
  const { data: refunds } = ids.length ? await admin.from("commercial_payment_refunds").select("*").in("attempt_id", ids).order("created_at", { ascending: false }) : { data: [] as any[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  return (data ?? []).map((a) => ({
    id: a.id,
    provider: a.provider,
    environment: a.environment,
    status: a.status,
    providerStatus: a.provider_status,
    amountCents: a.amount_cents,
    currency: a.currency,
    providerPaymentRef: a.provider_payment_ref,
    providerSessionId: a.provider_session_id,
    failureCode: a.failure_code,
    createdAt: a.created_at,
    paidAt: a.paid_at,
    failedAt: a.failed_at,
    refundedAt: a.refunded_at,
    lastProviderEventAt: a.last_provider_event_at,
    refunds: (refunds ?? []).filter((r) => r.attempt_id === a.id).map((r) => ({ id: r.id, status: r.status, providerRefundId: r.provider_refund_id, failureCode: r.failure_code, createdAt: r.created_at })),
  }));
}
