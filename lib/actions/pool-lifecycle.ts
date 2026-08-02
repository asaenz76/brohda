"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin, requireAdminOrAbove } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import {
  hasCalendarDayEnded,
  isAnomalyStatus,
  mapAnomalyToVoidReason,
  requiresSameDayWait,
} from "@/lib/pools/anomaly";
import { createRefundNotifications } from "@/lib/notifications/create";
import { gradeTemplatePool } from "@/lib/pools/templates/grade";
import { cancelPoolSchema } from "@/lib/validations/pool-lifecycle";
import type { FixtureInternalStatus } from "@/lib/sports-data/types";

function revalidatePoolPaths(poolId: string) {
  revalidatePath("/admin/pools");
  revalidatePath(`/admin/pools/${poolId}`);
  revalidatePath("/feed");
}

/**
 * Manual "Lock now" — OPEN -> LOCKED on demand, not gated on locks_at having
 * passed (matches spec's admin Force Lock capability — no invariant depends
 * on locking only ever happening at/after locks_at). Exists because the
 * cron that normally does this (`lockDuePools`) only runs once a minute in
 * production and not at all in local dev.
 */
export async function forceLockPoolAction(poolId: string) {
  const admin = await requireAdminOrAbove();
  const adminClient = createAdminClient();

  const { data: pool } = await adminClient.from("pools").select("*").eq("id", poolId).single();
  if (!pool || pool.status !== "OPEN") {
    throw new Error("This pool isn't open, so it can't be locked.");
  }

  const { error } = await adminClient
    .from("pools")
    .update({ status: "LOCKED" })
    .eq("id", poolId)
    .eq("status", "OPEN");

  if (error) throw new Error("Could not lock this pool.");

  await writeAuditLog({
    actorId: admin.id,
    action: "pool.force_locked",
    entityType: "pool",
    entityId: poolId,
    before: { status: pool.status },
    after: { status: "LOCKED" },
  });

  revalidatePoolPaths(poolId);
}

/**
 * Manual advance for a LOCKED pool — calls the same atomic
 * `advance_or_cancel_locked_pool` RPC `lockDuePools()`'s second pass uses,
 * so cron and manual triggers can never disagree on the decision: below
 * `min_total_entries` cancels and refunds (MINIMUM_ENTRIES_NOT_REACHED); a
 * TEMPLATE_GRADED pool where every valid entry landed on the same side
 * cancels and refunds too (ONE_SIDED_POOL); unresolvable binary options
 * route to MANUAL_REVIEW; otherwise the pool advances to AWAITING_RESULT.
 */
export async function advanceLockedPoolAction(poolId: string) {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const { data: pool } = await adminClient.from("pools").select("id, status").eq("id", poolId).single();

  if (!pool || pool.status !== "LOCKED") {
    throw new Error("This pool isn't locked, so it can't be advanced.");
  }

  const { data: updatedPool, error } = await adminClient.rpc("advance_or_cancel_locked_pool", {
    p_pool_id: poolId,
    p_admin_id: admin.id,
  });
  if (error || !updatedPool) throw new Error("Could not advance this pool.");

  if (updatedPool.status === "CANCELLED") {
    await writeAuditLog({
      actorId: admin.id,
      action:
        updatedPool.void_reason === "ONE_SIDED_POOL"
          ? "pool.force_cancelled_one_sided"
          : "pool.force_cancelled_below_minimum",
      entityType: "pool",
      entityId: poolId,
      before: { status: "LOCKED" },
      after: { status: "CANCELLED" },
    });
  } else if (updatedPool.status === "MANUAL_REVIEW") {
    await writeAuditLog({
      actorId: admin.id,
      action: "pool.routed_to_manual_review",
      entityType: "pool",
      entityId: poolId,
      before: { status: "LOCKED" },
      after: { status: "MANUAL_REVIEW" },
    });
  } else {
    await writeAuditLog({
      actorId: admin.id,
      action: "pool.force_advanced_to_awaiting_result",
      entityType: "pool",
      entityId: poolId,
      before: { status: "LOCKED" },
      after: { status: "AWAITING_RESULT" },
    });
  }

  revalidatePoolPaths(poolId);
}

export type GradeManuallyState = { error: string | null };

