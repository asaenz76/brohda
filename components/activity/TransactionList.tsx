"use client";

import { useEffect, useState } from "react";
import { groupByDate } from "@/lib/utils/date-grouping";
import type { LedgerEntry } from "@/lib/wallet/ledger";
import { TransactionRow } from "./TransactionRow";
import { TransactionDetailSheet } from "./TransactionDetailSheet";

// Renders the full ledger (grouped Today/Yesterday/This week/Earlier) and
// owns which single transaction's detail sheet is open. Every row is
// clickable here, not just pool-linked ones — replaces the old per-row
// inline accordion, which only worked for rows with a pool attached.
export function TransactionList({ entries }: { entries: LedgerEntry[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  // A money notification deep-links here as /activity#tx-{id} (see
  // lib/notifications/links.ts) — open that transaction's detail sheet
  // directly instead of just scrolling to a collapsed row, so clicking a
  // notification and clicking the row it's about land on the same view.
  // Also listens for "hashchange": a notification link clicked while
  // already on this page only updates the fragment, it doesn't remount
  // this component — relies on that link being a plain <a>, not next/link,
  // since client-side routing's history.pushState never fires this event.
  useEffect(() => {
    function syncFromHash() {
      const match = window.location.hash.match(/^#tx-(.+)$/);
      if (!match) return;
      const id = match[1];
      if (!entries.some((e) => e.id === id)) return;

      setOpenId(id);
      setHighlightedId(id);
      document.getElementById(`tx-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => setHighlightedId(null), 2500);
    }

    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dateGroups = groupByDate(entries, (e) => e.createdAt);
  const openEntry = entries.find((e) => e.id === openId) ?? null;

  return (
    <>
      <div className="space-y-4">
        {dateGroups.map((group) => (
          <div key={group.label} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              {group.label}
            </h3>
            <ul className="space-y-2">
              {group.items.map((entry) => (
                <TransactionRow
                  key={entry.id}
                  id={entry.id}
                  label={entry.label}
                  direction={entry.direction}
                  amount={entry.amount}
                  reason={entry.reason}
                  createdAt={entry.createdAt}
                  poolQuestion={entry.poolQuestion}
                  fixtureLabel={entry.fixtureLabel}
                  optionLabel={entry.optionLabel}
                  highlighted={highlightedId === entry.id}
                  onClick={() => setOpenId(entry.id)}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>

      {openEntry && <TransactionDetailSheet entry={openEntry} onClose={() => setOpenId(null)} />}
    </>
  );
}
