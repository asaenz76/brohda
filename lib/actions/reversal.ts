"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { abortReversalSchema, requestReversalSchema } from "@/lib/validations/reversal";

export type RequestReversalState = { error: string | null };

export async function requestReversalAction(
  _prevState: RequestReversalState,
  formData: FormData,
): Promise<RequestReversalState> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const parsed = requestReversalSchema.safeParse({
    poolId: formData.get("poolId"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) {
    return { error: "A reason is required." };
  }

  const { data: before } = await adminClient
    .from("pools")
    .select("status, snapshot_version")
    .eq("id", parsed.data.poolId)
    .single();

  const { data: pool, error } = await adminClient.rpc("reverse_pool_settlement", {
    p_pool_id: parsed.data.poolId,
    p_admin_id: admin.id,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotencyKey,
  });

  if (error || !pool) {
    return { error: "Could not process this reversal request." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: pool.status === "REVERSAL_FAILED_MANUAL_REVIEW" ? "pool.reversal_blocked" : "pool.reversed",
    entityType: "pool",
    entityId: parsed.data.poolId,
    before,
    after: { status: pool.status, snapshotVersion: pool.snapshot_version },
    reason: parsed.data.reason,
  });

  revalidatePath(`/admin/pools/${parsed.data.poolId}`);
  revalidatePath("/admin/reports");
  return { error: null };
}

export type AbortReversalState = { error: string | null };

export async function abortReversalAction(
  _prevState: AbortReversalState,
  formData: FormData,
): Promise<AbortReversalState> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const parsed = abortReversalSchema.safeParse({
    poolId: formData.get("poolId"),
  });

  if (!parsed.success) {
    return { error: "Invalid request." };
  }

  const { data: before } = await adminClient
    .from("pools")
    .select("status, snapshot_version")
    .eq("id", parsed.data.poolId)
    .single();

  const { data: pool, error } = await adminClient.rpc("abort_pool_reversal", {
    p_pool_id: parsed.data.poolId,
    p_admin_id: admin.id,
  });

  if (error || !pool) {
    return { error: "Could not abort this reversal." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "pool.reversal_aborted",
    entityType: "pool",
    entityId: parsed.data.poolId,
    before,
    after: { status: pool.status },
  });

  revalidatePath(`/admin/pools/${parsed.data.poolId}`);
  revalidatePath("/admin/reports");
  return { error: null };
}
