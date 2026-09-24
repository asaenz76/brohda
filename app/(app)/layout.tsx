import { requireUser } from "@/lib/auth/session";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { AppShell } from "@/components/AppShell";
import { getAppShellProps } from "@/lib/app-shell-props";
import { getSocialPredictionAccessPolicy } from "@/lib/social/access";

export default async function AppRouteLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [{ balanceCents, unreadNotificationCount, createHref }, socialPolicy] = await Promise.all([
    getAppShellProps(user),
    getSocialPredictionAccessPolicy(),
  ]);
  // Milestone R13.10 (Stage 0) — the nav tab is a UX signal, not the
  // enforcement layer; each Brohda 2.0 page's own requireSocialPrediction
  // Access() (lib/social/access.ts) is what actually protects direct URL
  // access. Admin/Super Admin always see the tab regardless, matching
  // their always-pass preview access on the pages themselves.
  const showSocialPredictionNav = isAdminOrAbove(user) || socialPolicy.enabled;

  return (
    <AppShell
      user={user}
      balanceCents={balanceCents}
      unreadNotificationCount={unreadNotificationCount}
      createHref={createHref}
      showSocialPredictionNav={showSocialPredictionNav}
    >
      {children}
    </AppShell>
  );
}
