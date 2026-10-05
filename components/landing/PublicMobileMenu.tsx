"use client";

import Link from "next/link";
import { Menu, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { DISCOVERY_TABS, DISCOVERY_TAB_LABELS } from "@/lib/communities/discovery-tabs";
import { MenuSheet, menuItemClass } from "@/components/shell/MenuSheet";

// The hamburger half of the logged-out mobile bottom bar: a compact sheet,
// not a second navigation system. It holds only what the bar and the
// centre column don't — Search (which needs an account, and says so), quick
// jumps to the same three tabs the centre column already has, a line about
// Brohda, and the legal links. The modal behaviour (focus trap, Escape,
// focus restore) comes from the shared MenuSheet.
export function PublicMobileMenu({ about, className }: { about: string; className?: string }) {
  return (
    <MenuSheet
      triggerLabel="Open menu"
      triggerClassName={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-md text-text-primary outline-none hover:bg-surface-secondary focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
      triggerContent={<Menu className="size-6" aria-hidden="true" />}
      popupTestId="public-mobile-menu"
    >
      {(close) => (
        <>
          <nav aria-label="Menu" className="space-y-1">
            <Link href="/login" onClick={close} className={menuItemClass}>
              <Search className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
              <span>Search</span>
              <span className="ml-auto text-xs font-normal text-text-muted">Log in to search</span>
            </Link>
            {DISCOVERY_TABS.map((tab) => (
              <Link key={tab} href={`/?tab=${tab}`} onClick={close} className={menuItemClass}>
                {DISCOVERY_TAB_LABELS[tab]}
              </Link>
            ))}
          </nav>

          <section aria-label="About Brohda" className="mt-3 space-y-1 border-t border-border-subtle px-3 pt-3">
            <h2 className="text-sm font-semibold text-text-primary">About Brohda</h2>
            <p className="text-sm text-text-secondary">{about}</p>
          </section>

          <nav aria-label="Legal" className="mt-2 space-y-1 border-t border-border-subtle pt-2">
            <Link href="/rules" onClick={close} className={menuItemClass}>
              Rules
            </Link>
            <Link href="/terms" onClick={close} className={menuItemClass}>
              Terms
            </Link>
            <Link href="/privacy" onClick={close} className={menuItemClass}>
              Privacy
            </Link>
          </nav>
        </>
      )}
    </MenuSheet>
  );
}
