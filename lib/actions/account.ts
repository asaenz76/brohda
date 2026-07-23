"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/auth/session";
import { writeAuditLog } from "@/lib/audit/log";

export type CloseAccountState = { error: string | null };

const CONFIRM_TEXT = "CLOSE";

const ERROR_MESSAGES: Record<string, string> = {
  wallet_not_found: "Could not find your wallet. Please try again.",
  nonzero_balance: "Withdraw your remaining balance before closing your account.",
  pending_wallet_request: "You have a pending deposit or withdrawal request. Wait for it to be reviewed first.",
  active_entries: "You have picks still in progress. Wait for them to settle before closing your account.",
};

// Full erasure isn't offered — see 20260101000022_close_account.sql for why
// (technically impossible for anyone with pool/wallet history, and not what
// self-exclusion compliance actually calls for anyway). This deactivates
// the account and scrubs identifying fields; the email stays permanently
// taken in auth.users, which is what actually blocks re-registration.
export async function closeAccountAction(
  _prevState: CloseAccountState,
  formData: FormData,
): Promise<CloseAccountState> {
  const user = await requireUser();

  const confirmation = String(formData.get("confirmation") ?? "").trim();
  if (confirmation !== CONFIRM_TEXT) {
    return { error: `Type ${CONFIRM_TEXT} to confirm.` };
  }

  const admin = createAdminClient();

  const { data: before } = await admin
    .from("user_profiles")
    .select("display_name, username, avatar_url")
    .eq("id", user.id)
    .single();

  const { error } = await admin.rpc("close_own_account", { p_user_id: user.id });

  if (error) {
    return { error: ERROR_MESSAGES[error.message] ?? "Could not close your account." };
  }

  // Best-effort — an orphaned avatar file left in storage is a cleanup
  // detail, not a reason to fail an already-completed account closure.
  if (before?.avatar_url) {
    const path = before.avatar_url.split("/avatars/")[1];
    if (path) {
      await admin.storage.from("avatars").remove([path]);
    }
  }

  await writeAuditLog({
    actorId: user.id,
    action: "user.account_closed",
    entityType: "user_profile",
    entityId: user.id,
    before,
    after: { display_name: "Deleted User", username: null, avatar_url: null },
    reason: "Self-service account closure",
  });

  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login?closed=1");
}
