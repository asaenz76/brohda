import Link from "next/link";
import { Bell } from "lucide-react";
import { BalancePill } from "@/components/BalancePill";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LogoutButton } from "@/components/LogoutButton";
import { MobileBottomNavigation } from "@/components/MobileBottomNavigation";
import { NotificationToast } from "@/components/NotificationToast";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { cn } from "@/lib/utils";
import type { UserProfile } from "@/lib/auth/session";

export function AppShell({
  user,
  balanceCents,
  unreadNotificationCount,
  createHref,
  wide = false,
  children,
}: {
  user: UserProfile;
  balanceCents: number;
  unreadNotificationCount: number;
  createHref: string | null;
  // Player-facing pages (Feed, Wallet, Profile, ...) are deliberately capped
  // at a mobile-first social-feed width. The admin section is data-dense
  // (an 8-tab nav plus wide tables) and reads better using more of a
  // desktop viewport, so AdminLayout opts into this instead.
  wide?: boolean;
  children: React.ReactNode;
}) {
  const maxWidth = wide ? "max-w-[1200px]" : "max-w-[720px]";

  return (
    <div className="flex min-h-full flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-border-subtle bg-background/95 backdrop-blur">
        <div className={cn("mx-auto flex items-center justify-between px-4 py-3", maxWidth)}>
          <Link href="/feed" className="font-logo text-lg font-extrabold italic text-text-primary">
            brohda.
          </Link>
          <div className="flex items-center gap-2">
            <BalancePill balanceCents={balanceCents} />
            {isAdminOrAbove(user) && (
              <Link
                href="/admin/users"
                className="text-sm font-medium text-text-secondary underline underline-offset-4 hover:text-text-primary"
              >
                Admin
              </Link>
            )}
            <Link
              href="/activity"
              aria-label={
                unreadNotificationCount > 0 ? `Activity (${unreadNotificationCount} unread)` : "Activity"
              }
              className="relative flex size-8 items-center justify-center rounded-full text-text-secondary transition-colors hover:text-text-primary"
            >
              <Bell className="size-5" aria-hidden="true" />
              {unreadNotificationCount > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute right-0.5 top-0.5 flex size-3.5 items-center justify-center rounded-full bg-danger text-[9px] font-semibold text-white"
                >
                  {unreadNotificationCount > 9 ? "9+" : unreadNotificationCount}
                </span>
              )}
            </Link>
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className={cn("mx-auto w-full flex-1 px-4 pt-4 pb-24", maxWidth)}>{children}</main>

      <MobileBottomNavigation
        createHref={createHref}
        profile={{ displayName: user.display_name, avatarUrl: user.avatar_url }}
        wide={wide}
      />
      <NotificationToast initialUnreadCount={unreadNotificationCount} />
    </div>
  );
}
