"use client";

import { useId, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * "See more markets" / "Show fewer markets": the Game's other Markets expand INLINE inside the same card — no navigation, no reload, no modal, no URL change. Expansion is plain component state (nothing is stored):
 * the Markets stay mounted while collapsed, so collapsing never touches a Pick, a Confidence amount or any lock — it only hides them. The server renders the Markets (with each Pick's own state) as `children`.
 */
export function MoreMarkets({ count, label, children }: { count: number; label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <div className="space-y-2">
      <div id={panelId} hidden={!open} className="space-y-3 border-t border-border-subtle pt-3" data-slot="more-markets-panel">
        <p className="text-sm font-semibold text-text-primary">Make your prediction</p>
        {children}
      </div>
      <button
        type="button"
        data-slot="see-more-markets"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? `Show fewer markets for ${label}` : `See more markets for ${label} (${count})`}
        onClick={() => setOpen((v) => !v)}
        className="-mx-1 inline-flex min-h-9 items-center gap-0.5 rounded-md px-1 text-xs font-semibold uppercase tracking-wide text-accent-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {open ? "Show fewer markets" : "See more markets"}
        <Chevron className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