/**
 * Super-admin override: skip automatic fixture-score derivation entirely
 * and jump straight to the existing manual winner-picker (SettlementReviewForm)
 * — available from LOCKED (before any result would normally exist) or
 * AWAITING_RESULT, for any pool_type. This is the only path for a CUSTOM
 * pool (no fixture to check at all), and a deliberate bypass for a
 * real-fixture pool the admin wants to grade by hand instead of trusting
 * the automatic check. `prepare_pool_settlement_manual` has no fixture
 * lookup, so unlike checkPoolResultNowAction there's no fixture-status
 * branching to replicate here.
 */
export async function gradeManuallyAction(
  _prevState: GradeManuallyState,
  formData: FormData,
): Promise<GradeManuallyState> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();
  const poolId = String(formData.get("poolId") ?? "");

  const { data: pool } = await adminClient.from("pools").select("id, status").eq("id", poolId).single();

  if (!pool || (pool.status !== "LOCKED" && pool.status !== "AWAITING_RESULT")) {
    return { error: "This pool can't be graded manually right now." };
  }

  const { error } = await adminClient.rpc("prepare_pool_settlement_manual", { p_pool_id: poolId });
  if (error) {
    return { error: "Could not prepare this pool for manual grading." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "pool.force_manual_grading",
    entityType: "pool",
    entityId: poolId,
    before: { status: pool.status },
    after: { status: "READY_FOR_REVIEW" },
  });

  revalidatePoolPaths(poolId);
  return { error: null };
}

export type CheckResultState = { message: string | null; error: string | null };

/**
 * Manual "Check for result now" for an AWAITING_RESULT pool — mirrors
 * `processAwaitingResults()`'s per-pool branch exactly (anomaly + grace
 * window, else prepare_pool_settlement if COMPLETED, else still waiting).
 * `prepare_pool_settlement` itself has no fixture-status guard — this
 * branching is the only thing standing between a still-live match and a
 * premature "needs manual verification" review, so it must be replicated
 * here rather than calling the RPC directly.
 */
export async function checkPoolResultNowAction(
  _prevState: CheckResultState,
  formData: FormData,
): Promise<CheckResultState> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();
  const poolId = String(formData.get("poolId") ?? "");

  const { data: pool } = await adminClient
    .from("pools")
    .select(
      "id, status, pool_type, template_id, template_config, template_version, fixtures(internal_status, scheduled_start_utc, venue_timezone, home_team_name, away_team_name, home_team_external_id, away_team_external_id, regulation_home_score, regulation_away_score, halftime_home_score, halftime_away_score, provider_events_payload)",
    )
    .eq("id", poolId)
    .single();

  if (!pool || pool.status !== "AWAITING_RESULT") {
    return { message: null, error: "This pool isn't awaiting a result." };
  }

  const fixture = (Array.isArray(pool.fixtures) ? pool.fixtures[0] : pool.fixtures) as {
    internal_status: string;
    scheduled_start_utc: string;
    venue_timezone: string | null;
    home_team_name: string;
    away_team_name: string;
    home_team_external_id: string | null;
    away_team_external_id: string | null;
    regulation_home_score: number | null;
    regulation_away_score: number | null;
    halftime_home_score: number | null;
    halftime_away_score: number | null;
    provider_events_payload: unknown;
  } | null;

  if (!fixture) {
    return { message: null, error: "Could not find this pool's fixture." };
  }

  const internalStatus = fixture.internal_status as FixtureInternalStatus;

  if (isAnomalyStatus(internalStatus)) {
    const timezone = fixture.venue_timezone || process.env.DEFAULT_TIMEZONE || "America/Costa_Rica";

    if (requiresSameDayWait(internalStatus) && !hasCalendarDayEnded(fixture.scheduled_start_utc, timezone)) {
      return { message: "Still within the same-day grace window — not voided yet.", error: null };
    }

    const voidReason = mapAnomalyToVoidReason(internalStatus);
    const { data: voidedPool, error } = await adminClient.rpc("confirm_pool_refund", {
      p_pool_id: poolId,
      p_void_reason: voidReason,
      p_idempotency_key: `${poolId}:void:${voidReason}`,
      p_admin_id: admin.id,
    });

    if (error || !voidedPool) {
      return { message: null, error: "Could not void this pool." };
    }

    await createRefundNotifications(
      poolId,
      voidedPool.status === "CANCELLED" ? "CANCELLED" : "VOIDED",
      voidReason,
    );

    await writeAuditLog({
      actorId: admin.id,
      action: "pool.force_voided_anomaly",
      entityType: "pool",
      entityId: poolId,
      before: { status: "AWAITING_RESULT" },
      after: { status: voidedPool.status, voidReason },
    });

    revalidatePoolPaths(poolId);
    return { message: `Pool voided (${voidReason}).`, error: null };
  }

  if (internalStatus !== "COMPLETED") {
    return { message: `Fixture is still ${internalStatus} — not ready to grade yet.`, error: null };
  }

  if (pool.pool_type === "TEMPLATE_GRADED") {
    const outcome = await gradeTemplatePool(pool, fixture);
    if (outcome === "failed") {
      return { message: null, error: "Could not grade this pool from its template." };
    }
    if (outcome === "voided") {
      await writeAuditLog({
        actorId: admin.id,
        action: "pool.force_voided_anomaly",
        entityType: "pool",
        entityId: poolId,
        before: { status: "AWAITING_RESULT" },
        after: { status: "VOIDED" },
      });
      revalidatePoolPaths(poolId);
      return { message: "Pool voided — the template couldn't determine a valid outcome.", error: null };
    }
    if (outcome === "pending") {
      return { message: "Regulation score isn't available yet — try again shortly.", error: null };
    }
    if (outcome === "manualReview") {
      await writeAuditLog({
        actorId: admin.id,
        action: "pool.routed_to_manual_review",
        entityType: "pool",
        entityId: poolId,
        before: { status: "AWAITING_RESULT" },
        after: { status: "MANUAL_REVIEW" },
      });
      revalidatePoolPaths(poolId);
      return {
        message: "This pool couldn't be graded automatically and now needs manual review.",
        error: null,
      };
    }

    await writeAuditLog({
      actorId: admin.id,
      action: "pool.force_prepared_for_review",
      entityType: "pool",
      entityId: poolId,
      before: { status: "AWAITING_RESULT" },
      after: { status: "READY_FOR_REVIEW" },
    });
    revalidatePoolPaths(poolId);
    return { message: "Result found — pool moved to Ready for Review.", error: null };
  }

  const { error } = await adminClient.rpc("prepare_pool_settlement", { p_pool_id: poolId });
  if (error) {
    return { message: null, error: "Could not prepare a settlement for this pool." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "pool.force_prepared_for_review",
    entityType: "pool",
    entityId: poolId,
    before: { status: "AWAITING_RESULT" },
    after: { status: "READY_FOR_REVIEW" },
  });

  revalidatePoolPaths(poolId);
  return { message: "Result found — pool moved to Ready for Review.", error: null };
}

