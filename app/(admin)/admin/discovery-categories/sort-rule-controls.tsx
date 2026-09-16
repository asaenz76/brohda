"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateSortRuleAction } from "@/lib/actions/discovery-categories";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import type { SortCriterion, SortDirection } from "@/lib/prediction-markets/discovery/ordering";

// The smallest control surface for discovery_sort_policy (hard-coding
// remediation Finding 1) — priority, direction, enabled, per fixed
// criterion. Not a generic rule builder: the three rows are fixed
// (FRESHNESS/CLOSE_TIME/LIQUIDITY are the closed set of supported
// primitives), only their configured priority/direction/enabled state is
// editable.

export function SortRuleControls({ criterion, priority, direction, enabled }: { criterion: SortCriterion; priority: number; direction: SortDirection; enabled: boolean }) {
  const router = useRouter();
  const [priorityDraft, setPriorityDraft] = useState(String(priority));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function commitPatch(patch: { priority?: number; direction?: SortDirection; enabled?: boolean }) {
    setError(null);
    startTransition(async () => {
      const result = await updateSortRuleAction(criterion, patch);
      if (!result.success) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function commitPriority() {
    const parsed = Number(priorityDraft);
    if (!Number.isInteger(parsed) || parsed === priority) return;
    commitPatch({ priority: parsed });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Input
        type="number"
        value={priorityDraft}
        onChange={(e) => setPriorityDraft(e.target.value)}
        onBlur={commitPriority}
        disabled={isPending}
        aria-label={`${criterion} priority`}
        className="h-8 w-16 text-sm"
      />
      <select
        value={direction}
        onChange={(e) => commitPatch({ direction: e.target.value as SortDirection })}
        disabled={isPending}
        aria-label={`${criterion} direction`}
        className="h-8 rounded-md border border-border-subtle bg-surface-primary px-2 text-sm"
      >
        <option value="ASC">Ascending</option>
        <option value="DESC">Descending</option>
      </select>
      <Switch checked={enabled} onCheckedChange={(v) => commitPatch({ enabled: v })} disabled={isPending} aria-label={enabled ? `Disable ${criterion}` : `Enable ${criterion}`} />
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
