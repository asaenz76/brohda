"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { createRefundNotifications, createSettlementNotifications } from "@/lib/notifications/create";
import { confirmComboSettlementSchema } from "@/lib/validations/settlements";

function revalidatePoolPaths(poolId: string) {
  revalidatePath("/admin/pools");
  revalidatePath(`/admin/pools/${poolId}`);
  revalidatePath("/feed");
  revalidatePath("/profile");
}

export type GradeComboState = { error: string | null };

/**
 * Super-admin-only: grades every leg of a COMBO pool (met/not-met, plus a
 * per-leg Did Not Play flag) and stamps the derived winner — but stops at
 * READY_FOR_REVIEW rather than settling immediately. A combo's outcome is
 * fully determined by what's just submitted (no ambiguity for a human to
 * resolve, unlike free-choice manual grading), but the payout/refund is
 * still real money moving, so it goes through the same
 * prepare-then-confirm split every other pool type gets — just with the
 * "pick a winner" step already done via these checkboxes instead of a
 * dropdown. See confirmComboSettlementAction for the step that actually
 * moves money.
 */
export async function gradeComboLegsAction(
  _prevState: GradeComboState,
  formData: FormData,
): Promise<GradeComboState> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();
  const poolId = String(formData.get("poolId") ?? "");

  const { data: pool } = await adminClient.from("pools").select("*").eq("id", poolId).single();
  if (!pool || pool.pool_type !== "COMBO") {
    return { error: "This isn't a combo pool." };
  }
  if (pool.status !== "LOCKED" && pool.status !== "AWAITING_RESULT") {
    return { error: "This pool can't be graded right now." };
  }

  const { data: legs } = await adminClient
    .from("pool_combo_legs")
    .select("id, label")
    .eq("pool_id", poolId)
    .order("sort_order");

  if (!legs || legs.length === 0) {
    return { error: "This combo pool has no conditions to grade." };
  }

  const legStates = legs.map((leg) => ({
    id: leg.id as string,
    isMet: formData.get(`leg_${leg.id}`) === "on",
    didNotPlay: formData.get(`dnp_${leg.id}`) === "on",
  }));

  const legUpdateResults = await Promise.all(
    legStates.map((leg) =>
      adminClient
        .from("pool_combo_legs")
        .update({ is_met: leg.isMet, did_not_play: leg.didNotPlay })
        .eq("id", leg.id),
    ),
  );
  if (legUpdateResults.some((r) => r.error)) {
    return { error: "Could not save the leg grades." };
  }

  const { data: options } = await adminClient
    .from("pool_options")
    .select("id, label")
    .eq("pool_id", poolId);

  const yesOption = options?.find((o) => o.label === "Yes");
  const noOption = options?.find((o) => o.label === "No");
  if (!yesOption || !noOption) {
    return { error: "This combo pool is missing its Yes/No options." };
  }

  const { data: settlement, error: prepareError } = await adminClient.rpc(
    "prepare_pool_settlement_manual",
    { p_pool_id: poolId },
  );
  if (prepareError || !settlement) {
    return { error: "Could not prepare this pool for settlement." };
  }

  const anyDidNotPlay = legStates.some((leg) => leg.didNotPlay);

  // Did Not Play is an absolute override with no "winning side" — leave
  // winning_option_id untouched (null) so the review screen shows the void
  // copy instead of a payout/refund preview. confirmComboSettlementAction
  // re-reads did_not_play from pool_combo_legs itself, not from anything
  // stamped here.
  if (!anyDidNotPlay) {
    const allMet = legStates.every((leg) => leg.isMet);
    const winningOption = allMet ? yesOption : noOption;

    // Stamped unconditionally (not just when nobody's entered) so the
    // review screen and settlement history always show the graded winner,
    // not "Not determined," while the pool waits on confirmation. Cleared
    // on both options first — otherwise re-grading via Undo before
    // confirming (flipping which side wins) would leave the previous
    // winner's flag stuck true alongside the new one.
    await adminClient
      .from("settlements")
      .update({ winning_option_id: winningOption.id, winning_option_reason: "MANUAL_ADMIN_OVERRIDE" })
      .eq("id", settlement.id);
    await adminClient.from("pool_options").update({ is_winning_option: false }).eq("pool_id", poolId);
    await adminClient.from("pool_options").update({ is_winning_option: true }).eq("id", winningOption.id);
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "pool.combo_graded",
    entityType: "pool",
    entityId: poolId,
    before: { status: pool.status },
    after: {
      legs: legStates.map((l, i) => ({ label: legs[i].label, isMet: l.isMet, didNotPlay: l.didNotPlay })),
    },
  });

  revalidatePoolPaths(poolId);
  return { error: null };
}

export type ConfirmComboSettlementState = { error: string | null };

/**
 * The money-moving half of COMBO grading — separated from
 * gradeComboLegsAction so the admin sees a preview (ComboSettlementReviewForm)
 * before this runs. Re-derives the outcome from persisted state (leg
 * did_not_play flags, current entry counts) rather than trusting anything
 * the client submits, same as every other confirm action in this codebase.
 */
export async function confirmComboSettlementAction(
  _prevState: ConfirmComboSettlementState,
  formData: FormData,
): Promise<ConfirmComboSettlementState> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const parsed = confirmComboSettlementSchema.safeParse({
    poolId: formData.get("poolId"),
    gradingVersion: Number(formData.get("gradingVersion")),
    idempotencyKey: formData.get("idempotencyKey"),
  });
  if (!parsed.success) {
    return { error: "Check the settlement details — something's missing or invalid." };
  }
  const { poolId, gradingVersion, idempotencyKey } = parsed.data;

  const { data: pool } = await adminClient.from("pools").select("status, pool_type").eq("id", poolId).single();
  if (!pool || pool.pool_type !== "COMBO") {
    return { error: "This isn't a combo pool." };
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

  const { data: legs } = await adminClient
    .from("pool_combo_legs")
    .select("did_not_play")
    .eq("pool_id", poolId);
  const anyDidNotPlay = (legs ?? []).some((l) => l.did_not_play);

  if (anyDidNotPlay) {
    const { data: refundedPool, error } = await adminClient.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: "COMBO_PLAYER_DID_NOT_PLAY",
      p_idempotency_key: idempotencyKey,
      p_admin_id: admin.id,
      p_grading_version: gradingVersion,
    });
    if (error || !refundedPool) {
      return { error: "Could not process the refund — it may be stale. Refresh and try again." };
    }

    await createRefundNotifications(poolId, "VOIDED", "COMBO_PLAYER_DID_NOT_PLAY");
    await writeAuditLog({
      actorId: admin.id,
      action: "pool.refunded",
      entityType: "pool",
      entityId: poolId,
      before: { status: pool.status },
      after: { status: refundedPool.status, voidReason: "COMBO_PLAYER_DID_NOT_PLAY" },
    });
    revalidatePoolPaths(poolId);
    return { error: null };
  }

  if (!settlement.winning_option_id) {
    return { error: "This pool hasn't been graded yet — go back and grade it first." };
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