export type CancelPoolState = { error: string | null };

const CANCELLABLE_STATUSES = ["DRAFT", "OPEN", "LOCKED", "AWAITING_RESULT", "MANUAL_REVIEW"];

/**
 * Super-admin "Cancel Pool" — voids a pool outright on demand (not from an
 * automatic trigger like below-minimum-entries or a fixture anomaly),
 * refunding every active entry in full. Only offered for DRAFT/OPEN/LOCKED/
 * AWAITING_RESULT/MANUAL_REVIEW; READY_FOR_REVIEW already has its own
 * dedicated refund flow (SettlementReviewForm) that this shouldn't
 * duplicate. Cancelling a MANUAL_REVIEW pool is the only way out of that
 * status today — confirm_pool_refund clears review_reason on every
 * transition, so nothing stale is left behind.
 */
export async function cancelPoolAction(
  _prevState: CancelPoolState,
  formData: FormData,
): Promise<CancelPoolState> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const parsed = cancelPoolSchema.safeParse({
    poolId: formData.get("poolId"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) {
    return { error: "Check the cancellation details — something's missing or invalid." };
  }

  const { data: pool } = await adminClient
    .from("pools")
    .select("id, status")
    .eq("id", parsed.data.poolId)
    .single();

  if (!pool || !CANCELLABLE_STATUSES.includes(pool.status)) {
    return { error: "This pool can't be cancelled right now." };
  }

  const { data: cancelledPool, error } = await adminClient.rpc("confirm_pool_refund", {
    p_pool_id: parsed.data.poolId,
    p_void_reason: "ADMIN_MANUAL_CANCEL",
    p_idempotency_key: parsed.data.idempotencyKey,
    p_admin_id: admin.id,
  });

  if (error || !cancelledPool) {
    return { error: "Could not cancel this pool." };
  }

  await createRefundNotifications(parsed.data.poolId, "CANCELLED", "ADMIN_MANUAL_CANCEL");

  await writeAuditLog({
    actorId: admin.id,
    action: "pool.cancelled",
    entityType: "pool",
    entityId: parsed.data.poolId,
    before: { status: pool.status },
    after: { status: cancelledPool.status, reason: parsed.data.reason },
  });

  revalidatePoolPaths(parsed.data.poolId);
  return { error: null };
}

export type DeletePoolResult = { success: boolean; error: string | null };

const DELETABLE_TERMINAL_STATUSES = new Set(["SETTLED", "CANCELLED", "VOIDED"]);

/**
 * Hard-deletes a pool — either one that's never had an entry (first_entry_at
 * null, the original "just a draft, nothing real happened" case), or one
 * that's reached a genuinely terminal status (SETTLED/CANCELLED/VOIDED),
 * for database cleanup. Everything mid-lifecycle (OPEN/LOCKED/
 * AWAITING_RESULT/DRAFT, or the in-limbo READY_FOR_REVIEW/
 * SETTLEMENT_REVERSED/REVERSAL_FAILED_MANUAL_REVIEW states) still isn't
 * deletable — Cancel Pool is the only way to unwind one of those.
 *
 * The actual cascade + leaderboard-stat rollback lives in one atomic
 * plpgsql function (delete_terminal_pool) rather than sequential calls here
 * — this path can now touch real settled money history, where a partial
 * failure partway through would leave things inconsistent in a way the
 * original zero-entry-only version never risked.
 */
export async function deletePoolAction(poolId: string): Promise<DeletePoolResult> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const { data: pool } = await adminClient
    .from("pools")
    .select("id, question, title, pool_type, status, first_entry_at")
    .eq("id", poolId)
    .single();

  if (!pool) {
    return { success: false, error: "Pool not found." };
  }

  if (pool.first_entry_at !== null && !DELETABLE_TERMINAL_STATUSES.has(pool.status)) {
    return {
      success: false,
      error: "This pool is still active — cancel it, or wait until it's settled, voided, or cancelled, before deleting.",
    };
  }

  const { error } = await adminClient.rpc("delete_terminal_pool", {
    p_pool_id: poolId,
    p_admin_id: admin.id,
  });
  if (error) {
    return { success: false, error: "Could not delete this pool." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "pool.deleted",
    entityType: "pool",
    entityId: poolId,
    before: {
      question: pool.question,
      title: pool.title,
      poolType: pool.pool_type,
      status: pool.status,
    },
  });

  revalidatePath("/admin/pools");
  return { success: true, error: null };
}

