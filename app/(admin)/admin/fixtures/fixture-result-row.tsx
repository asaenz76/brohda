"use client";

import { useState, useTransition } from "react";
import { importFixturesAction, type FixtureSearchResult } from "@/lib/actions/fixtures";
import { isSupportedCompetition } from "@/lib/sports-data/supported-competitions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";

export function FixtureResultRow({
  fixture,
  selected,
  onToggleSelect,
  imported,
  onImported,
}: {
  fixture: FixtureSearchResult;
  selected: boolean;
  onToggleSelect: () => void;
  imported: boolean;
  onImported: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const supported = isSupportedCompetition(fixture.competitionExternalId);

  function handleImport() {
    setError(null);
    setWarning(null);
    startTransition(async () => {
      const [result] = await importFixturesAction([fixture.externalFixtureId]);
      if (!result.success) {
        setError(result.error);
        return;
      }
      if (result.warning) setWarning(result.warning);
      onImported();
    });
  }

  return (
    <Card>
      <CardContent className="flex items-center gap-4 pt-6">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          disabled={imported}
          aria-label={`Select ${fixture.homeTeamName} vs ${fixture.awayTeamName}`}
        />
        <div className="flex-1">
          <div className="text-sm font-medium text-text-primary">
            {fixture.homeTeamName} vs {fixture.awayTeamName}
          </div>
          <div className="text-xs text-text-muted">
            {fixture.competitionName ?? "Unknown competition"}
            {fixture.round ? ` · ${fixture.round}` : ""} ·{" "}
            {new Date(fixture.scheduledStartUtc).toLocaleString()}
            {!supported && (
              <span className="ml-1.5 rounded-full bg-warning-muted/20 px-1.5 py-0.5 text-[11px] font-medium text-warning-muted">
                Unsupported competition
              </span>
            )}
          </div>
          {error && <div className="text-xs text-danger">{error}</div>}
          {warning && <div className="text-xs text-warning-muted">{warning}</div>}
        </div>
        <Button type="button" size="sm" disabled={isPending || imported} onClick={handleImport}>
          {imported ? "Imported" : isPending ? "Importing…" : "Import"}
        </Button>
      </CardContent>
    </Card>
  );
}
