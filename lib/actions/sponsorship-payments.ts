"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { appOrigin } from "@/lib/app-origin";
import { requireSuperAdmin } from "@/lib/auth/session";
import { cancelOpenAttempt, PaymentError, reconcileAttempt, reconcileRefund, refundThroughProvider, startSponsorPayment } from "@/lib/payments/service";
import { isRegisteredProvider } from "@/lib/payments/registry";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveSponsorAccount } from "@/lib/sponsor/session";
import { getSponsorshipForUser } from "@/lib/sponsorship/repository";

const idSchema = z.uuid();

/**
 * "Pay online" for ONE of the signed-in Sponsor's own sponsorships. The form carries the sponsorship id and a de-duplication key — NEVER an amount: the amount is
 * read from the database. The return URLs are fixed server-side paths. Success of the payment is decided only by the provider's confirmed state (webhook / server-side
 * read), never by this redirect or by the page the Sponsor lands on afterwards.
 */
export async function startSponsorPaymentAction(formData: FormData): Promise<void> {
  const session = await requireActiveSponsorAccount();
  const sponsorshipId = String(formData.get("sponsorshipId") ?? "");
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "");
  const back = (code: string) => redirect(`/sponsor/${sponsorshipId}?payment=${code}`);
  if (!idSchema.safeParse(sponsorshipId).success || idempotencyKey.length < 8 || idempotencyKey.length > 120) return back("invalid");
  // Ownership is re-checked here too (a Sponsor sees nothing about anyone else's sponsorship), and again inside the database.
  if (!(await getSponsorshipForUser(session.userId, sponsorshipId))) return back("invalid");

  const origin = await appOrigin();
  let target: string;
  try {
    const result = await startSponsorPayment({
      userId: session.userId,
      sponsorshipId,
      idempotencyKey: `sponsor:${session.userId}:${sponsorshipId}:${idempotencyKey}`,
      customerEmail: session.email,
      description: "Sponsored Game Post",
      successUrl: `${origin}/sponsor/${sponsorshipId}/payment/return?result=success`,
      cancelUrl: `${origin}/sponsor/${sponsorshipId}/payment/return?result=cancel`,
    });
    if (result.status === "paid") target = `/sponsor/${sponsorshipId}/payment/return?result=success`;
    else if (result.status === "starting") target = `/sponsor/${sponsorshipId}?payment=starting`;
    else target = result.url;
  } catch (e) {
    const code = e instanceof PaymentError ? e.code : "unknown";
    return back(code);
  }
  revalidatePath(`/sponsor/${sponsorshipId}`);
  redirect(target);
}

export type AdminPaymentResult = { success: boolean; error: string | null; message?: string };

const fail = (e: unknown): AdminPaymentResult => ({ success: false, error: e instanceof PaymentError ? e.message : "Something went wrong. Try again." });

function revalidateAdmin() {
  revalidatePath("/admin/sponsorship");
}

/** Super Admin: compare one payment attempt with the provider's own record and correct local state if they differ. */
export async function reconcilePaymentAttemptAction(sponsorshipId: string, attemptId: string): Promise<AdminPaymentResult> {
  await requireSuperAdmin();
  if (!idSchema.safeParse(attemptId).success) return { success: false, error: "Payment not found." };
  try {
    const r = await reconcileAttempt(attemptId);
    revalidatePath(`/admin/sponsorship/${sponsorshipId}`);
    revalidateAdmin();
    return { success: true, error: null, message: r.applied === "DUPLICATE" || r.applied === "IGNORED_STALE" ? "Already in step with the provider." : `Reconciled: ${r.applied.toLowerCase().replace(/_/g, " ")}.` };
  } catch (e) {
    return fail(e);
  }
}

/** Super Admin: ask the provider to return a payment Brohda's refund policy says is owed. Never automatic; refunded only on the provider's confirmed answer. */
export async function refundThroughProviderAction(sponsorshipId: string, attemptId: string): Promise<AdminPaymentResult> {
  const admin = await requireSuperAdmin();
  if (!idSchema.safeParse(attemptId).success) return { success: false, error: "Payment not found." };
  try {
    const r = await refundThroughProvider(admin.id, attemptId);
    revalidatePath(`/admin/sponsorship/${sponsorshipId}`);
    revalidateAdmin();
    if (r.status === "succeeded") return { success: true, error: null, message: "Refund confirmed by the provider." };
    if (r.status === "pending") return { success: true, error: null, message: "Refund requested — the provider hasn't confirmed it yet. Check back and reconcile." };
    return { success: false, error: "The provider didn't complete the refund. Nothing was marked refunded — you can refund manually or try again." };
  } catch (e) {
    return fail(e);
  }
}

export async function reconcileRefundAction(sponsorshipId: string, refundId: string): Promise<AdminPaymentResult> {
  const admin = await requireSuperAdmin();
  if (!idSchema.safeParse(refundId).success) return { success: false, error: "Refund not found." };
  try {
    const r = await reconcileRefund(admin.id, refundId);
    revalidatePath(`/admin/sponsorship/${sponsorshipId}`);
    return { success: true, error: null, message: `Refund is ${r.status}.` };
  } catch (e) {
    return fail(e);
  }
}

/** Super Admin: close an open payment attempt (for example to move a Sponsor onto a newly selected provider). The record stays; a late provider success is still recognised. */
export async function cancelPaymentAttemptAction(sponsorshipId: string, attemptId: string): Promise<AdminPaymentResult> {
  const admin = await requireSuperAdmin();
  if (!idSchema.safeParse(attemptId).success) return { success: false, error: "Payment not found." };
  try {
    await cancelOpenAttempt(admin.id, attemptId);
    revalidatePath(`/admin/sponsorship/${sponsorshipId}`);
    revalidateAdmin();
    return { success: true, error: null, message: "Open payment cancelled." };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Super Admin: turn online sponsorship payments on/off and choose WHICH installed provider takes new payments. This is operational configuration — no deploy, no secrets.
 * The provider key is accepted only if it names a registered adapter (the database stores any well-formed key; the application is what knows which ones exist). The change
 * is audited by the database function; it only affects NEW payments — existing attempts stay with the provider that created them.
 */
export async function setOnlinePaymentConfigAction(_prev: AdminPaymentResult | null, formData: FormData): Promise<AdminPaymentResult> {
  const admin = await requireSuperAdmin();
  const choice = String(formData.get("provider") ?? "");
  const enabled = choice !== "" && choice !== "DISABLED";
  if (enabled && !isRegisteredProvider(choice)) return { success: false, error: "That provider isn't installed in this deployment." };
  const { error } = await createAdminClient().rpc("admin_set_online_payment_config", { p_admin_id: admin.id, p_enabled: enabled, p_provider: enabled ? choice : null });
  if (error) return { success: false, error: "Couldn't save the online payment setting." };
  revalidatePath("/admin/sponsorship");
  return { success: true, error: null, message: enabled ? "Online payments are on." : "Online payments are off." };
}
