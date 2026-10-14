import "server-only";
import { resolveSharedObject, type SharedObjectView, type ShareType } from "./share";
import type { MessageView } from "./queries";

export type MessageWithShare = MessageView & { share: SharedObjectView | null };

/**
 * Resolve every shared object in a page of messages FOR THIS VIEWER. Each shared Pick is attributed to the message's own sender (read from the row under RLS), so it is only ever shown as its
 * owner's own Pick. A message that has been unsent or removed carries no reference at all, so nothing is resolved for it.
 */
export async function withShares(viewerId: string, messages: MessageView[]): Promise<MessageWithShare[]> {
  return Promise.all(
    messages.map(async (m) => {
      if (m.kind !== "SHARE" || m.removed || !m.shareType || !m.shareRef) return { ...m, share: null };
      return { ...m, share: await resolveSharedObject(viewerId, m.senderId, { type: m.shareType as ShareType, ref: m.shareRef }) };
    }),
  );
}
