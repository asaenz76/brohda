"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, Search, Shield, Wallet } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { LogoutRow } from "@/components/shell/LogoutRow";
import { MenuSheet, menuItemClass } from "@/components/shell/MenuSheet";
import { MOBILE_NAV, activeNavKey, visibleNav, type ShellNavItem } from "@/components/shell/nav";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/utils/money";

const itemClass = "relative flex min-h-12 min-w-0 flex-col items-center justify-center gap-0.5 px-0.5 py-1.5 text-[11px] font-medium max-[360px]:text-[10px] outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50";

function BarLink({ item, active, unread, avatar }: { item: ShellNavItem; active: boolean; unread?: number; avatar?: { displayName: string; avatarUrl: string | null } }) {
  const Icon = item.icon;
  return (
    <Link href={item.href} aria-current={active ? "page" : undefined} className={cn(itemClass, active ? "text-accent-primary" : "text-text-muted hover:text-text-secondary")}>
      <span className="relative flex h-6 items-center">
        {avatar ? (
          <Avatar displayName={avatar.displayName} avatarUrl={avatar.avatarUrl} size="sm" className={cn("ring-2", active ? "ring-accent-primary" : "ring-transparent")} />
        ) : (
          <Icon className="size-5" aria-hidden="true" />
        )}
        {!!unread && unread > 0 && (
          <span aria-hidden="true" className="absolute -right-1.5 -top-1.5 flex size-3.5 items-center justify-center rounded-full bg-danger text-[9px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </span>
      <span className="max-w-full truncate">
        {item.label}
        {!!unread && unread > 0 && <span className="sr-only"> ({unread} unread)</span>}
      </span>
    </Link>
  );
}

// Phone navigation: the feed owns the viewport and these five controls stay
// at the bottom — Home, Discovery, Notifications, Profile, and a Menu for
// everything secondary (Search, Wallet, Log out). No account actions and
// nothing that creates content. Safe-area padding keeps it off the home
// indicator.
export function MobileNav({
  profile,
  profileSlug,
  showSocialNav,
  unreadNotificationCount,
  availableCents,
  heldCents,
  isAdmin,
}: {
  profile: { displayName: string; avatarUrl: string | null };
  profileSlug: string | null;
  showSocialNav: boolean;
  unreadNotificationCount: number;
  availableCents: number;
  heldCents: number;
  isAdmin: boolean;
}) {
  const pathname = usePathname();
  const active = activeNavKey(pathname, profileSlug);
  const available = formatCents(availableCents);
  const description = heldCents > 0 ? `${available} available, ${formatCents(heldCents)} on hold` : `${available} available`;

  return (
    <nav aria-label="Primary" data-testid="auth-bottom-nav" className="fixed inset-x-0 bottom-0 z-40 border-t border-border-subtle bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
      <ul className="mx-auto flex w-full max-w-[600px] items-stretch justify-around">
        {visibleNav(MOBILE_NAV, showSocialNav).map((item) => (
          // The longest label gets a wider slot so it is never truncated on the narrowest phones.
          <li key={item.key} className={cn("min-w-0", item.key === "notifications" ? "flex-[1.4]" : "flex-1")}>
            <BarLink
              item={item}
              active={active === item.key}
              unread={item.key === "notifications" ? unreadNotificationCount : undefined}
              avatar={item.key === "profile" ? profile : undefined}
            />
          </li>
        ))}
        <li className="min-w-0 flex-1">
          <MenuSheet
            triggerLabel="Menu"
            triggerClassName={cn(itemClass, "w-full text-text-muted hover:text-text-secondary")}
            triggerContent={
              <>
                <Menu className="size-5" aria-hidden="true" />
                <span>Menu</span>
              </>
            }
            popupTestId="auth-mobile-menu"
          >
            {(close) => (
              <nav aria-label="Menu" className="space-y-1">
                <Link href="/search" onClick={close} className={menuItemClass}>
                  <Search className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
                  Search
                </Link>
                <Link href="/wallet" onClick={close} title={description} aria-label={`Wallet: ${description}`} className={menuItemClass}>
                  <Wallet className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
                  <span>Wallet</span>
                  <span className="ml-auto text-xs font-normal text-text-muted" aria-hidden="true">
                    {available}
                  </span>
                </Link>
                {isAdmin && (
                  <Link href="/admin/users" onClick={close} className={menuItemClass}>
                    <Shield className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
                    Admin
                  </Link>
                )}
                <div className="border-t border-border-subtle pt-1">
                  <LogoutRow className="text-text-primary" />
                </div>
              </nav>
            )}
          </MenuSheet>
        </li>
      </ul>
    </nav>
  );
}
