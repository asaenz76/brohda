import { requireUser } from "@/lib/auth/session";
import { AppShell } from "@/components/AppShell";
import { getAppShellProps } from "@/lib/app-shell-props";

export default async function AppRouteLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const { balanceCents, unreadNotificationCount, createHref } = await getAppShellProps(user);

  return (
    <AppShell
      user={user}
      balanceCents={balanceCents}
      unreadNotificationCount={unreadNotificationCount}
      createHref={createHref}
    >
      {children}
    </AppShell>
  );
}
