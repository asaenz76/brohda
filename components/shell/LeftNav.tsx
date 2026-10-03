"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Shield, Wallet } from "lucide-react";
import { LogoutRow } from "@/components/shell/LogoutRow";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/utils/money";
import { PRIMARY_NAV, activeNavKey, visibleNav, type ShellNavItem } from "@/components/shell/nav";

const rowClass =
  "relative flex min-h-11 items-center gap-3 rounded-md px-3 text-[15px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60";

function UnreadBadge({ count }: { count: number }) {
  return (
    <>
      <span aria-hidden="true" className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
        {count > 9 ? "9+" : count}
      </span>
      <span className="sr-only"> ({count} unread)</span>
    </>
  );
}

function NavRow({ item, active, unread }: { item: ShellNavItem; active: boolean; unread?: number }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(rowClass, active ? "bg-surface-secondary font-semibold text-text-primary" : "font-medium text-text-secondary hover:bg-surface-secondary hover:text-text-primary")}
    >
      <Icon className={cn("size-5 shrink-0", active && "text-accent-primary")} aria-hidden="true" />
      <span className="truncate">{item.label}</span>
      {!!unread && unread > 0 && <UnreadBadge count={unread} />}
    </Link>
  );
}

// Desktop/tablet left rail: the primary destinations, then a quiet lower
// section for utilities (Wallet, Admin, Log out). Wallet is deliberately a
// utility row, not a primary destination, and shows what's available to act
// on; money on hold is named in the accessible label and tooltip.
export function LeftNav({
  profileSlug,
  showSocialNav,
  unreadNotificationCount,
  availableCents,
  heldCents,
  isAdmin,
}: {
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
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {visibleNav(PRIMARY_NAV, showSocialNav).map((item) => (
        <NavRow key={item.key} item={item} active={active === item.key} unread={item.key === "notifications" ? unreadNotificationCount : undefined} />
      ))}

      <div className="mt-3 flex flex-col gap-1 border-t border-border-subtle pt-3">
        <Link
          href="/wallet"
          title={description}
          aria-label={`Wallet: ${description}`}
          aria-current={active === "wallet" ? "page" : undefined}
          className={cn(rowClass, active === "wallet" ? "bg-surface-secondary font-semibold text-text-primary" : "font-medium text-text-secondary hover:bg-surface-secondary hover:text-text-primary")}
        >
          <Wallet className={cn("size-5 shrink-0", active === "wallet" && "text-accent-primary")} aria-hidden="true" />
          <span className="truncate">Wallet</span>
          <span className="ml-auto text-xs font-normal text-text-muted" aria-hidden="true">
            {available}
          </span>
        </Link>
        {isAdmin && (
          <Link href="/admin/users" className={cn(rowClass, "font-medium text-text-secondary hover:bg-surface-secondary hover:text-text-primary")}>
            <Shield className="size-5 shrink-0" aria-hidden="true" />
            Admin
          </Link>
        )}
        <LogoutRow className="text-[15px]" />
      </div>
    </nav>
  );
}