export type ArchivePoolResult = { success: boolean; error: string | null };

const ARCHIVABLE_STATUSES = new Set(["SETTLED", "CANCELLED", "VOIDED"]);

/**
 * Soft-hides a resolved pool from the main admin pools list without
 * deleting it — unlike deletePoolAction, fully reversible via
 * unarchivePoolAction. Same eligibility set as delete (SETTLED/CANCELLED/
 * VOIDED) since those are exactly the "old, resolved" pools that clutter
 * the list once there's real history to look back on.
 */
export async function archivePoolAction(poolId: string): Promise<ArchivePoolResult> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const { data: pool } = await adminClient
    .from("pools")
    .select("id, status, archived_at")
    .eq("id", poolId)
    .single();

  if (!pool || !ARCHIVABLE_STATUSES.has(pool.status)) {
    return { success: false, error: "Only settled, voided, or cancelled pools can be archived." };
  }
  if (pool.archived_at) {
    return { success: true, error: null };
  }

  const { error } = await adminClient
    .from("pools")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", poolId);
  if (error) return { success: false, error: "Could not archive this pool." };

  await writeAuditLog({
    actorId: admin.id,
    action: "pool.archived",
    entityType: "pool",
    entityId: poolId,
  });

  revalidatePoolPaths(poolId);
  return { success: true, error: null };
}

export async function unarchivePoolAction(poolId: string): Promise<ArchivePoolResult> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const { error } = await adminClient.from("pools").update({ archived_at: null }).eq("id", poolId);
  if (error) return { success: false, error: "Could not unarchive this pool." };

  await writeAuditLog({
    actorId: admin.id,
    action: "pool.unarchived",
    entityType: "pool",
    entityId: poolId,
  });

  revalidatePoolPaths(poolId);
  return { success: true, error: null };
}

export type BulkArchivePoolsResult = {
  success: boolean;
  error: string | null;
  archivedCount: number;
  skippedIds: string[];
};

