"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { setLeaderboardPolicyAction, type LeaderboardAdminResult } from "@/lib/actions/leaderboard-admin";

export interface LeaderboardPolicy {
  enabled: boolean;
  weeklyMinDecidedPicks: number;
  topN: number;
}

/**
 * Super Admin: the weekly leaderboard — who is doing best this week, from real graded Picks only. Off by default. Saving is one audited call and rewrites nothing; turning it off is the whole rollback.
 * The weekly minimum is separate from the profile percentage minimum on purpose (different questions: "enough Picks to rank this week" vs "enough Picks to show a percentage").
 */
export function LeaderboardCard({ initial }: { initial: LeaderboardPolicy }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<LeaderboardAdminResult | null>(null);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [min, setMin] = useState(initial.weeklyMinDecidedPicks);
  const [topN, setTopN] = useState(initial.topN);
  const dirty = enabled !== initial.enabled || min !== initial.weeklyMinDecidedPicks || topN !== initial.topN;
  const save = () => start(async () => setResult(await setLeaderboardPolicyAction({ enabled, weeklyMinDecidedPicks: min, topN })));

  return (
    <section aria-label="Weekly leaderboard" data-slot="leaderboard-policy" className="space-y-3 rounded-lg border border-border-subtle p-3 text-sm">
      <h2 className="text-sm font-semibold text-text-primary">Weekly leaderboard</h2>
      <p className="text-xs text-text-muted">
        Ranks Members by accuracy on the Games of the current week (Monday to Monday, CST), using graded Picks only. No points, no prizes, nothing stored: each week is just a new window over the same history. Staff accounts are never ranked, and nobody&apos;s rank can be set by hand. It never changes a Pick, Confidence, Call BS or grading. Turning it off removes the page and its navigation entry.
      </p>

      <label className="flex items-center gap-1.5" data-slot="leaderboard-enabled">
        <input type="checkbox" checked={enabled} disabled={pending} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="font-medium text-text-primary">Show the weekly leaderboard</span>
      </label>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-2">
          <span>Decided Picks needed this week to be ranked</span>
          <input type="number" min={1} max={50} step={1} value={min} disabled={pending} onChange={(e) => setMin(Number(e.target.value))} aria-label="Decided Picks needed this week to be ranked" className="w-20 rounded-md border border-border-subtle bg-transparent px-2 py-1 text-right" />
        </label>
        <label className="flex items-center justify-between gap-2">
          <span>Members listed</span>
          <input type="number" min={3} max={100} step={1} value={topN} disabled={pending} onChange={(e) => setTopN(Number(e.target.value))} aria-label="Members listed" className="w-20 rounded-md border border-border-subtle bg-transparent px-2 py-1 text-right" />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={pending || !dirty} onClick={save}>
          Save leaderboard
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
