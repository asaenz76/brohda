"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { setConfidenceOptionalPicksAction, setConfidenceTwoStepComposerAction, type ConfidenceAdminResult } from "@/lib/actions/confidence-admin";

/**
 * Super Admin: the two Brohda 2.1 switches. "Picks without Confidence" is the database policy (audited, reversible, never rewrites a Pick); "Two-step composer" is only what Members see. Turn the policy on only after
 * the composer has been checked; the composer does nothing until the policy is on.
 */
export function ConfidenceOptionalPicksCard({ optionalPicksEnabled, optionalFirstEnabledAt, twoStepComposerEnabled }: { optionalPicksEnabled: boolean; optionalFirstEnabledAt: string | null; twoStepComposerEnabled: boolean }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ConfidenceAdminResult | null>(null);
  const run = (fn: () => Promise<ConfidenceAdminResult>) => start(async () => setResult(await fn()));
  return (
    <section aria-label="Picks without Confidence" data-slot="optional-picks" className="space-y-2 rounded-lg border border-border-subtle p-3 text-sm">
      <h2 className="text-sm font-semibold text-text-primary">Picks without Confidence</h2>
      <p className="text-xs text-text-muted">
        When on, a Member can pick a team with no Confidence and change it until the pick locks. Adding Confidence locks the team and fixes the amount for good. When off, every new Pick needs Confidence. Turning it off never changes a Pick that exists.
      </p>
      <div className="flex flex-wrap items-center gap-2" data-slot="optional-picks-policy">
        <span className="font-medium text-text-primary">{optionalPicksEnabled ? "On" : "Off"}</span>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => setConfidenceOptionalPicksAction(!optionalPicksEnabled))}>
          {optionalPicksEnabled ? "Turn off" : "Turn on"}
        </Button>
        {optionalFirstEnabledAt && <span className="text-xs text-text-muted">First turned on {new Date(optionalFirstEnabledAt).toUTCString()} (kept even when off).</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2" data-slot="two-step-composer-flag">
        <span className="font-medium text-text-primary">Two-step composer: {twoStepComposerEnabled ? "On" : "Off"}</span>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => setConfidenceTwoStepComposerAction(!twoStepComposerEnabled))}>
          {twoStepComposerEnabled ? "Turn off" : "Turn on"}
        </Button>
      </div>
      {result && (
        <p role={result.success ? "status" : "alert"} className={result.success ? "text-xs text-text-secondary" : "text-xs text-destructive"}>
          {result.success ? result.message : result.error}
        </p>
      )}
    </section>
  );
}
