import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LocalDateTime } from "@/components/LocalDateTime";
import { formatSignedCents } from "@/lib/analytics/format";
import { formatCents } from "@/lib/utils/money";
import { cn } from "@/lib/utils";
import type { EntryHistoryItem } from "@/lib/analytics/userAnalyticsService";
import { ChartEmptyState } from "./ChartEmptyState";

interface EntryHighlightsTableProps {
  title: string;
  description?: string;
  entries: EntryHistoryItem[];
  emptyMessage?: string;
}

export function EntryHighlightsTable({ title, description, entries, emptyMessage }: EntryHighlightsTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <ChartEmptyState message={emptyMessage ?? "No settled pools in this range yet."} />
        ) : (
          <div className="-mx-(--card-spacing) overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-left text-xs text-text-muted">
                  <th className="px-(--card-spacing) py-2 font-medium">Question</th>
                  <th className="px-(--card-spacing) py-2 font-medium">Selected</th>
                  <th className="px-(--card-spacing) py-2 text-right font-medium">Entry</th>
                  <th className="px-(--card-spacing) py-2 text-right font-medium">Net result</th>
                  <th className="px-(--card-spacing) py-2 text-right font-medium">Final share</th>
                  <th className="px-(--card-spacing) py-2 text-right font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.entryId} className="border-b border-border-subtle last:border-0">
                    <td className="px-(--card-spacing) py-2">
                      <div className="font-medium text-text-primary">{entry.question}</div>
                      {entry.fixtureLabel && <div className="text-xs text-text-muted">{entry.fixtureLabel}</div>}
                    </td>
                    <td className="px-(--card-spacing) py-2 text-text-secondary">{entry.optionLabel}</td>
                    <td className="px-(--card-spacing) py-2 text-right text-text-secondary tabular-nums">
                      {formatCents(entry.amount)}
                    </td>
                    <td
                      className={cn(
                        "px-(--card-spacing) py-2 text-right font-medium tabular-nums",
                        entry.netResult > 0 ? "text-pool-win" : entry.netResult < 0 ? "text-pool-loss" : "text-text-muted",
                      )}
                    >
                      {formatSignedCents(entry.netResult)}
                    </td>
                    <td className="px-(--card-spacing) py-2 text-right text-text-secondary tabular-nums">
                      {entry.finalOptionShare !== null ? `${entry.finalOptionShare}%` : "—"}
                    </td>
                    <td className="px-(--card-spacing) py-2 text-right text-text-muted">
                      <LocalDateTime iso={entry.createdAt} options={{ month: "short", day: "numeric" }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
