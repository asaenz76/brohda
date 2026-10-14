import Link from "next/link";
import { notFound } from "next/navigation";
import { MessageSquare } from "lucide-react";
import { requireMemberAccount } from "@/lib/auth/session";
import { isMessagingEnabled } from "@/lib/messaging/config";
import { getInbox } from "@/lib/messaging/queries";
import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { InboxList } from "@/components/messaging/InboxList";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Member Messaging: the signed-in Member's own conversations and message requests. Nothing here exists while the capability is OFF (a plain not-found), and a Sponsor session never reaches it
// (requireMemberAccount sends it to the Sponsor area).
export default async function MessagesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await requireMemberAccount();
  if (!(await isMessagingEnabled())) notFound();
  const { tab } = await searchParams;
  const showRequests = tab === "requests";
  const inbox = await getInbox(user.id);
  const unreadConversations = inbox.conversations.filter((r) => r.unread).length;

  const tabClass = (active: boolean) =>
    cn("flex min-h-11 flex-1 items-center justify-center gap-1.5 border-b-2 px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60", active ? "border-accent-primary text-text-primary" : "border-transparent text-text-secondary hover:text-text-primary");

  return (
    <div className="space-y-3">
      <ColumnHeader title="Messages" icon={MessageSquare}>
        <nav aria-label="Messages sections" className="flex">
          <Link href="/messages" aria-current={!showRequests ? "page" : undefined} className={tabClass(!showRequests)}>
            Messages
            {unreadConversations > 0 && <span className="rounded-full bg-accent-primary px-1.5 text-[10px] font-semibold text-white">{unreadConversations}</span>}
          </Link>
          <Link href="/messages?tab=requests" aria-current={showRequests ? "page" : undefined} className={tabClass(showRequests)}>
            Requests
            {inbox.requests.length > 0 && <span className="rounded-full bg-accent-primary px-1.5 text-[10px] font-semibold text-white">{inbox.requests.length}</span>}
          </Link>
        </nav>
      </ColumnHeader>
      {showRequests ? <InboxList rows={inbox.requests} empty="No message requests." /> : <InboxList rows={inbox.conversations} empty="No messages yet." />}
    </div>
  );
}
