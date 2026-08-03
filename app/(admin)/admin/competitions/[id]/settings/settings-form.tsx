"use client";

import { useState, useTransition } from "react";
import { setPoolCreationEnabledAction, importHistoricalFixturesAction } from "@/lib/actions/competitions";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

export function SettingsForm({
  leagueSeasonImportId,
  initialPoolCreationEnabled,
  hasHistoricalImport,
}: {
  leagueSeasonImportId: string;
  initialPoolCreationEnabled: boolean;
  hasHistoricalImport: boolean;
}) {
  const [enabled, setEnabled] = useState(initialPoolCreationEnabled);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-lg border border-border-subtle p-3">
        <div>
          <p className="text-sm font-medium text-text-primary">Available for pool creation</p>
          <p className="text-xs text-text-muted">
            Turn off to hide this competition from the pool-creation league filter without archiving it.
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={pending}
          onCheckedChange={(checked) =>
            startTransition(async () => {
              setEnabled(checked);
              const result = await setPoolCreationEnabledAction(leagueSeasonImportId, checked);
              if (!result.success) {
                setEnabled(!checked);
                setMessage(result.error);
              }
            })
          }
        />
      </div>

      <div className="rounded-lg border border-border-subtle p-3">
        <p className="text-sm font-medium text-text-primary">Historical fixtures</p>
        <p className="text-xs text-text-muted">
          {hasHistoricalImport
            ? "Already-played fixtures for this competition have been imported."
            : "Only upcoming fixtures were imported by default. Import already-played fixtures too, if needed."}
        </p>
        {!hasHistoricalImport && (
          <Button
            size="sm"
            className="mt-2"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await importHistoricalFixturesAction(leagueSeasonImportId);
                setMessage(result.success ? "Historical import started." : result.error);
              })
            }
          >
            Import historical fixtures
          </Button>
        )}
      </div>

      {message && <p className="text-xs text-text-secondary">{message}</p>}
    </div>
  );
}
