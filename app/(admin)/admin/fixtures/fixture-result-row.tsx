"use client";

import { useState, useTransition } from "react";
import { importFixturesAction } from "@/lib/actions/fixtures";
import type { NormalizedFixture } from "@/lib/sports-data/types";
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
  fixture: NormalizedFixture;
  selected: boolean;
  onToggleSelect: () => void;
  imported: boolean;
  onImported: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleImport() {
    setError(null);
    startTransition(async () => {
      const [result] = await importFixturesAction([fixture.externalFixtureId]);
      if (!result.success) {
        setError(result.error);
        return;
      }
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
          </div>
          {error && <div className="text-xs text-danger">{error}</div>}
        </div>
        <Button type="button" size="sm" disabled={isPending || imported} onClick={handleImport}>
          {imported ? "Imported" : isPending ? "Importing…" : "Import"}
        </Button>
      </CardContent>
    </Card>
  );
}
