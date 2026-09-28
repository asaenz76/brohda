import Link from "next/link";
import { Search } from "lucide-react";
import { BalancePill } from "@/components/BalancePill";
import { LogoutButton } from "@/components/LogoutButton";
import { MobileBottomNavigation } from "@/components/MobileBottomNavigation";
import { NotificationToast } from "@/components/NotificationToast";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { cn } from "@/lib/utils";
import type { UserProfile } from "@/lib/auth/session";

// Phase B (design-system redesign) — header restraint per spec §15: the
// bell/Activity icon that used to live here is REMOVED, not just
// restyled — Notifications is now one of the 4 primary bottom-nav
// destinations (see MobileBottomNavigation's own temporary-mapping
// comment, /activity for now), so a second header entry point to the
// exact same page was redundant chrome, not a real second destination.
// Search moved INTO the header (a small icon, not a text link) rather
// than staying a primary bottom-nav tab — spec §19 removes Search from
// the target primary IA but explicitly forbids making it unreachable
// until Discovery can absorb it; this is the smallest change that
// satisfies both without inventing a redesigned Search experience early.
// BalancePill already renders as a muted neutral pill (bg-surface-
// secondary, no accent color) rather than a bold color-block, so no
// wallet balance is styled as a primary social-network signal even
// though it stays in the header — access is preserved per spec §20,
// its final Wallet/History position comes in a later phase.
export function AppShell({
  user,
  balanceCents,
  unreadNotificationCount,
  wide = false,
  // Milestone R13.10 (Stage 0) — defaults true so AdminLayout (every user
  // there is already admin-or-above via requireAdminOrAbove()) doesn't
  // need to compute/pass this itself; app/(app)/layout.tsx passes the
  // real per-request value for ordinary players.
  showSocialPredictionNav = true,
  children,
}: {
  user: UserProfile;
  balanceCents: number;
  unreadNotificationCount: number;
  // Player-facing pages (Feed, Wallet, Profile, ...) are deliberately capped
  // at a mobile-first social-feed width. The admin section is data-dense
  // (an 8-tab nav plus wide tables) and reads better using more of a
  // desktop viewport, so AdminLayout opts into this instead.
  wide?: boolean;
  showSocialPredictionNav?: boolean;
  children: React.ReactNode;
}) {
  const maxWidth = wide ? "max-w-[1200px]" : "max-w-[720px]";

  return (
    <div className="flex min-h-full flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-border-subtle bg-background/95 backdrop-blur">
        <div
          className={cn(
            // flex-wrap + gap-y: at large accessibility text sizes the
            // wordmark + balance pill + icon row no longer fit one line at
            // common mobile widths — wrap instead of overflowing the
            // viewport (real failure caught testing at 200% text size).
            "mx-auto flex flex-wrap items-center justify-between gap-y-2 px-4 py-3",
            maxWidth,
          )}
        >
          <Link href="/feed" className="font-logo text-lg font-extrabold italic text-text-primary">
            brohda.
          </Link>
          <div className="flex flex-wrap items-center justify-end gap-1">
            <Link
              href="/search"
              aria-label="Search"
              title="Search"
              className="flex size-8 items-center justify-center rounded-full text-text-secondary transition-colors hover:text-text-primary"
            >
              <Search className="size-5" aria-hidden="true" />
            </Link>
            <BalancePill balanceCents={balanceCents} />
            {isAdminOrAbove(user) && (
              <Link
                href="/admin/users"
                className="text-sm font-medium text-text-muted underline underline-offset-4 hover:text-text-primary"
              >
                Admin
              </Link>
            )}
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className={cn("mx-auto w-full flex-1 px-4 pt-4 pb-24", maxWidth)}>{children}</main>

      <MobileBottomNavigation
        profile={{ displayName: user.display_name, avatarUrl: user.avatar_url }}
        wide={wide}
        showSocialPredictionNav={showSocialPredictionNav}
        unreadNotificationCount={unreadNotificationCount}
      />
      <NotificationToast initialUnreadCount={unreadNotificationCount} />
    </div>
  );
}
