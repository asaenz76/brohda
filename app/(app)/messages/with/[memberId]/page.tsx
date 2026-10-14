import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireMemberAccount } from "@/lib/auth/session";
import { getMessagingConfig } from "@/lib/messaging/config";
import { findConversationWith, getMemberCard } from "@/lib/messaging/queries";
import { isUuid } from "@/lib/messaging/share";
import { createClient } from "@/lib/supabase/server";
import { Avatar } from "@/components/Avatar";
import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { NewConversation } from "@/components/messaging/NewConversation";

export const dynamic = "force-dynamic";

// The "Message" entry from a profile. If a conversation with this Member already exists the Member goes straight to it (there is only ever one); otherwise this is where the first message — a
// message request — is written. Nothing is created by opening this page.
export default async function MessageMemberPage({ params }: { params: Promise<{ memberId: string }> }) {
  const user = await requireMemberAccount();
  const { memberId } = await params;
  const config = await getMessagingConfig();
  if (!config || !isUuid(memberId) || memberId === user.id) notFound();

  const existing = await findConversationWith(user.id, memberId);
  if (existing) redirect(`/messages/${existing.id}`);

  const supabase = await createClient();
  const [member, { data: block }] = await Promise.all([getMemberCard(memberId), supabase.from("member_blocks").select("blocked_id").eq("blocked_id", memberId).maybeSingle()]);
  if (!member || member.unavailable || !member.id) notFound();
  const recipientId = member.id;

  return (
    <div className="space-y-3">
      <ColumnHeader title="New message" backHref="/messages" backLabel="Messages" />
      <div className="flex items-center gap-3 rounded-lg border border-border-subtle p-3">
        <Avatar displayName={member.displayName} avatarUrl={member.avatarUrl} size="lg" />
        <div className="min-w-0">
          <p className="truncate text-base font-semibold text-text-primary">
            {member.username ? (
              <Link href={`/profile/${member.username}`} className="hover:underline">
                {member.displayName}
              </Link>
            ) : (
              member.displayName
            )}
          </p>
          <p className="text-xs text-text-secondary" data-slot="request-explainer">
            {member.displayName} will get this as a message request. You can send up to {config.maxUnansweredRequests} message{config.maxUnansweredRequests === 1 ? "" : "s"} until they accept.
          </p>
        </div>
      </div>
      {block ? (
        <p className="text-sm text-text-muted" data-slot="blocked-note">
          You&apos;ve blocked this Member. Unblock them from your Messages to write to them.
        </p>
      ) : (
        <NewConversation recipientId={recipientId} recipientName={member.displayName} maxLength={config.maxMessageLength} />
      )}
    </div>
  );
}
