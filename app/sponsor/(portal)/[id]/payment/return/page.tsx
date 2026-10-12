import { notFound, redirect } from "next/navigation";
import { reconcileAttempt } from "@/lib/payments/service";
import { requireSponsorAccount } from "@/lib/sponsor/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSponsorshipForUser } from "@/lib/sponsorship/repository";

export const dynamic = "force-dynamic";

// Where the Sponsor lands after the payment page — and it sends them straight back to THEIR SPONSORSHIP, where the payment section tells the truth. THIS IS NOT PROOF OF PAYMENT and
// never marks anything paid: the "result" in the URL is only which button the Sponsor pressed. If an attempt is still open, the server asks the provider directly first (a
// server-side read, the same trusted path reconciliation uses) so a slow webhook doesn't leave the Sponsor staring at a stale status; what the sponsorship page then shows comes
// only from Brohda's own record (pending / received / failed). Refreshing or opening this URL directly is harmless.
export default async function PaymentReturnPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string }> }) {
  const session = await requireSponsorAccount();
  const { id } = await params;
  const { result } = await searchParams;
  if (!(await getSponsorshipForUser(session.userId, id))) notFound();

  const admin = createAdminClient();
  const { data: open } = await admin.from("commercial_payment_attempts").select("id").eq("sponsorship_id", id).in("status", ["CREATED", "PENDING"]).limit(1);
  if (open?.[0]) await reconcileAttempt(open[0].id).catch(() => undefined); // best effort: the webhook remains the main path

  const s = await getSponsorshipForUser(session.userId, id);
  if (!s) notFound();
  // Pressing "back" on the payment page is only a note about what the Sponsor did — it never changes what is shown as paid.
  redirect(result === "cancel" && s.paymentStatus !== "PAID" ? `/sponsor/${id}?payment=left` : `/sponsor/${id}`);
}
