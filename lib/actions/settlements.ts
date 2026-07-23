"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { createRefundNotifications, createSettlementNotifications } from "@/lib/notifications/create";
import { confirmPoolRefundSchema, confirmSettlementSchema } from "@/lib/validations/settlements";

export type ConfirmSettlementState = { error: string | null };

export async function confirmSettlementAction(
  _prevState: ConfirmSettlementState,
  formData: FormData,
): Promise<ConfirmSettlementState> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const rawWinningOptionId = formData.get("winningOptionId");
  const parsed = confirmSettlementSchema.safeParse({
    poolId: formData.get("poolId"),
    gradingVersion: Number(formData.get("gradingVersion")),
    idempotencyKey: formData.get("idempotencyKey"),
    winningOptionId: rawWinningOptionId ? String(rawWinningOptionId) : null,
  });

  if (!parsed.success) {
    return { error: "Check the settlement details — something's missing or invalid." };
  }

  const { data: before } = await adminClient
    .from("pools")
    .select("status, snapshot_version")
    .eq("id", parsed.data.poolId)
    .single();

  // A manually-picked winning option (requires_manual_verification pools —
  // CUSTOM/COMBO/Grade Manually override) can turn out to have zero entries,
  // or every valid entry, once the admin actually chooses it — the pool-wide
  // "no/all winners" check at prepare-time can't know this in advance since
  // it runs before any option is picked. confirm_pool_settlement correctly
  // refuses to settle that case (raises no_or_all_winner_use_confirm_pool_refund)
  // rather than crediting winners for an option nobody chose, but the app
  // needs to actually route to the refund path instead of just surfacing a
  // dead-end error — same zero/all check gradeComboLegsAction already does,
  // generalized here for every manually-graded pool type, not just COMBO.
  // Per product decision, this refunds in full with no coordinator fee
  // (unlike COMBO's confirm_combo_refund_fee_retained), matching the existing
  // automatic NO_WINNING_ENTRIES_REFUND/ALL_ENTRIES_WINNING_REFUND behavior.
  if (parsed.data.winningOptionId) {
    const { data: options } = await adminClient
      .from("pool_options")
      .select("id, entry_count")
      .eq("pool_id", parsed.data.poolId);

    const winningOption = (options ?? []).find((o) => o.id === parsed.data.winningOptionId);
    const totalEntries = (options ?? []).reduce((sum, o) => sum + (o.entry_count ?? 0), 0);

    if (winningOption && (winningOption.entry_count === 0 || winningOption.entry_count === totalEntries)) {
      const voidReason = winningOption.entry_count === 0 ? "NO_WINNING_ENTRIES" : "ALL_ENTRIES_WINNING";

      const { data: pool, error: refundError } = await adminClient.rpc("confirm_pool_refund", {
        p_pool_id: parsed.data.poolId,
        p_void_reason: voidReason,
        p_idempotency_key: parsed.data.idempotencyKey,
        p_admin_id: admin.id,
        p_grading_version: parsed.data.gradingVersion,
      });

      if (refundError || !pool) {
        return { error: "Could not confirm this settlement — it may be stale. Refresh and try again." };
      }

      await createRefundNotifications(parsed.data.poolId, "VOIDED", voidReason);

      await writeAuditLog({
        actorId: admin.id,
        action: "pool.refunded",
        entityType: "pool",
        entityId: parsed.data.poolId,
        before,
        after: { status: pool.status, voidReason },
      });

      revalidatePath(`/admin/pools/${parsed.data.poolId}`);
      revalidatePath("/feed");
      revalidatePath("/profile");
      return { error: null };
    }
  }

  const { data: settlement, error } = await adminClient.rpc("confirm_pool_settlement", {
    p_pool_id: parsed.data.poolId,
    p_admin_id: admin.id,
    p_grading_version: parsed.data.gradingVersion,
    p_idempotency_key: parsed.data.idempotencyKey,
    p_winning_option_id: parsed.data.winningOptionId ?? null,
  });

  if (error || !settlement) {
    return { error: "Could not confirm this settlement — it may be stale. Refresh and try again." };
  }

  await createSettlementNotifications(parsed.data.poolId);

  await writeAuditLog({
    actorId: admin.id,
    action: "pool.settled",
    entityType: "pool",
    entityId: parsed.data.poolId,
    before,
    after: { status: "SETTLED", settlementId: settlement.id },
  });

  revalidatePath(`/admin/pools/${parsed.data.poolId}`);
  revalidatePath("/feed");
  revalidatePath("/profile");
  return { error: null };
}

