"use client";

import { useState, useTransition } from "react";
import { syncCompetitionNowAction, retryCompetitionImportAction } from "@/lib/actions/competitions";
import { Button } from "@/components/ui/button";

export function SyncActions({ leagueSeasonImportId, failedJobId }: { leagueSeasonImportId: string; failedJobId: string | null }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await syncCompetitionNowAction(leagueSeasonImportId);
            setMessage(result.success ? "Sync completed." : result.error);
          })
        }
      >
        Sync now
      </Button>
      {failedJobId && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await retryCompetitionImportAction(failedJobId);
              setMessage(result.success ? "Retry completed." : result.error);
            })
          }
        >
          Retry import
        </Button>
      )}
      {message && <span className="text-xs text-text-secondary">{message}</span>}
    </div>
  );
}
