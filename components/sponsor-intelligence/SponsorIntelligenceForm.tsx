"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { setSponsorIntelligenceConfigAction, type SponsorIntelligenceResult } from "@/lib/actions/sponsor-intelligence";

export function SponsorIntelligenceForm({ enabled, minCohort, lookbackDays }: { enabled: boolean; minCohort: number; lookbackDays: number }) {
  const [state, action, pending] = useActionState<SponsorIntelligenceResult | null, FormData>(setSponsorIntelligenceConfigAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3" data-slot="sponsor-intelligence-form">
      <label className="flex items-center gap-2 text-sm font-medium text-text-primary">
        <input type="checkbox" name="enabled" defaultChecked={enabled} className="size-4" />
        Sponsors can see campaign results
      </label>
      <label className="space-y-1 text-xs font-medium text-text-secondary">
        Hide figures under this many Members
        <input type="number" name="minCohort" min={2} max={10000} defaultValue={minCohort} className="block h-9 w-24 rounded-md border border-border-subtle bg-surface-primary px-2 text-sm text-text-primary" />
      </label>
      <label className="space-y-1 text-xs font-medium text-text-secondary">
        Sport-affinity look-back (days)
        <input type="number" name="lookbackDays" min={1} max={730} defaultValue={lookbackDays} className="block h-9 w-24 rounded-md border border-border-subtle bg-surface-primary px-2 text-sm text-text-primary" />
      </label>
      <Button type="submit" variant="outline" disabled={pending}>
        Save
      </Button>
      {state && (
        <p role={state.success ? "status" : "alert"} className={state.success ? "w-full text-xs font-medium text-text-primary" : "w-full text-xs font-medium text-warning-muted"}>
          {state.error ?? state.message}
        </p>
      )}
    </form>
  );
}
