import type { AdminPredictionRow } from "@/lib/predictions/admin-rows";
import { cn } from "@/lib/utils";

// A dense, read-only operator table: the human-readable value first, the id
// beside it in muted text. Long Match/Market text truncates with the full
// value in the title attribute; the table keeps a minimum width and scrolls
// sideways on narrow screens rather than squashing those columns.
function Cell({ primary, secondary, known, fullId, className }: { primary: string; secondary: string; known: boolean; fullId: string; className?: string }) {
  return (
    <div className={cn("max-w-[18rem]", className)}>
      <p className={cn("truncate", known ? "text-text-primary" : "italic text-text-muted")} title={primary}>
        {primary}
      </p>
      <p className="font-mono text-xs text-text-muted" title={fullId}>
        {secondary}
      </p>
    </div>
  );
}

export function AdminPredictionsTable({ rows }: { rows: AdminPredictionRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border-subtle">
      <table className="w-full min-w-[1040px] text-sm">
        <thead className="bg-surface-secondary text-left text-text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">Created</th>
            <th className="px-3 py-2 font-medium">User</th>
            <th className="px-3 py-2 font-medium">Match</th>
            <th className="px-3 py-2 font-medium">Market</th>
            <th className="px-3 py-2 font-medium">Selected</th>
            <th className="px-3 py-2 font-medium">Snapshot (YES / NO)</th>
            <th className="px-3 py-2 font-medium">State</th>
            <th className="px-3 py-2 font-medium">Result</th>
            <th className="px-3 py-2 font-medium">Graded</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="whitespace-nowrap px-3 py-1.5 text-text-secondary">{new Date(r.createdAt).toLocaleString()}</td>
              <td className="px-3 py-1.5">
                <Cell primary={r.user.primary} secondary={r.user.shortId} known={r.user.known} fullId={r.user.id} className="max-w-[12rem]" />
              </td>
              <td className="px-3 py-1.5">
                <p className={cn("max-w-[18rem] truncate", r.match.known ? "text-text-primary" : "italic text-text-muted")} title={r.match.primary}>
                  {r.match.primary}
                </p>
              </td>
              <td className="px-3 py-1.5">
                <Cell primary={r.market.primary} secondary={r.market.shortId} known={r.market.known} fullId={r.market.id} />
              </td>
              <td className="px-3 py-1.5">
                {/* The human label leads; the canonical stored value stays beside it for diagnostics. */}
                <Cell primary={r.selectedLabel ?? r.selectedOutcome} secondary={r.selectedLabel ? r.selectedOutcome : "canonical"} known={r.selectedLabel !== null} fullId={r.selectedOutcome} className="max-w-[14rem]" />
              </td>
              <td className="whitespace-nowrap px-3 py-1.5 text-text-secondary">
                {r.yesPercent}% / {r.noPercent}%
              </td>
              <td className="px-3 py-1.5 text-text-secondary">{r.lifecycleState}</td>
              <td className="px-3 py-1.5 text-text-secondary">{r.result ?? "—"}</td>
              <td className="whitespace-nowrap px-3 py-1.5 text-text-secondary">{r.gradedAt ? new Date(r.gradedAt).toLocaleString() : "—"}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className="px-3 py-8 text-center text-text-muted">
                No predictions yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