/** Bulk counterpart to archivePoolAction — same independent-per-pool shape as bulkDeletePoolsAction. */
export async function bulkArchivePoolsAction(poolIds: string[]): Promise<BulkArchivePoolsResult> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  if (poolIds.length === 0) {
    return { success: false, error: "No pools selected.", archivedCount: 0, skippedIds: [] };
  }

  const { data: pools } = await adminClient
    .from("pools")
    .select("id, status, archived_at")
    .in("id", poolIds);
  const poolById = new Map((pools ?? []).map((p) => [p.id as string, p]));
  const skippedIds: string[] = [];
  let archivedCount = 0;

  for (const poolId of poolIds) {
    const pool = poolById.get(poolId);
    if (!pool || !ARCHIVABLE_STATUSES.has(pool.status) || pool.archived_at) {
      skippedIds.push(poolId);
      continue;
    }

    const { error } = await adminClient
      .from("pools")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", poolId);
    if (error) {
      skippedIds.push(poolId);
      continue;
    }

    await writeAuditLog({
      actorId: admin.id,
      action: "pool.archived",
      entityType: "pool",
      entityId: poolId,
    });
    archivedCount++;
  }

  revalidatePath("/admin/pools");
  return {
    success: archivedCount > 0,
    error: archivedCount === 0 ? "None of the selected pools could be archived." : null,
    archivedCount,
    skippedIds,
  };
}

export type BulkUnarchivePoolsResult = {
  success: boolean;
  error: string | null;
  unarchivedCount: number;
  skippedIds: string[];
};

export async function bulkUnarchivePoolsAction(poolIds: string[]): Promise<BulkUnarchivePoolsResult> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  if (poolIds.length === 0) {
    return { success: false, error: "No pools selected.", unarchivedCount: 0, skippedIds: [] };
  }

  const { data: pools } = await adminClient.from("pools").select("id, archived_at").in("id", poolIds);
  const poolById = new Map((pools ?? []).map((p) => [p.id as string, p]));
  const skippedIds: string[] = [];
  let unarchivedCount = 0;

  for (const poolId of poolIds) {
    const pool = poolById.get(poolId);
    if (!pool || !pool.archived_at) {
      skippedIds.push(poolId);
      continue;
    }

    const { error } = await adminClient.from("pools").update({ archived_at: null }).eq("id", poolId);
    if (error) {
      skippedIds.push(poolId);
      continue;
    }

    await writeAuditLog({
      actorId: admin.id,
      action: "pool.unarchived",
      entityType: "pool",
      entityId: poolId,
    });
    unarchivedCount++;
  }

  revalidatePath("/admin/pools");
  return {
    success: unarchivedCount > 0,
    error: unarchivedCount === 0 ? "None of the selected pools could be unarchived." : null,
    unarchivedCount,
    skippedIds,
  };
}

export type BulkDeletePoolsResult = {
  success: boolean;
  error: string | null;
  deletedCount: number;
  skippedIds: string[];
};

/**
 * Bulk counterpart to deletePoolAction, for cleaning up many settled/
 * voided/cancelled pools at once (or a batch of never-entered drafts).
 * Each pool is checked and deleted independently — one ineligible or
 * already-gone pool in the selection doesn't abort the rest, it's just
 * reported back in skippedIds so the admin knows what didn't go through.
 */
export async function bulkDeletePoolsAction(poolIds: string[]): Promise<BulkDeletePoolsResult> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  if (poolIds.length === 0) {
    return { success: false, error: "No pools selected.", deletedCount: 0, skippedIds: [] };
  }

  const { data: pools } = await adminClient
    .from("pools")
    .select("id, question, title, pool_type, status, first_entry_at")
    .in("id", poolIds);

  const poolById = new Map((pools ?? []).map((p) => [p.id as string, p]));
  const skippedIds: string[] = [];
  let deletedCount = 0;

  for (const poolId of poolIds) {
    const pool = poolById.get(poolId);
    if (!pool || (pool.first_entry_at !== null && !DELETABLE_TERMINAL_STATUSES.has(pool.status))) {
      skippedIds.push(poolId);
      continue;
    }

    const { error } = await adminClient.rpc("delete_terminal_pool", {
      p_pool_id: poolId,
      p_admin_id: admin.id,
    });
    if (error) {
      skippedIds.push(poolId);
      continue;
    }

    await writeAuditLog({
      actorId: admin.id,
      action: "pool.deleted",
      entityType: "pool",
      entityId: poolId,
      before: {
        question: pool.question,
        title: pool.title,
        poolType: pool.pool_type,
        status: pool.status,
      },
    });
    deletedCount++;
  }

  revalidatePath("/admin/pools");
  return {
    success: deletedCount > 0,
    error: deletedCount === 0 ? "None of the selected pools could be deleted." : null,
    deletedCount,
    skippedIds,
  };
}
