"use client";

import { useRouter } from "next/navigation";
import { Composer } from "@/components/messaging/Composer";

export function NewConversation({ recipientId, recipientName, maxLength }: { recipientId: string; recipientName: string; maxLength: number }) {
  const router = useRouter();
  return (
    <Composer
      recipientId={recipientId}
      maxLength={maxLength}
      placeholder={`Message ${recipientName}`}
      autoFocus
      onSent={(r) => {
        router.push(r.conversationId ? `/messages/${r.conversationId}` : "/messages");
      }}
    />
  );
}
