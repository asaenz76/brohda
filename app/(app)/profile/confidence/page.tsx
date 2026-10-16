import { notFound } from "next/navigation";
import { requireMemberAccount } from "@/lib/auth/session";
import { getMyConfidence, getMyConfidenceHistory } from "@/lib/confidence/service";
import { describeEntry, describeEntryChange, formatConfidence } from "@/lib/confidence/format";
import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { LocalDateTime } from "@/components/LocalDateTime";

export const dynamic = "force-dynamic";

// Your own Confidence history — private to you. A 404 while the capability is OFF. Shows the date, what it was, the change and the balance after; never an admin note, reason or any internal field.
export default async function ConfidenceHistoryPage() {
  const user = await requireMemberAccount();
  const mine = await getMyConfidence(user.id);
  if (!mine) notFound();
  const history = await getMyConfidenceHistory(100);
  return (
    <div className="space-y-3">
      <ColumnHeader title="Confidence" backHref="/profile" backLabel="Profile" />
      <p className="text-sm text-text-secondary" data-slot="confidence-history-total">
        You have <span className="font-semibold text-text-primary">{formatConfidence(mine.total)}</span>.
        {mine.reserved > 0 && (
          <span data-slot="confidence-split">
            {" "}
            {formatConfidence(mine.available)} available · {formatConfidence(mine.reserved)} reserved behind your picks.
          </span>
        )}
      </p>
      {history.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing here yet.</p>
      ) : (
        <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle" data-slot="confidence-history">
          {history.map((row) => (
            <li key={row.id} className="flex items-baseline justify-between gap-3 px-4 py-3 text-sm" data-slot="confidence-history-row">
              <div>
                <p className="font-medium text-text-primary">{describeEntry(row.entryType)}</p>
                <p className="text-xs text-text-muted">
                  <LocalDateTime iso={row.createdAt} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
                </p>
              </div>
              <div className="text-right">
                <p className="font-semibold text-text-primary">{describeEntryChange(row.entryType, row.availableDelta, row.reservedDelta).headline}</p>
                {describeEntryChange(row.entryType, row.availableDelta, row.reservedDelta).detail && (
                  <p className="text-xs text-text-secondary">{describeEntryChange(row.entryType, row.availableDelta, row.reservedDelta).detail}</p>
                )}
                <p className="text-xs text-text-muted">{formatConfidence(row.balanceAfter)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
