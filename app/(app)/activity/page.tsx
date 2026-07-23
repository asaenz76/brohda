import { Bell } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { getNotifications } from "@/lib/notifications/fetch";
import { attachNotificationHrefs } from "@/lib/notifications/links";
import { markNotificationsReadAction } from "@/lib/actions/notifications";
import { Button } from "@/components/ui/button";
import { getLedgerEntries } from "@/lib/wallet/ledger";
import { TransactionList } from "@/components/activity/TransactionList";

export default async function ActivityPage() {
  const user = await requireUser();

  const [entries, rawNotifications] = await Promise.all([
    getLedgerEntries(user.id),
    getNotifications(user.id),
  ]);
  const notifications = await attachNotificationHrefs(user.id, rawNotifications);

  const hasUnread = notifications.some((n) => n.read_at == null);

  if (entries.length === 0 && notifications.length === 0) {
    return (
      <>
        <h1 className="sr-only">Activity</h1>
        <EmptyFeedState
          icon={Bell}
          title="Nothing here yet"
          description="Ledger activity and notifications will show up here once pools are live."
        />
      </>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Activity</h1>
      {notifications.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-primary">Notifications</h2>
            {hasUnread && (
              <form action={markNotificationsReadAction}>
                <Button type="submit" variant="outline" size="sm">
                  Mark all read
                </Button>
              </form>
            )}
          </div>
          <ul className="space-y-2">
            {notifications.map((n) => {
              const content = (
                <>
                  <div className="flex items-center gap-2">
                    {n.read_at == null && (
                      <span className="size-1.5 rounded-full bg-accent-primary" aria-hidden="true" />
                    )}
                    <span className="text-sm font-medium text-text-primary">{n.title}</span>
                  </div>
                  <p className="mt-0.5 text-sm text-text-secondary">{n.body}</p>
                  <div className="mt-1 text-xs text-text-muted">
                    {new Date(n.created_at).toLocaleString()}
                  </div>
                </>
              );

              return (
                <li
                  key={n.id}
                  className="rounded-xl border border-border-subtle bg-surface-primary"
                >
                  {n.href ? (
                    // Plain <a>, not next/link: a hash-only href to this
                    // same page (e.g. /activity#tx-{id}) needs a real
                    // in-page anchor navigation so the browser fires a
                    // native "hashchange" event — next/link's
                    // history.pushState-based routing never does, which
                    // would silently break TransactionList's auto-open.
                    <a href={n.href} className="block px-4 py-3">
                      {content}
                    </a>
                  ) : (
                    <div className="px-4 py-3">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {entries.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-text-primary">Ledger activity</h2>
          <TransactionList entries={entries} />
        </section>
      )}
    </div>
  );
}
