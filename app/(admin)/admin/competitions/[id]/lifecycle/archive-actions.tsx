"use client";

import { useState, useTransition } from "react";
import { setCompetitionArchivedAction } from "@/lib/actions/competitions";
import { Button } from "@/components/ui/button";

export function ArchiveActions({ leagueSeasonImportId, isActive }: { leagueSeasonImportId: string; isActive: boolean }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant={isActive ? "outline" : "default"}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await setCompetitionArchivedAction(leagueSeasonImportId, isActive);
            setMessage(result.success ? (isActive ? "Archived." : "Un-archived.") : result.error);
          })
        }
      >
        {isActive ? "Archive competition" : "Un-archive competition"}
      </Button>
      {message && <span className="text-xs text-text-secondary">{message}</span>}
    </div>
  );
}