export type ConfirmPoolRefundState = { error: string | null };

export async function confirmPoolRefundAction(
  _prevState: ConfirmPoolRefundState,
  formData: FormData,
): Promise<ConfirmPoolRefundState> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const parsed = confirmPoolRefundSchema.safeParse({
    poolId: formData.get("poolId"),
    gradingVersion: Number(formData.get("gradingVersion")),
    idempotencyKey: formData.get("idempotencyKey"),
    voidReason: formData.get("voidReason"),
  });

  if (!parsed.success) {
    return { error: "Check the refund details — something's missing or invalid." };
  }

  const { data: before } = await adminClient
    .from("pools")
    .select("status, snapshot_version")
    .eq("id", parsed.data.poolId)
    .single();

  const { data: pool, error } = await adminClient.rpc("confirm_pool_refund", {
    p_pool_id: parsed.data.poolId,
    p_void_reason: parsed.data.voidReason,
    p_idempotency_key: parsed.data.idempotencyKey,
    p_admin_id: admin.id,
    p_grading_version: parsed.data.gradingVersion,
  });

  if (error || !pool) {
    return { error: "Could not confirm this refund — it may be stale. Refresh and try again." };
  }

  await createRefundNotifications(
    parsed.data.poolId,
    pool.status === "CANCELLED" ? "CANCELLED" : "VOIDED",
    parsed.data.voidReason,
  );

  await writeAuditLog({
    actorId: admin.id,
    action: "pool.refunded",
    entityType: "pool",
    entityId: parsed.data.poolId,
    before,
    after: { status: pool.status, voidReason: parsed.data.voidReason },
  });

  revalidatePath(`/admin/pools/${parsed.data.poolId}`);
  revalidatePath("/feed");
  revalidatePath("/profile");
  return { error: null };
}

export type UndoPoolGradingResult = { success: boolean; error: string | null };

/**
 * Reverts a pool from READY_FOR_REVIEW back to LOCKED and deletes its
 * unconfirmed settlement row — a pure state-machine undo, not a financial
 * reversal (no wallet transaction has ever run at this point, since
 * confirm_pool_settlement/confirm_pool_refund haven't been called yet).
 * For a settlement that's already been confirmed, use the separate
 * Settlement Reversal flow instead — undo_pool_grading's own guard refuses
 * that case outright.
 *
 * Exists mainly for the case where the wrong grading path was taken (e.g.
 * a COMBO pool graded via the generic "Grade manually" override instead of
 * its own leg checkboxes, landing on a confusing "Not determined" refund
 * screen) — this lets the admin back out and re-grade properly instead of
 * being stuck with whatever the first attempt produced.
 */
export async function undoPoolGradingAction(poolId: string): Promise<UndoPoolGradingResult> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const { data: before } = await adminClient
    .from("pools")
    .select("status, snapshot_version")
    .eq("id", poolId)
    .single();

  const { data: pool, error } = await adminClient.rpc("undo_pool_grading", {
    p_pool_id: poolId,
    p_admin_id: admin.id,
  });

  if (error || !pool) {
    return { success: false, error: "Could not undo grading — it may already be confirmed. Refresh and try again." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "pool.grading_undone",
    entityType: "pool",
    entityId: poolId,
    before,
    after: { status: pool.status },
  });

  revalidatePath(`/admin/pools/${poolId}`);
  return { success: true, error: null };
}
