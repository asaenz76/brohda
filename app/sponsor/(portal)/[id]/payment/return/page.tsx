import Link from "next/link";
import { notFound } from "next/navigation";
import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { Card, CardContent } from "@/components/ui/card";
import { reconcileAttempt } from "@/lib/payments/service";
import { requireSponsorAccount } from "@/lib/sponsor/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSponsorshipForUser } from "@/lib/sponsorship/repository";

export const dynamic = "force-dynamic";

// Where the Sponsor lands after the payment page. THIS PAGE IS NOT PROOF OF PAYMENT and never marks anything paid: the "result" in the URL is only which button the
// Sponsor pressed. What it shows comes from Brohda's own record — and if an attempt is still open, the server asks the provider directly (a server-side read, the same
// trusted path reconciliation uses) so a slow webhook doesn't leave the Sponsor staring at a stale status. Refreshing or opening it directly is harmless.
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
  const scheduled = s.lifecycle === "SCHEDULED" || s.lifecycle === "LIVE";
  let headline: string;
  let detail: string;
  if (s.paymentStatus === "PAID") {
    headline = "Payment received.";
    detail = scheduled ? "Your sponsorship is scheduled." : "Your sponsorship is still awaiting Brohda approval. It runs only once Brohda has approved it.";
  } else if (s.paymentStatus === "FAILED") {
    headline = "Payment failed.";
    detail = "Your payment wasn't completed. You can try again from the sponsorship page.";
  } else {
    headline = "Payment pending.";
    detail = result === "cancel" ? "You left the payment page before it finished. Nothing is marked paid unless it shows as received here." : "We haven't received confirmation yet. This page updates once the payment is confirmed — you can refresh it.";
  }
  return (
    <div className="space-y-3">
      <ColumnHeader title="Payment" backHref={`/sponsor/${id}`} />
      <Card>
        <CardContent className="space-y-2 pt-6">
          <p role="status" data-slot="payment-return-status" className="text-base font-semibold text-text-primary">
            {headline}
          </p>
          <p className="text-sm text-text-secondary">{detail}</p>
          <Link href={`/sponsor/${id}`} className="inline-block text-sm font-medium text-accent-primary hover:underline">
            Back to your sponsorship
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
