"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { createRefundNotifications, createSettlementNotifications } from "@/lib/notifications/create";
import { confirmTemplateSettlementSchema } from "@/lib/validations/settlements";

function revalidatePoolPaths(poolId: string) {
  revalidatePath("/admin/pools");
  revalidatePath(`/admin/pools/${poolId}`);
  revalidatePath("/feed");
  revalidatePath("/profile");
}

export type ConfirmTemplateSettlementState = { error: string | null };

/**
 * The money-moving half of a TEMPLATE_GRADED pool's settlement —
 * gradeTemplatePool (lib/pools/templates/grade.ts) already pre-stamped the
 * winning option and its evidence at READY_FOR_REVIEW; this just re-derives
 * the payout/refund outcome from persisted state (current entry counts)
 * rather than trusting anything the client submits, same as
 * confirmComboSettlementAction.
 */
export async function confirmTemplateSettlementAction(
  _prevState: ConfirmTemplateSettlementState,
  formData: FormData,
): Promise<ConfirmTemplateSettlementState> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const parsed = confirmTemplateSettlementSchema.safeParse({
    poolId: formData.get("poolId"),
    gradingVersion: Number(formData.get("gradingVersion")),
    idempotencyKey: formData.get("idempotencyKey"),
  });
  if (!parsed.success) {
    return { error: "Check the settlement details — something's missing or invalid." };
  }
  const { poolId, gradingVersion, idempotencyKey } = parsed.data;

  const { data: pool } = await adminClient.from("pools").select("status, pool_type").eq("id", poolId).single();
  if (!pool || pool.pool_type !== "TEMPLATE_GRADED") {
    return { error: "This isn't a template-graded pool." };
  }
  if (pool.status !== "READY_FOR_REVIEW") {
    return { error: "This pool isn't ready to confirm right now." };
  }

  const { data: settlement } = await adminClient
    .from("settlements")
    .select("id, winning_option_id")
    .eq("pool_id", poolId)
    .eq("grading_version", gradingVersion)
    .single();
  if (!settlement) {
    return { error: "Could not find the graded proposal — it may be stale. Refresh and try again." };
  }
  if (!settlement.winning_option_id) {
    return { error: "This pool hasn't been graded yet." };
  }

  const { data: options } = await adminClient
    .from("pool_options")
    .select("id, entry_count")
    .eq("pool_id", poolId);
  const winningOption = (options ?? []).find((o) => o.id === settlement.winning_option_id);
  const totalEntries = (options ?? []).reduce((sum, o) => sum + (o.entry_count ?? 0), 0);

  if (!winningOption) {
    return { error: "The graded winning option no longer exists." };
  }

  if (winningOption.entry_count === 0 || winningOption.entry_count === totalEntries) {
    const voidReason = winningOption.entry_count === 0 ? "NO_WINNING_ENTRIES" : "ALL_ENTRIES_WINNING";

    const { data: refundedPool, error } = await adminClient.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: voidReason,
      p_idempotency_key: idempotencyKey,
      p_admin_id: admin.id,
      p_grading_version: gradingVersion,
    });
    if (error || !refundedPool) {
      return { error: "Could not process the refund — it may be stale. Refresh and try again." };
    }

    await createRefundNotifications(poolId, "VOIDED", voidReason);
    await writeAuditLog({
      actorId: admin.id,
      action: "pool.refunded",
      entityType: "pool",
      entityId: poolId,
      before: { status: pool.status },
      after: { status: refundedPool.status, voidReason },
    });
    revalidatePoolPaths(poolId);
    return { error: null };
  }

  const { data: confirmedSettlement, error } = await adminClient.rpc("confirm_pool_settlement", {
    p_pool_id: poolId,
    p_admin_id: admin.id,
    p_grading_version: gradingVersion,
    p_idempotency_key: idempotencyKey,
    p_winning_option_id: winningOption.id,
  });
  if (error || !confirmedSettlement) {
    return { error: "Could not confirm this settlement — it may be stale. Refresh and try again." };
  }

  await createSettlementNotifications(poolId);
  await writeAuditLog({
    actorId: admin.id,
    action: "pool.settled",
    entityType: "pool",
    entityId: poolId,
    before: { status: pool.status },
    after: { status: "SETTLED", settlementId: confirmedSettlement.id },
  });

  revalidatePoolPaths(poolId);
  return { error: null };
}
