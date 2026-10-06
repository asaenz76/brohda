import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { REQUEST_PATH_HEADER, sanitizeNextPath } from "@/lib/auth/safe-next";
import { getPendingLegalAcceptances } from "@/lib/legal/acceptance";
import { AuthenticatedPage } from "@/components/shell/AuthenticatedPage";

export default async function AppRouteLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  // Re-consent gate. One read of a single settings row; the result is empty (nothing changes for anyone) unless an owner has deliberately
  // required re-acceptance of the current Terms or Privacy version (platform_settings.legal_reconsent_required), in which case the member
  // accepts it and is returned to the page they asked for.
  const pending = await getPendingLegalAcceptances(user.id);
  if (pending.length > 0) {
    const requested = sanitizeNextPath((await headers()).get(REQUEST_PATH_HEADER));
    redirect(requested ? `/accept-terms?next=${encodeURIComponent(requested)}` : "/accept-terms");
  }
  return <AuthenticatedPage user={user}>{children}</AuthenticatedPage>;
}
