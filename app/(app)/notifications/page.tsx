import { Bell, MessageCircle, Target } from "lucide-react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { getNotifications } from "@/lib/notifications/fetch";
import { attachNotificationHrefs, type NotificationWithHref } from "@/lib/notifications/links";
import { markNotificationsReadAction } from "@/lib/actions/notifications";
import { Button } from "@/components/ui/button";
import { LocalDateTime } from "@/components/LocalDateTime";
import { cn } from "@/lib/utils";
import { ColumnHeader } from "@/components/shell/ColumnHeader";

/**
 * Notifications (Phase G, Brohda 2.0 redesign) — the canonical
 * notification center (spec §16-17), replacing the old combined
 * notifications+wallet-ledger `/activity` page (which now redirects
 * here). Shows exactly the Brohda 2.0 social set — prediction results and
 * comment replies (lib/notifications/center.ts's own explicit allowlist)
 * — never legacy Pool, disabled-feature (Call BS/monetary P2P), or
 * wallet-ledger content; wallet history lives at /wallet, which already
 * showed the complete ledger independently before this phase.
 *
 * Read state (spec §25): preserved exactly as it was — the one existing,
 * well-defined, already-predictable pattern (an explicit "Mark all read"
 * action, never an automatic mark-on-view/mark-on-click) carried over
 * rather than inventing new semantics.
 */
export default async function NotificationsPage() {
  const user = await requireUser();

  const rawNotifications = await getNotifications(user.id);
  const notifications = attachNotificationHrefs(rawNotifications);
  const hasUnread = notifications.some((n) => n.read_at == null);

  return (
    <div className="space-y-3">
      <ColumnHeader
        title="Notifications"
        icon={Bell}
        actions={
          hasUnread ? (
            <form action={markNotificationsReadAction}>
              <Button type="submit" variant="ghost" size="sm">
                Mark all read
              </Button>
            </form>
          ) : undefined
        }
      />

      {notifications.length === 0 ? (
        <EmptyFeedState icon={Bell} title="No notifications yet." description="Replies and prediction results will show up here." />
      ) : (
        <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
          {notifications.map((n) => (
            <NotificationRow key={n.id} notification={n} />
          ))}
        </ul>
      )}
    </div>
  );
}

const TYPE_ICON: Record<string, LucideIcon> = {
  POST_COMMENT_REPLY: MessageCircle,
  prediction_graded: Target,
};

function NotificationRow({ notification: n }: { notification: NotificationWithHref }) {
  const Icon = TYPE_ICON[n.type] ?? Bell;
  const isUnread = n.read_at == null;

  const content = (
    <div className={cn("flex items-start gap-3 px-4 py-3", isUnread && "bg-accent-primary/5")}>
      <Icon className={cn("mt-0.5 size-5 shrink-0", isUnread ? "text-accent-primary" : "text-text-muted")} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className={cn("text-sm", isUnread ? "font-semibold text-text-primary" : "font-medium text-text-secondary")}>
          {isUnread && <span className="sr-only">Unread: </span>}
          {n.title}
        </p>
        <p className="text-sm text-text-secondary [overflow-wrap:anywhere]">{n.body}</p>
        <p className="mt-1 text-xs text-text-muted">
          <LocalDateTime iso={n.created_at} options={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} />
        </p>
      </div>
      {/* Unread state is never color-only (spec §25/§44) — the sr-only
          "Unread:" prefix, the font weight and the tinted row all carry
          the same meaning this dot does visually. */}
      {isUnread && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent-primary" aria-hidden="true" />}
    </div>
  );

  return <li>{n.href ? <Link href={n.href} className="block outline-none hover:bg-surface-secondary focus-visible:ring-3 focus-visible:ring-ring/50">{content}</Link> : content}</li>;
}
