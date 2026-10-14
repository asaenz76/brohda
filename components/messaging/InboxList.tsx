import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { LocalDateTime } from "@/components/LocalDateTime";
import { cn } from "@/lib/utils";
import type { InboxRow } from "@/lib/messaging/queries";

// One row per conversation or request. Unread is a dot AND text (never colour alone). A request row opens the conversation, where Accept and Decline live — accepting is never one tap away in a list.
export function InboxList({ rows, empty }: { rows: InboxRow[]; empty: string }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border-subtle p-6 text-center text-sm text-text-muted" data-slot="inbox-empty">
        {empty}
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle" data-slot="inbox-list">
      {rows.map((row) => (
        <li key={row.conversationId}>
          <Link
            href={`/messages/${row.conversationId}`}
            data-slot="inbox-row"
            data-kind={row.kind}
            data-unread={row.unread || undefined}
            className="flex min-h-16 items-center gap-3 px-3 py-2.5 outline-none hover:bg-surface-secondary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
          >
            <Avatar displayName={row.counterpart.displayName} avatarUrl={row.counterpart.avatarUrl} size="lg" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className={cn("truncate text-sm text-text-primary", row.unread ? "font-semibold" : "font-medium")}>{row.counterpart.displayName}</span>
                <span className="ml-auto shrink-0 text-[11px] text-text-muted">
                  <LocalDateTime iso={row.lastMessageAt} options={{ month: "short", day: "numeric" }} />
                </span>
              </span>
              <span className="mt-0.5 flex items-center gap-2 text-xs text-text-secondary">
                <span className="truncate">
                  {row.kind === "request" && <span className="font-medium text-text-primary">Wants to message you · </span>}
                  {row.kind === "sent_request" && <span className="font-medium text-text-primary">Request sent · </span>}
                  {row.previewRemoved ? <span className="italic">Message deleted</span> : row.preview ? `${row.fromMe ? "You: " : ""}${row.preview}` : ""}
                </span>
                {row.muted && <span className="shrink-0 rounded bg-surface-secondary px-1.5 py-0.5 text-[10px]">Muted</span>}
                {row.unread && (
                  <>
                    <span aria-hidden="true" className="ml-auto size-2.5 shrink-0 rounded-full bg-accent-primary" />
                    <span className="sr-only">Unread</span>
                  </>
                )}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
