"use client";

import { useState } from "react";
import Link from "next/link";
import { Dialog } from "@base-ui/react/dialog";
import { Menu, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DISCOVERY_TABS, DISCOVERY_TAB_LABELS } from "@/lib/communities/discovery-tabs";

// The hamburger half of the logged-out mobile bottom bar: a compact sheet,
// not a second navigation system. It holds only what the bar and the
// centre column don't — Search (which needs an account, and says so), quick
// jumps to the same three tabs the centre column already has, a line about
// Brohda, and the legal links. @base-ui's Dialog supplies the modal
// behaviour: focus is trapped inside the sheet, Escape and the backdrop
// close it, and focus returns to the hamburger button.

const itemClass =
  "flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium text-text-primary outline-none hover:bg-surface-secondary focus-visible:ring-3 focus-visible:ring-ring/50";

export function PublicMobileMenu({ about, className }: { about: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        aria-label="Open menu"
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-md text-text-primary outline-none hover:bg-surface-secondary focus-visible:ring-3 focus-visible:ring-ring/50",
          className,
        )}
      >
        <Menu className="size-6" aria-hidden="true" />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Popup
          data-testid="public-mobile-menu"
          className="fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-xl border-t border-border-subtle bg-background px-3 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] outline-none"
        >
          <div className="flex items-center justify-between px-3">
            <Dialog.Title className="text-base font-semibold text-text-primary">Menu</Dialog.Title>
            <Dialog.Close
              aria-label="Close menu"
              className="flex size-11 items-center justify-center rounded-md text-text-secondary outline-none hover:bg-surface-secondary focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <X className="size-5" aria-hidden="true" />
            </Dialog.Close>
          </div>

          <nav aria-label="Menu" className="space-y-1">
            <Link href="/login" onClick={close} className={itemClass}>
              <Search className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
              <span>Search</span>
              <span className="ml-auto text-xs font-normal text-text-muted">Log in to search</span>
            </Link>
            {DISCOVERY_TABS.map((tab) => (
              <Link key={tab} href={`/?tab=${tab}`} onClick={close} className={itemClass}>
                {DISCOVERY_TAB_LABELS[tab]}
              </Link>
            ))}
          </nav>

          <section aria-label="About Brohda" className="mt-3 space-y-1 border-t border-border-subtle px-3 pt-3">
            <h2 className="text-sm font-semibold text-text-primary">About Brohda</h2>
            <p className="text-sm text-text-secondary">{about}</p>
          </section>

          <nav aria-label="Legal" className="mt-2 space-y-1 border-t border-border-subtle pt-2">
            <Link href="/terms" onClick={close} className={itemClass}>
              Terms
            </Link>
            <Link href="/privacy" onClick={close} className={itemClass}>
              Privacy
            </Link>
          </nav>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
