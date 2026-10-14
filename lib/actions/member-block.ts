"use server";

import { revalidatePath } from "next/cache";
import { requireMemberAccount } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/messaging/share";

// Block / unblock a Member from their profile. Block is a relationship boundary between two Members (see member_blocks): no direct Messaging, no Call BS in either direction, no direct replies between
// them, and the blocker's own view hides the other Member's comments. It does NOT depend on the Messaging capability being on, and it never deletes or moderates anyone's public comments.

export interface MemberBlockResult {
  ok: boolean;
  blocked: boolean;
  message: string;
}

async function withinRateLimit(userId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data: policy } = await admin.from("platform_settings").select("messaging_send_rate_window_seconds, messaging_send_rate_max").eq("id", true).single();
  if (!policy || !Number.isInteger(policy.messaging_send_rate_window_seconds) || !Number.isInteger(policy.messaging_send_rate_max)) return false;
  const { data, error } = await admin.rpc("messaging_rate_limit", { p_identifier: `member_block:${userId}`, p_window_seconds: policy.messaging_send_rate_window_seconds, p_max_attempts: policy.messaging_send_rate_max });
  return !error && data === true;
}

export async function setMemberBlockAction(memberId: string, blocked: boolean): Promise<MemberBlockResult> {
  const user = await requireMemberAccount();
  if (!isUuid(memberId)) return { ok: false, blocked: !blocked, message: "That Member isn't available." };
  if (!(await withinRateLimit(user.id))) return { ok: false, blocked: !blocked, message: "You're going too fast. Wait a moment and try again." };
  const { data, error } = await createAdminClient().rpc("messaging_set_block", { p_user_id: user.id, p_blocked_id: memberId, p_blocked: Boolean(blocked) });
  const outcome = (data as { outcome?: string } | null)?.outcome;
  if (error || outcome === "not_found" || outcome === "self" || !outcome) return { ok: false, blocked: !blocked, message: "That Member isn't available." };
  revalidatePath("/messages");
  return blocked
    ? { ok: true, blocked: true, message: "Blocked. You won't see their comments, and neither of you can message, call BS on or reply to the other." }
    : { ok: true, blocked: false, message: "Unblocked." };
}
