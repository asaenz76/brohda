"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const SUB_NAV = [
  { suffix: "", label: "Dashboard" },
  { suffix: "/health", label: "Health" },
  { suffix: "/synchronization", label: "Synchronization" },
  { suffix: "/templates", label: "Templates" },
  { suffix: "/settings", label: "Settings" },
  { suffix: "/lifecycle", label: "Lifecycle" },
];

export function WorkspaceNav({ id }: { id: string }) {
  const pathname = usePathname();
  const base = `/admin/competitions/${id}`;

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-border-subtle">
      {SUB_NAV.map(({ suffix, label }) => {
        const href = `${base}${suffix}`;
        const active = suffix === "" ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={suffix}
            href={href}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
              active ? "border-accent-primary text-text-primary" : "border-transparent text-text-muted hover:text-text-secondary",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
