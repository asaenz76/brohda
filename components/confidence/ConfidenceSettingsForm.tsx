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
      <label className="flex items-start gap-2 text-sm font-medium text-text-primary">
        <input type="checkbox" name="confidence_backed_picks_enabled" defaultChecked={settings.backedPicksEnabled} className="mt-0.5 size-4" />
        <span>
          Members can make predictions
          <span className="block text-xs font-normal text-text-muted">Every prediction is a side and the Confidence behind it, made in one step. Turning this off pauses new predictions; Confidence already behind a prediction still settles from the result.</span>
        </span>
      </label>
      {settings.mandatorySince ? (
        // Permanent once set: shown, not editable. (A disabled field is not submitted, and the action only ever sends "on", so nothing here can unset it.)
        <div className="flex items-start gap-2 text-sm font-medium text-text-primary" data-slot="confidence-mandatory-locked">
          <input type="checkbox" checked disabled readOnly className="mt-0.5 size-4" aria-label="No Pick can exist without Confidence — permanent" />
          <span>
            No Pick can exist without Confidence — permanent
            <span className="block text-xs font-normal text-text-muted" data-slot="confidence-mandatory-since">
              Enforced in the database since {new Date(settings.mandatorySince).toUTCString()}. This is a permanent boundary, not a setting: it can&apos;t be turned off here. To pause predictions use &ldquo;Members can make predictions&rdquo; above.
            </span>
          </span>
        </div>
      ) : (
        <label className="flex items-start gap-2 text-sm font-medium text-text-primary">
          <input type="checkbox" name="confidence_mandatory" className="mt-0.5 size-4" data-slot="confidence-mandatory" />
          <span>
            Make it permanent: no Pick can exist without Confidence
            <span className="block text-xs font-normal text-text-muted" data-slot="confidence-mandatory-since">
              Not enforced yet. Once saved, the database refuses any new Pick that has no Confidence behind it, from that moment on — and <strong>this can&apos;t be undone from Settings</strong>. Earlier picks are never changed. Needs predictions on.
            </span>
          </span>
        </label>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs font-medium text-text-secondary">
          Baseline (Confidence)
          <input type="number" name="confidence_baseline" min={1} defaultValue={settings.baseline} className={input} aria-describedby="conf-baseline-help" />
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
          <input type="number" name="confidence_daily_claim_interval_hours" min={1} defaultValue={settings.dailyClaimIntervalHours} className={input} aria-describedby="conf-interval-help" />
          <span id="conf-interval-help" className="block font-normal text-text-muted">
            Counted from a Member&apos;s last claim, not from midnight, so time zones never matter.
          </span>
        </label>
        <label className="space-y-1 text-xs font-medium text-text-secondary">
          Confidence choices on a prediction
          <input type="text" name="confidence_allowed_stakes" defaultValue={settings.allowedStakes.join(", ")} className={input} aria-describedby="conf-stakes-help" />
          <span id="conf-stakes-help" className="block font-normal text-text-muted">
            Increasing whole numbers, like 1, 2, 3, 4, 5. The smallest is the least a Member must put behind a prediction.
          </span>
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold uppercase tracking-wide text-text-muted">What a graded pick says about Confidence</legend>
        {(
          [
            ["confidence_notify_correct", "When the pick was correct", settings.notifyCorrect],
            ["confidence_notify_incorrect", "When the pick was incorrect", settings.notifyIncorrect],
            ["confidence_notify_void", "When the pick was void", settings.notifyVoid],
          ] as const
        ).map(([name, label, value]) => (
          <label key={name} className="block space-y-1 text-xs font-medium text-text-secondary">
            {label}
            <input type="text" name={name} defaultValue={value} maxLength={200} className={input} />
          </label>
        ))}
        <p className="text-xs text-text-muted">Added to the existing &ldquo;your pick was graded&rdquo; notification. Use {"{{amount}}"} for the committed amount.</p>
      </fieldset>
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
