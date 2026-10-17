"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { setGamePreviewConfigAction, withdrawGamePreviewAction, type GamePreviewAdminResult } from "@/lib/actions/game-previews-admin";
import type { GamePreviewConfig } from "@/lib/game-previews/types";

const input = "block h-9 w-full rounded-md border border-border-subtle bg-surface-primary px-2 text-sm text-text-primary";

const FIELDS: Array<{ name: string; key: keyof GamePreviewConfig; label: string; help: string; min: number; max: number }> = [
  { name: "max_chars", key: "maxChars", label: "Preview length (characters)", help: "The longest a Preview story may be. Longer text is refused, never cut.", min: 100, max: 2000 },
  { name: "hook_max_chars", key: "hookMaxChars", label: "Hook length (characters)", help: "The longest the headline may be.", min: 20, max: 300 },
  { name: "lead_hours", key: "leadHours", label: "Prepare a Game this many hours before kickoff", help: "A Game appears in “needs a Preview” once it starts within this many hours.", min: 1, max: 720 },
  { name: "stale_after_hours", key: "staleAfterHours", label: "Stale after (hours)", help: "A Preview not re-checked for this long may be refreshed before kickoff.", min: 1, max: 720 },
  { name: "min_refresh_interval_hours", key: "minRefreshIntervalHours", label: "Minimum hours between refreshes", help: "A new story may replace a Preview only after this long, so it is never rewritten continuously.", min: 0, max: 720 },
];

export function GamePreviewConfigForm({ config }: { config: GamePreviewConfig }) {
  const [state, action, pending] = useActionState<GamePreviewAdminResult | null, FormData>(setGamePreviewConfigAction, null);
  return (
    <form action={action} className="space-y-3" data-slot="game-preview-config-form">
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <label key={f.name} className="space-y-1 text-xs font-medium text-text-secondary">
            {f.label}
            <input type="number" name={f.name} min={f.min} max={f.max} defaultValue={config[f.key]} className={input} />
            <span className="block font-normal text-text-muted">{f.help}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {state?.error && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
        {state?.success && (
          <p role="status" className="text-sm text-text-secondary">
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}

export function WithdrawPreviewForm({ fixtureId }: { fixtureId: string }) {
  const [state, action, pending] = useActionState<GamePreviewAdminResult | null, FormData>(withdrawGamePreviewAction, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2" data-slot="withdraw-preview-form">
      <input type="hidden" name="fixture_id" value={fixtureId} />
      <input name="reason" required minLength={3} maxLength={500} placeholder="Why it is wrong" aria-label="Why this Preview is being withdrawn" className={`${input} max-w-xs`} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Withdrawing…" : "Withdraw"}
      </Button>
      {state?.error && (
        <p role="alert" className="text-xs text-danger">
          {state.error}
        </p>
      )}
      {state?.success && (
        <p role="status" className="text-xs text-text-secondary">
          {state.message}
        </p>
      )}
    </form>
  );
}
