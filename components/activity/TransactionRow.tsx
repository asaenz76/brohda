"use client";

import { formatCents } from "@/lib/utils/money";
import { voidReasonLabel } from "@/lib/pools/notices";
import { cn } from "@/lib/utils";

export interface TransactionRowProps {
  id: string;
  label: string;
  direction: "credit" | "debit";
  amount: number;
  reason: string | null;
  createdAt: string;
  /** Pool title/question — the "which pool was this" context the label
   *  alone never gives ("Entered a pool" tells you nothing on its own). */
  poolQuestion: string | null;
  fixtureLabel: string | null;
  optionLabel: string | null;
  highlighted: boolean;
  onClick: () => void;
}

// Presentational only — TransactionList owns which row's detail sheet is
// open (and the hash-triggered auto-open), this just renders one compact,
// always-clickable row. `id="tx-{id}"` stays a plain DOM anchor id (not a
// React ref) so a notification's <a href="/activity#tx-{id}"> can scroll to
// it the same way it always could.
export function TransactionRow({
  id,
  label,
  direction,
  amount,
  reason,
  createdAt,
  poolQuestion,
  fixtureLabel,
  optionLabel,
  highlighted,
  onClick,
}: TransactionRowProps) {
  const isCredit = direction === "credit";
  // Fixture name (e.g. "Arsenal vs Chelsea") is the more identifying half
  // when both exist — CUSTOM/COMBO pools have no fixture, so poolQuestion
  // is all there is for those.
  const context = fixtureLabel ?? poolQuestion;

  return (
    <li
      id={`tx-${id}`}
      className={cn(
        "rounded-xl border border-border-subtle bg-surface-primary transition-shadow",
        highlighted && "ring-2 ring-accent-primary",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary">{label}</div>
          {context && (
            <div className="truncate text-xs text-text-secondary">
              {context}
              {optionLabel && <span className="text-text-muted"> · Picked: {optionLabel}</span>}
            </div>
          )}
          {reason && <div className="text-xs text-text-muted">{voidReasonLabel(reason)}</div>}
          <div className="text-xs text-text-muted">{new Date(createdAt).toLocaleString()}</div>
        </div>
        <span className={cn("shrink-0 font-semibold", isCredit ? "text-credit" : "text-debit")}>
          {isCredit ? "+" : "-"}
          {formatCents(amount)}
        </span>
      </button>
    </li>
  );
}
