import { notFound } from "next/navigation";
import { requireMemberAccount } from "@/lib/auth/session";
import { getMessagingConfig } from "@/lib/messaging/config";
import { getConversation } from "@/lib/messaging/queries";
import { withShares } from "@/lib/messaging/views";
import { isUuid } from "@/lib/messaging/share";
import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { ConversationScreen } from "@/components/messaging/ConversationScreen";

export const dynamic = "force-dynamic";

// One conversation. A conversation that is not the viewer's, one that does not exist and Messaging being OFF are all the same not-found: nothing here confirms that anyone else's conversation exists.
export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireMemberAccount();
  const { id } = await params;
  const config = await getMessagingConfig();
  if (!config || !isUuid(id)) notFound();
  const conversation = await getConversation(user.id, id);
  if (!conversation) notFound();
  const messages = await withShares(user.id, conversation.messages);

  return (
    <div className="space-y-3">
      <ColumnHeader title={conversation.counterpart.displayName} backHref="/messages" backLabel="Messages" />
      <ConversationScreen
        conversationId={conversation.id}
        counterpart={conversation.counterpart}
        status={conversation.status}
        iAmRequester={conversation.iAmRequester}
        incomingRequest={conversation.incomingRequest}
        initialMuted={conversation.muted}
        initialBlockedByMe={conversation.blockedByMe}
        initialMessages={messages}
        serverTime={new Date().toISOString()}
        maxLength={config.maxMessageLength}
        unsendWindowSeconds={config.unsendWindowSeconds}
        pollIntervalSeconds={config.pollIntervalSeconds}
      />
    </div>
  );
}
