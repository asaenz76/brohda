"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Bell, Compass } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/Avatar";

// Phase B (design-system redesign) — the primary nav is now exactly the
// spec's locked 4-item target IA (Home / Discovery / Notifications /
// Profile). No Search, Leaderboard, or Create FAB: Search stays reachable
// (moved into AppShell's header, see that file) rather than dropped;
// Leaderboard's REMOVAL here is nav-prominence only, per the Phase A
// verdict ("RETIRE (nav only)") — /leaderboard and /predictions/leaderboard
// both still exist and work, just aren't a primary destination anymore;
// Create is dropped outright (spec §18: Brohda has no consumer-authored
// content type — Posts are platform-generated from Games — so there is
// nothing for an ordinary user to "create" yet; the prior FAB was already
// superadmin-only, reachable via /admin/pools/new + the separate AdminNav).
//
// TEMPORARY ROUTE MAPPINGS (spec §14/§16 — document every one; none of
// these are the final destination, they're what those 4 concepts point at
// until their own phase builds the real thing):
//   Home          -> /feed      (still the legacy Pools feed's content
//                                today; Phase D repurposes this exact
//                                route into the real Home timeline)
//   Discovery     -> /markets   (still Stage 4A's flat social-discovery
//                                feed today, not yet Sports/Leagues/Teams
//                                tabs; Phase C builds the real /discovery)
//   Notifications -> /activity  (still the combined notifications+ledger
//                                page today; Phase G splits out a real
//                                /notifications route)
//   Profile       -> /profile   (already correct, no mapping needed)
interface NavTab {
  href: string;
  label: string;
  icon: typeof Home;
  socialPredictionGated?: boolean;
}

const NAV_TABS: NavTab[] = [
  { href: "/feed", label: "Home", icon: Home },
  { href: "/markets", label: "Discovery", icon: Compass, socialPredictionGated: true },
  { href: "/activity", label: "Notifications", icon: Bell },
];

function NavLink({
  href,
  label,
  Icon,
  active,
  badgeCount,
}: {
  href: string;
  label: string;
  Icon: typeof Home;
  active: boolean;
  badgeCount?: number;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium transition-colors",
        active ? "text-accent-primary" : "text-text-muted hover:text-text-secondary",
      )}
    >
      <span className="relative">
        <Icon className="size-5" aria-hidden="true" />
        {!!badgeCount && badgeCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1.5 -top-1.5 flex size-3.5 items-center justify-center rounded-full bg-danger text-[9px] font-semibold text-white"
          >
            {badgeCount > 9 ? "9+" : badgeCount}
          </span>
        )}
      </span>
      <span className="max-w-full truncate">
        {label}
        {!!badgeCount && badgeCount > 0 && <span className="sr-only"> ({badgeCount} unread)</span>}
      </span>
    </Link>
  );
}

export function MobileBottomNavigation({
  profile,
  wide = false,
  showSocialPredictionNav = true,
  unreadNotificationCount = 0,
}: {
  profile: { displayName: string; avatarUrl: string | null };
  // Matches AppShell's own `wide` flag so the bottom bar's width tracks the
  // header/content instead of staying pinned to the narrow player-page
  // width while the rest of the shell widens for the admin section.
  wide?: boolean;
  // Milestone R13.10 (Stage 0) — a UX signal only (server-enforced access
  // lives in lib/social/access.ts's requireSocialPredictionAccess(), which
  // every Brohda 2.0 page calls independently of nav visibility). Hides
  // only the Discovery tab (temporarily mapped to /markets) — Home and
  // Notifications are always shown, same as before.
  showSocialPredictionNav?: boolean;
  unreadNotificationCount?: number;
}) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const tabs = showSocialPredictionNav ? NAV_TABS : NAV_TABS.filter((tab) => !tab.socialPredictionGated);

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border-subtle bg-surface-primary pb-[env(safe-area-inset-bottom)]"
    >
      <ul className={cn("mx-auto flex w-full items-stretch justify-around", wide ? "max-w-[1200px]" : "max-w-[720px]")}>
        {tabs.map(({ href, label, icon: Icon }) => (
          <li key={href} className="min-w-0 flex-1">
            <NavLink
              href={href}
              label={label}
              Icon={Icon}
              active={isActive(href)}
              badgeCount={href === "/activity" ? unreadNotificationCount : undefined}
            />
          </li>
        ))}

        <li className="min-w-0 flex-1">
          <Link
            href="/profile"
            aria-current={isActive("/profile") ? "page" : undefined}
            className={cn(
              "flex min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium transition-colors",
              isActive("/profile") ? "text-accent-primary" : "text-text-muted hover:text-text-secondary",
            )}
          >
            <Avatar
              displayName={profile.displayName}
              avatarUrl={profile.avatarUrl}
              size="sm"
              className={cn("ring-2", isActive("/profile") ? "ring-accent-primary" : "ring-transparent")}
            />
            <span className="max-w-full truncate">Profile</span>
          </Link>
        </li>
      </ul>
    </nav>
  );
}
