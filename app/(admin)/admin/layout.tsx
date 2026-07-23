import { requireAdminOrAbove } from "@/lib/auth/session";
import { AppShell } from "@/components/AppShell";
import { AdminNav } from "@/components/AdminNav";
import { getAppShellProps } from "@/lib/app-shell-props";

// Admin pages get the same header/bottom-nav shell as every other section
// (spec: header and footer must be consistent across the whole platform) —
// AdminNav is the admin section's own secondary navigation, rendered inside
// AppShell's content area rather than replacing its header entirely.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAdminOrAbove();
  const { balanceCents, unreadNotificationCount, createHref } = await getAppShellProps(user);

  return (
    <AppShell
      user={user}
      balanceCents={balanceCents}
      unreadNotificationCount={unreadNotificationCount}
      createHref={createHref}
      wide
    >
      <div className="space-y-6">
        <AdminNav role={user.role} />
        {children}
      </div>
    </AppShell>
  );
}
