"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { formatCents } from "@/lib/utils/money";
import { voidReasonLabel } from "@/lib/pools/notices";
import type { LedgerEntry } from "@/lib/wallet/ledger";
import { Button } from "@/components/ui/button";

interface TransactionDetailSheetProps {
  entry: LedgerEntry;
  onClose: () => void;
}

// Same focus-trapped bottom sheet pattern as EntryConfirmationSheet/
// CommentSheet — Escape or a backdrop click dismisses it.
export function TransactionDetailSheet({ entry, onClose }: TransactionDetailSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const isCredit = entry.direction === "credit";

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    sheetRef.current?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !sheetRef.current) return;

      const focusables = sheetRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Transaction details"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[720px] space-y-4 rounded-t-2xl bg-surface-primary p-5 outline-none"
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-border-subtle" aria-hidden="true" />

        <div>
          <p className="text-xs text-text-muted">{new Date(entry.createdAt).toLocaleString()}</p>
          <p className="text-lg font-semibold text-text-primary">{entry.label}</p>
          <p className={isCredit ? "text-2xl font-bold text-credit" : "text-2xl font-bold text-debit"}>
            {isCredit ? "+" : "-"}
            {formatCents(entry.amount)}
          </p>
        </div>

        <dl className="space-y-1.5 text-sm">
          {entry.reason && (
            <div className="flex justify-between gap-4">
              <dt className="text-text-secondary">Reason</dt>
              <dd className="text-right text-text-primary">{voidReasonLabel(entry.reason)}</dd>
            </div>
          )}
          {entry.destination && (
            <div className="flex justify-between gap-4">
              <dt className="text-text-secondary">Sent to</dt>
              <dd className="text-right text-text-primary">{entry.destination}</dd>
            </div>
          )}
          {entry.adminName && (
            <div className="flex justify-between gap-4">
              <dt className="text-text-secondary">Handled by</dt>
              <dd className="text-text-primary">{entry.adminName}</dd>
            </div>
          )}
          {entry.balanceBefore != null && entry.balanceAfter != null && (
            <div className="flex justify-between gap-4">
              <dt className="text-text-secondary">Balance</dt>
              <dd className="text-text-primary">
                {formatCents(entry.balanceBefore)} → {formatCents(entry.balanceAfter)}
              </dd>
            </div>
          )}
        </dl>

        {entry.poolQuestion && (
          <div className="rounded-xl border border-border-subtle p-3">
            {entry.fixtureLabel && (
              <p className="text-sm font-medium text-text-primary">{entry.fixtureLabel}</p>
            )}
            <p className="text-xs text-text-muted">{entry.competitionName ?? "Pool"}</p>
            <p className="text-sm text-text-secondary">{entry.poolQuestion}</p>
            {entry.optionLabel && (
              <p className="mt-1 text-xs text-text-muted">
                You picked <span className="text-text-primary">{entry.optionLabel}</span>
              </p>
            )}
            {entry.poolId && (
              <Link
                href={`/pool/${entry.poolId}`}
                className="mt-1 inline-block text-sm text-accent-primary underline-offset-2 hover:underline"
              >
                View pool
              </Link>
            )}
          </div>
        )}

        {entry.settlement && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl border border-border-subtle p-3 text-sm">
            <dt className="text-text-muted">Gross pool</dt>
            <dd className="text-text-primary">{formatCents(entry.settlement.grossPool)}</dd>
            <dt className="text-text-muted">Platform fee</dt>
            <dd className="text-text-primary">{formatCents(entry.settlement.houseFeeAmount)}</dd>
            <dt className="text-text-muted">Net prize pool</dt>
            <dd className="text-text-primary">{formatCents(entry.settlement.netPrizePool)}</dd>
            <dt className="text-text-muted">Winning entries</dt>
            <dd className="text-text-primary">{entry.settlement.winningEntryCount ?? "—"}</dd>
            <dt className="text-text-muted">Payout per entry</dt>
            <dd className="text-text-primary">{formatCents(entry.settlement.payoutPerEntry)}</dd>
            {entry.settlement.roundingRemainder > 0 && (
              <>
                <dt className="col-span-2 pt-1 text-text-muted">
                  Rounding adjustment retained by the coordinator:
                </dt>
                <dd className="col-span-2 text-text-primary">
                  {formatCents(entry.settlement.roundingRemainder)}
                </dd>
              </>
            )}
          </dl>
        )}

        <Button type="button" variant="outline" className="w-full" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
