import { redirect } from "next/navigation";

/**
 * Phase G (Brohda 2.0 redesign, spec §20) — /activity used to combine
 * notifications and wallet ledger activity on one page; the two are now
 * split (notifications are social, wallet history is account
 * infrastructure, spec §18-19). /wallet already showed the complete
 * ledger independently before this phase (confirmed via audit — nothing
 * unique lived only on /activity), so nothing is lost by redirecting the
 * whole page straight to the new canonical /notifications center rather
 * than keeping two competing notification surfaces around.
 */
export default function ActivityPage() {
  redirect("/notifications");
}
