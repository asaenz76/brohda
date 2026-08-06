"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Search, Plus, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/Avatar";

const LEFT_TABS = [
  { href: "/feed", label: "Home", icon: Home },
  { href: "/search", label: "Search", icon: Search },
] as const;

const RIGHT_TABS = [{ href: "/leaderboard", label: "Leaderboard", icon: Trophy }] as const;

function NavLink({
  href,
  label,
  Icon,
  active,
}: {
  href: string;
  label: string;
  Icon: typeof Home;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 py-2 text-xs font-medium transition-colors",
        active ? "text-accent-primary" : "text-text-muted hover:text-text-secondary",
      )}
    >
      <Icon className="size-5" aria-hidden="true" />
      <span className="max-w-full truncate">{label}</span>
    </Link>
  );
}

export function MobileBottomNavigation({
  createHref,
  profile,
  wide = false,
}: {
  createHref: string | null;
  profile: { displayName: string; avatarUrl: string | null };
  // Matches AppShell's own `wide` flag so the bottom bar's width tracks the
  // header/content instead of staying pinned to the narrow player-page
  // width while the rest of the shell widens for the admin section.
  wide?: boolean;
}) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border-subtle bg-surface-primary pb-[env(safe-area-inset-bottom)]"
    >
      <ul className={cn("mx-auto flex w-full items-stretch justify-around", wide ? "max-w-[1200px]" : "max-w-[720px]")}>
        {LEFT_TABS.map(({ href, label, icon: Icon }) => (
          <li key={href} className="min-w-0 flex-1">
            <NavLink href={href} label={label} Icon={Icon} active={isActive(href)} />
          </li>
        ))}

        {createHref && (
          <li className="flex flex-1 items-center justify-center">
            <Link
              href={createHref}
              aria-label="Create"
              className="-mt-6 flex size-12 items-center justify-center rounded-full bg-accent-primary text-white shadow-lg transition-transform active:scale-95"
            >
              <Plus className="size-6" aria-hidden="true" />
            </Link>
          </li>
        )}

        {RIGHT_TABS.map(({ href, label, icon: Icon }) => (
          <li key={href} className="min-w-0 flex-1">
            <NavLink href={href} label={label} Icon={Icon} active={isActive(href)} />
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
