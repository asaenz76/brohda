"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// Phase 4 (spec §23): Events replaces Fixtures as the primary operational
// concept. "Data" is the home for technical/operational concerns (fixture
// troubleshooting, provider health, sync/job status), reachable by every
// admin, not just super admins.
// `activePrefixes` lets a tab claim routes beyond its own href — add a
// route here, not a one-off pathname check, the next time a route gets
// conceptually reassigned to a different tab. Every entry here must stay a
// disjoint prefix — two tabs matching the same pathname would light up
// both at once.
const TABS: Array<{ href: string; label: string; superAdminOnly?: boolean; activePrefixes?: string[] }> = [
  { href: "/admin/events", label: "Events" },
  { href: "/admin/pools", label: "Pools" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/invitations", label: "Invitations" },
  { href: "/admin/data", label: "Data" },
  { href: "/admin/wallet-requests", label: "Ledger Requests", superAdminOnly: true },
  { href: "/admin/reports", label: "Reports", superAdminOnly: true },
  { href: "/admin/analytics", label: "Analytics", superAdminOnly: true },
  { href: "/admin/audit-log", label: "Audit Log", superAdminOnly: true },
  { href: "/admin/settings", label: "Settings", superAdminOnly: true },
];

export function AdminNav({ role }: { role: "super_admin" | "admin" | "player" }) {
  const pathname = usePathname();
  const tabs = TABS.filter((tab) => !tab.superAdminOnly || role === "super_admin");

  return (
    <nav
      aria-label="Admin"
      className="flex gap-1 overflow-x-auto border-b border-border-subtle"
    >
      {tabs.map(({ href, label, activePrefixes }) => {
        const active = (activePrefixes ?? [href]).some((prefix) => pathname.startsWith(prefix));
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
              active
                ? "border-accent-primary text-text-primary"
                : "border-transparent text-text-muted hover:text-text-secondary",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
