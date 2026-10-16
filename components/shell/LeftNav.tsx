"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Settings, Shield, Wallet } from "lucide-react";
import { LogoutRow } from "@/components/shell/LogoutRow";
import { ConfidenceSummary, type ConfidenceFigures } from "@/components/confidence/ConfidenceBalance";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/utils/money";
import { activeNavKey, railNav, type ShellNavItem } from "@/components/shell/nav";

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
// section for utilities (Confidence, Wallet, Admin, Log out). Confidence leads that section: it is the Member's balance-like summary. Wallet is deliberately a
// utility row, not a primary destination, and shows what's available to act
// on; money on hold is named in the accessible label and tooltip.
export function LeftNav({
  profileSlug,
  showSocialNav,
  showWallet,
  unreadNotificationCount,
  showMessages = false,
  unreadMessageCount = 0,
  availableCents,
  heldCents,
  isAdmin,
  confidence = null,
}: {
  profileSlug: string | null;
  showSocialNav: boolean;
  showWallet: boolean;
  unreadNotificationCount: number;
  showMessages?: boolean;
  unreadMessageCount?: number;
  availableCents: number;
  heldCents: number;
  isAdmin: boolean;
  /** The Member's Confidence (null while Confidence is off): the primary balance-like summary, in the slot the Wallet row used to own. */
  confidence?: ConfidenceFigures | null;
}) {
  const pathname = usePathname();
  const active = activeNavKey(pathname, profileSlug);
  const available = formatCents(availableCents);
  const description = heldCents > 0 ? `${available} available, ${formatCents(heldCents)} on hold` : `${available} available`;

  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {railNav(showSocialNav, showMessages).map((item) => (
        <NavRow key={item.key} item={item} active={active === item.key} unread={item.key === "notifications" ? unreadNotificationCount : item.key === "messages" ? unreadMessageCount : undefined} />
      ))}

      <div className="mt-3 flex flex-col gap-1 border-t border-border-subtle pt-3">
        {confidence && <ConfidenceSummary {...confidence} stacked active={pathname.startsWith("/profile/confidence")} />}
        {showWallet && (
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
        )}
        <Link
          href="/profile/edit"
          aria-current={active === "settings" ? "page" : undefined}
          className={cn(rowClass, active === "settings" ? "bg-surface-secondary font-semibold text-text-primary" : "font-medium text-text-secondary hover:bg-surface-secondary hover:text-text-primary")}
        >
          <Settings className={cn("size-5 shrink-0", active === "settings" && "text-accent-primary")} aria-hidden="true" />
          <span className="truncate">Settings</span>
        </Link>
        <Link
          href="/rules"
          aria-current={active === "rules" ? "page" : undefined}
          className={cn(rowClass, active === "rules" ? "bg-surface-secondary font-semibold text-text-primary" : "font-medium text-text-secondary hover:bg-surface-secondary hover:text-text-primary")}
        >
          <BookOpen className={cn("size-5 shrink-0", active === "rules" && "text-accent-primary")} aria-hidden="true" />
          <span className="truncate">Rules</span>
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
