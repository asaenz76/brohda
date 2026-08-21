"use client";

import Link from "next/link";
import { formatCents } from "@/lib/utils/money";
import type { CreatePoolTierGroupResult } from "@/lib/actions/pools";
import { MAX_TIERS_PER_GROUP } from "@/lib/validations/pools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** The dynamic entry-fee list — the only part of pool creation that
 *  actually differs between a single pool and a tiered one. Admin types in
 *  each amount directly (never a fixed/hardcoded list); Add/Remove keeps
 *  it between 2 and MAX_TIERS_PER_GROUP. Validation (uniqueness, format)
 *  stays in the parent, since it also needs to feed the wizard's own
 *  step-valid gating — this component just renders the inputs and
 *  whatever error strings the parent hands it. */
export function TierFeeInputs({
  fees,
  onUpdate,
  onAdd,
  onRemove,
  errors,
}: {
  fees: string[];
  onUpdate: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  errors: string[];
}) {
  return (
    <div className="space-y-1.5">
      <Label>Entry fees ($)</Label>
      <div className="space-y-2">
        {fees.map((fee, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              placeholder="5.00"
              value={fee}
              onChange={(e) => onUpdate(i, e.target.value)}
              aria-label={`Entry fee tier ${i + 1}`}
              className="max-w-32"
            />
            <Button type="button" variant="outline" size="sm" disabled={fees.length <= 2} onClick={() => onRemove(i)}>
              Remove
            </Button>
          </div>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" disabled={fees.length >= MAX_TIERS_PER_GROUP} onClick={onAdd}>
        Add another tier
      </Button>
      {errors.map((message) => (
        <p key={message} role="alert" className="text-xs text-danger">
          {message}
        </p>
      ))}
      <p className="text-xs text-text-muted">
        Each amount creates its own fully separate pool — players who enter one tier only ever compete against,
        and are settled with, other players in that same tier. A player can enter at most one tier of this group.
        Platform fee and lock time are shared across every tier.
      </p>
    </div>
  );
}

/** Results view after submitting a tiered creation — mirrors the shape of
 *  createPoolsForFixturesAction's own results list (MultiFixtureBuilder),
 *  just keyed by fee amount instead of fixture id. */
export function TierCreationResults({
  results,
  isPending,
  onRetryWarned,
  onCreateAnother,
}: {
  results: CreatePoolTierGroupResult[];
  isPending: boolean;
  onRetryWarned: () => void;
  onCreateAnother: () => void;
}) {
  const succeeded = results.filter((r) => r.poolId);
  const warned = results.filter((r) => !r.poolId && !r.error && r.warnings && r.warnings.length > 0);
  const failed = results.filter((r) => !r.poolId && (r.error || !r.warnings?.length));

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-text-primary">
        {succeeded.length} of {results.length} tier{results.length === 1 ? "" : "s"} created
        {warned.length > 0 ? `, ${warned.length} need review` : ""}
        {failed.length > 0 ? `, ${failed.length} failed` : ""}.
      </p>
      <ul className="space-y-1.5">
        {results.map((result) => {
          const label = formatCents(result.entryFeeCents);
          const hasWarnings = !result.poolId && !result.error && (result.warnings?.length ?? 0) > 0;
          return (
            <li
              key={result.entryFeeCents}
              className={cn(
                "rounded-lg border px-3 py-2 text-sm",
                result.poolId
                  ? "border-border-subtle"
                  : hasWarnings
                    ? "border-warning-muted/40 bg-warning-muted/10"
                    : "border-danger/40 bg-danger/5",
              )}
            >
              {result.poolId ? (
                <>
                  <span className="text-text-primary">{label}</span> —{" "}
                  <Link href={`/admin/pools/${result.poolId}`} className="text-accent-primary underline underline-offset-4">
                    Created
                  </Link>
                </>
              ) : hasWarnings ? (
                <>
                  <span className="text-text-primary">{label}</span>
                  <ul className="mt-1 list-inside list-disc text-xs text-text-secondary">
                    {result.warnings!.map((w) => (
                      <li key={w.code}>{w.message}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <span className="text-text-primary">{label}</span> —{" "}
                  <span className="text-danger">Failed: {result.error}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {warned.length > 0 && (
        <>
          <p className="text-xs text-text-muted">
            A blocking warning on the first tier stops the whole batch — nothing else was created. Override below
            to proceed anyway.
          </p>
          <Button type="button" variant="outline" disabled={isPending} onClick={onRetryWarned}>
            {isPending ? "Creating…" : "Publish anyway — create all tiers"}
          </Button>
        </>
      )}
      <Button type="button" variant="outline" onClick={onCreateAnother}>
        Create another pool
      </Button>
    </div>
  );
}
