"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { sanitizeNextPath } from "@/lib/auth/safe-next";
import { getPendingLegalAcceptances, recordLegalAcceptance } from "@/lib/legal/acceptance";

export type AcceptLegalState = { error: string | null };

/**
 * Re-consent: records that the signed-in member accepted the CURRENT version of whichever documents they are currently required to accept.
 * What is required is decided here, on the server, from the live setting — never from the form. Then it returns them to where they were.
 */
export async function acceptLegalUpdateAction(_prev: AcceptLegalState, formData: FormData): Promise<AcceptLegalState> {
  const user = await requireUser();
  if (formData.get("accepted") !== "on") {
    return { error: "Please confirm that you have read and agree to continue." };
  }
  const pending = await getPendingLegalAcceptances(user.id);
  if (pending.length > 0) {
    try {
      await recordLegalAcceptance(user.id, "reconsent", pending);
    } catch {
      return { error: "We couldn't record your acceptance. Please try again." };
    }
  }
  redirect(sanitizeNextPath(formData.get("next")) ?? "/feed");
}
