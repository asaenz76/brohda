import { isAdminOrAbove } from "@/lib/auth/guards";
import { getAppShellProps } from "@/lib/app-shell-props";
import { getSocialPredictionAccessPolicy } from "@/lib/social/access";
import { getConsumerMonetaryAccess } from "@/lib/monetary/capability";
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
  // The Wallet entry follows the one consumer money capability: money on, or the viewer's OWN funds/holds still to deal with — operators get no special
  // wallet while money is off. The shell's balance figures are the viewer's own for everyone except a super admin, whose header shows the platform's house
  // account (platform revenue, an operator figure, not a personal wallet), so for a super admin the capability reads their personal balance instead.
  const money = await getConsumerMonetaryAccess(user, user.role === "super_admin" ? undefined : { totalCents: availableCents + heldCents, heldCents });

  return (
    <AuthenticatedShell user={user} availableCents={availableCents} heldCents={heldCents} unreadNotificationCount={unreadNotificationCount} showSocialNav={showSocialNav} showWallet={money.canSeeWallet}>
      {children}
    </AuthenticatedShell>
  );
}
