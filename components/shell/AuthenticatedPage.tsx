import { isAdminOrAbove } from "@/lib/auth/guards";
import { getAppShellProps } from "@/lib/app-shell-props";
import { getSocialPredictionAccessPolicy } from "@/lib/social/access";
import { AuthenticatedShell } from "@/components/shell/AuthenticatedShell";
import type { UserProfile } from "@/lib/auth/session";

// Wraps a page in the signed-in shell, with the shell's own data (wallet
// available/held, unread count, whether the social product is on for this
// person) loaded here, once. Used by the (app) layout and by any public route
// that also renders inside the app shell for a signed-in visitor (/rules), so
// the shell is assembled in exactly one place.
export async function AuthenticatedPage({ user, children }: { user: UserProfile; children: React.ReactNode }) {
  const [{ availableCents, heldCents, unreadNotificationCount }, socialPolicy] = await Promise.all([getAppShellProps(user), getSocialPredictionAccessPolicy()]);
  // The nav tab is a UX signal, not the enforcement layer; each Brohda 2.0 page's own requireSocialPredictionAccess() is what actually
  // protects direct URL access. Admin/Super Admin always see the tab, matching their always-pass preview access on the pages themselves.
  const showSocialNav = isAdminOrAbove(user) || socialPolicy.enabled;

  return (
    <AuthenticatedShell user={user} availableCents={availableCents} heldCents={heldCents} unreadNotificationCount={unreadNotificationCount} showSocialNav={showSocialNav}>
      {children}
    </AuthenticatedShell>
  );
}
