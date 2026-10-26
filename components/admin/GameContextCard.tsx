"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { setGameContextPolicyAction, type GameContextAdminResult } from "@/lib/actions/game-context-admin";
import { GAME_CONTEXT_FIELDS } from "@/lib/game-context/config";
import type { GameContextConfig } from "@/lib/game-context/types";

const LABEL: Record<string, string> = {
  min_win_streak: "Shortest winning streak worth a line",
  min_loss_streak: "Shortest losing streak worth a line",
  min_venue_streak: "Shortest home-only or road-only streak worth a line",
  last_n: "Games in the “last N” record",
  last_n_min_decisive: "Wins (or losses) out of those N for the record to be notable",
  series_enabled: "Say how the two teams' earlier meetings this season went",
  pairs_enabled: "Pair a fact about each team when both are worth saying",
  connective_enabled: "Add a closing sentence to a winning streak",
  min_score: "Minimum score for a fact to be shown",
  max_chars: "Longest line, in characters",
};

type Draft = Record<string, number | boolean>;

const toDraft = (c: GameContextConfig): Draft => Object.fromEntries(GAME_CONTEXT_FIELDS.map((f) => [f.key, c[f.prop] as number | boolean]));

/**
 * Super Admin: Game Context — one short line of fact per Game, computed from the sports data Brohda already stores (no AI, no web, no cost). Off by default. Saving is one audited call and rewrites nothing;
 * turning it off is the whole rollback.
 */
export function GameContextCard({ initial }: { initial: GameContextConfig }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<GameContextAdminResult | null>(null);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [draft, setDraft] = useState<Draft>(toDraft(initial));
  const initialDraft = toDraft(initial);
  const dirty = enabled !== initial.enabled || GAME_CONTEXT_FIELDS.some((f) => draft[f.key] !== initialDraft[f.key]);
  const save = () => start(async () => setResult(await setGameContextPolicyAction({ enabled, config: draft })));

  return (
    <section aria-label="Game Context" data-slot="game-context-policy" className="space-y-3 rounded-lg border border-border-subtle p-3 text-sm">
      <h2 className="text-sm font-semibold text-text-primary">Game Context</h2>
      <p className="text-xs text-text-muted">
        One short line of fact on a Game, such as a winning streak, worked out from the results Brohda already stores. Nothing is written by an AI or fetched from the web, and a Game with nothing worth saying shows nothing. It never changes a Pick, Confidence, Call BS or grading. Turning it off removes the line everywhere.
      </p>

      <label className="flex items-center gap-1.5" data-slot="game-context-enabled">
        <input type="checkbox" checked={enabled} disabled={pending} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="font-medium text-text-primary">Show Game Context</span>
      </label>

      <div className="grid gap-2 sm:grid-cols-2">
        {GAME_CONTEXT_FIELDS.map((f) =>
          f.kind === "bool" ? (
            <label key={f.key} className="flex items-center gap-1.5">
              <input type="checkbox" checked={draft[f.key] === true} disabled={pending} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.checked })} />
              <span>{LABEL[f.key]}</span>
            </label>
          ) : (
            <label key={f.key} className="flex items-center justify-between gap-2">
              <span>{LABEL[f.key]}</span>
              <input
                type="number"
                min={f.min}
                max={f.max}
                step={1}
                value={Number(draft[f.key])}
                disabled={pending}
                onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
                className="w-20 rounded-md border border-border-subtle bg-transparent px-2 py-1 text-right"
              />
            </label>
          ),
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={pending || !dirty} onClick={save}>
          Save Game Context
        </Button>
        {result && (
          <p role={result.success ? "status" : "alert"} className={result.success ? "text-xs text-text-secondary" : "text-xs text-destructive"}>
            {result.success ? result.message : result.error}
          </p>
        )}
      </div>
    </section>
  );
}
