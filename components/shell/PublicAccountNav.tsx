import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { getAccountContext } from "@/lib/auth/account";
import { MEMBER_HOME, SPONSOR_HOME } from "@/lib/auth/account-routing";
import { cn } from "@/lib/utils";

/**
 * What the public frame's header offers a SIGNED-IN visitor instead of "Log in / Create account": a way back into their own product. Returns undefined
 * for a signed-out visitor, which keeps the frame's default (Log in / Create account). Member and Sponsor stay separate: a Member is never offered the
 * Sponsor area, nor a Sponsor the Member product.
 */
export async function publicAccountNav(): Promise<ReactNode | undefined> {
  const ctx = await getAccountContext().catch(() => null);
  if (ctx?.accountType === "MEMBER") {
    return (
      <Link href={MEMBER_HOME} className={cn(buttonVariants({ size: "sm" }))}>
        Open brohda.
      </Link>
    );
  }
  if (ctx?.accountType === "SPONSOR") {
    return (
      <Link href={SPONSOR_HOME} className={cn(buttonVariants({ size: "sm" }))}>
        Sponsor dashboard
      </Link>
    );
  }
  return undefined;
}
