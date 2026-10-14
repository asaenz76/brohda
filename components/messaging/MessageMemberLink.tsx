import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The "Message" entry on a Member's profile. It only links to the start-a-message page; nothing is created by following it. */
export function MessageMemberLink({ memberId }: { memberId: string }) {
  return (
    <Link href={`/messages/with/${memberId}`} data-slot="message-member" className={cn(buttonVariants({ variant: "outline" }), "gap-1.5")}>
      <MessageSquare aria-hidden="true" />
      Message
    </Link>
  );
}
