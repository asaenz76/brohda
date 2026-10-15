"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { setConfidenceConfigAction, type ConfidenceAdminResult } from "@/lib/actions/confidence-admin";
import type { ConfidenceSettingsForAdmin } from "@/lib/confidence/config";

const input = "block h-9 w-full rounded-md border border-border-subtle bg-surface-primary px-2 text-sm text-text-primary";

export function ConfidenceSettingsForm({ settings }: { settings: ConfidenceSettingsForAdmin }) {
  const [state, action, pending] = useActionState<ConfidenceAdminResult | null, FormData>(setConfidenceConfigAction, null);
  return (
    <form action={action} className="space-y-3" data-slot="confidence-settings-form">
      <label className="flex items-center gap-2 text-sm font-medium text-text-primary">
        <input type="checkbox" name="confidence_enabled" defaultChecked={settings.enabled} className="size-4" />
        Members can see and earn Confidence
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs font-medium text-text-secondary">
          Baseline (Confidence)
          <input type="number" name="confidence_baseline" min={1} max={1000000} defaultValue={settings.baseline} className={input} aria-describedby="conf-baseline-help" />
          <span id="conf-baseline-help" className="block font-normal text-text-muted">
            What a new Member starts with and the ceiling for Daily Claims. Changing it never changes anyone&apos;s existing balance.
          </span>
        </label>
        <label className="space-y-1 text-xs font-medium text-text-secondary">
          Daily Claim (Confidence)
          <input type="number" name="confidence_daily_claim_amount" min={1} max={5} defaultValue={settings.dailyClaimAmount} className={input} aria-describedby="conf-claim-help" />
          <span id="conf-claim-help" className="block font-normal text-text-muted">
            What one claim restores, 1 to 5. A claim can never take a Member above the baseline.
          </span>
        </label>
        <label className="space-y-1 text-xs font-medium text-text-secondary">
          Time between claims (hours)
          <input type="number" name="confidence_daily_claim_interval_hours" min={1} max={168} defaultValue={settings.dailyClaimIntervalHours} className={input} aria-describedby="conf-interval-help" />
          <span id="conf-interval-help" className="block font-normal text-text-muted">
            Counted from a Member&apos;s last claim, not from midnight, so time zones never matter.
          </span>
        </label>
        <label className="space-y-1 text-xs font-medium text-text-secondary">
          Future pick sizes
          <input type="text" name="confidence_allowed_stakes" defaultValue={settings.allowedStakes.join(", ")} className={input} aria-describedby="conf-stakes-help" />
          <span id="conf-stakes-help" className="block font-normal text-text-muted">
            Increasing whole numbers, like 1, 2, 3, 4, 5. Nothing uses this until Confidence-backed Picks exist.
          </span>
        </label>
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        Save
      </Button>
      {state && (
        <p role={state.success ? "status" : "alert"} className={state.success ? "text-xs font-medium text-text-primary" : "text-xs font-medium text-warning-muted"}>
          {state.error ?? state.message}
        </p>
      )}
    </form>
  );
}
