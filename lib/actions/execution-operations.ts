"use server";

import { revalidatePath } from "next/cache";
import { requireExecutionControlsManager, requireExecutionRolloutManager } from "@/lib/execution/authorization";
import { recordAuditEvent } from "@/lib/execution/audit";
import { addCohortMember, createCohort, removeCohortMember, setCohortEnabled } from "@/lib/execution/cohorts";
import { createKillSwitch, disableKillSwitch } from "@/lib/execution/kill-switches";
import { createLimit, setLimitEnabled } from "@/lib/execution/limits";
import { setManualProviderOverride } from "@/lib/execution/provider-health";
import {
  cohortMembershipSchema,
  createCohortSchema,
  createKillSwitchSchema,
  createLimitSchema,
  disableKillSwitchSchema,
  setCohortEnabledSchema,
  setLimitEnabledSchema,
  setProviderOverrideSchema,
} from "@/lib/validations/execution-operations";

// Milestone 5.5 (STEP 7/32) — every mutation here: (1) requires the
// relevant capability (never a direct requireSuperAdmin() call), (2)
// validates input server-side, (3) writes through the service-role
// repository layer (never client-direct — the tables themselves have no
// authenticated-role grant at all), and (4) records an execution audit
// event capturing the previous/new state in safe metadata. No numeric
// value here is chosen by this file — every threshold/scope/target comes
// from the operator's own form input.
//
// Shaped as (prevState, FormData) => ActionResult, matching this
// codebase's own useActionState convention already established for
// app/(admin)/admin/discovery-categories's forms.

export interface ActionResult {
  success: boolean;
  error: string | null;
}

function str(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function createKillSwitchAction(_prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireExecutionControlsManager();
  const parsed = createKillSwitchSchema.safeParse({
    scope: str(formData, "scope"),
    target: str(formData, "target"),
    reason: str(formData, "reason"),
    note: str(formData, "note"),
    expiresAt: str(formData, "expiresAt") ? new Date(str(formData, "expiresAt")!).toISOString() : null,
  });
  if (!parsed.success) return { success: false, error: "Check the kill switch fields — scope, a matching target (unless GLOBAL), and a reason are required." };
  if (parsed.data.scope !== "GLOBAL" && !parsed.data.target) return { success: false, error: "A target is required for every scope except GLOBAL." };
  if (parsed.data.scope === "GLOBAL" && parsed.data.target) return { success: false, error: "GLOBAL switches must not have a target." };

  const switchRow = await createKillSwitch({
    scope: parsed.data.scope,
    target: parsed.data.target,
    reason: parsed.data.reason,
    note: parsed.data.note ?? null,
    expiresAt: parsed.data.expiresAt ?? null,
    createdBy: actor.id,
  });

  await recordAuditEvent({
    eventType: "KILL_SWITCH_ACTIVATED",
    actorUserId: actor.id,
    severity: "WARN",
    metadata: { switchId: switchRow.id, scope: switchRow.scope, target: switchRow.target, reason: switchRow.reason },
  });

  revalidatePath("/admin/execution-operations");
  return { success: true, error: null };
}

export async function disableKillSwitchAction(_prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireExecutionControlsManager();
  const parsed = disableKillSwitchSchema.safeParse({ id: str(formData, "id") });
  if (!parsed.success) return { success: false, error: "Invalid request." };

  const switchRow = await disableKillSwitch(parsed.data.id, actor.id);
  if (!switchRow) return { success: false, error: "That kill switch is already inactive or doesn't exist." };

  await recordAuditEvent({
    eventType: "KILL_SWITCH_DEACTIVATED",
    actorUserId: actor.id,
    severity: "INFO",
    metadata: { switchId: switchRow.id, scope: switchRow.scope, target: switchRow.target },
  });

  revalidatePath("/admin/execution-operations");
  return { success: true, error: null };
}

export async function createCohortAction(_prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireExecutionRolloutManager();
  const mode = str(formData, "mode");
  const percentageRaw = str(formData, "percentage");
  const parsed = createCohortSchema.safeParse({
    key: str(formData, "key"),
    name: str(formData, "name"),
    mode,
    percentage: percentageRaw ? Number(percentageRaw) : null,
    rolloutSeed: str(formData, "rolloutSeed"),
    providerScope: str(formData, "providerScope"),
    jurisdictionScope: str(formData, "jurisdictionScope"),
  });
  if (!parsed.success) return { success: false, error: "Check the cohort fields — key, name, and mode are required." };
  if (parsed.data.mode === "PERCENTAGE" && (parsed.data.percentage == null || !parsed.data.rolloutSeed)) {
    return { success: false, error: "A percentage cohort needs both a percentage and a rollout seed." };
  }

  const cohort = await createCohort({
    key: parsed.data.key,
    name: parsed.data.name,
    mode: parsed.data.mode,
    percentage: parsed.data.mode === "PERCENTAGE" ? (parsed.data.percentage ?? null) : null,
    rolloutSeed: parsed.data.mode === "PERCENTAGE" ? (parsed.data.rolloutSeed ?? null) : null,
    providerScope: parsed.data.providerScope ?? null,
    jurisdictionScope: parsed.data.jurisdictionScope ?? null,
    startsAt: null,
    endsAt: null,
    createdBy: actor.id,
  });

  await recordAuditEvent({ eventType: "POLICY_CHANGED", actorUserId: actor.id, metadata: { entity: "execution_cohort", cohortId: cohort.id, action: "created" } });
  revalidatePath("/admin/execution-operations");
  return { success: true, error: null };
}

export async function setCohortEnabledAction(_prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireExecutionRolloutManager();
  const parsed = setCohortEnabledSchema.safeParse({ id: str(formData, "id"), enabled: str(formData, "enabled") === "true" });
  if (!parsed.success) return { success: false, error: "Invalid request." };

  const cohort = await setCohortEnabled(parsed.data.id, parsed.data.enabled);
  if (!cohort) return { success: false, error: "Cohort not found." };

  await recordAuditEvent({
    eventType: "POLICY_CHANGED",
    actorUserId: actor.id,
    metadata: { entity: "execution_cohort", cohortId: cohort.id, action: parsed.data.enabled ? "enabled" : "disabled" },
  });
  revalidatePath("/admin/execution-operations");
  return { success: true, error: null };
}

export async function addCohortMemberAction(_prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireExecutionRolloutManager();
  const parsed = cohortMembershipSchema.safeParse({ cohortId: str(formData, "cohortId"), userId: str(formData, "userId") });
  if (!parsed.success) return { success: false, error: "A valid cohort and user id are required." };

  await addCohortMember(parsed.data.cohortId, parsed.data.userId, actor.id);
  await recordAuditEvent({
    eventType: "POLICY_CHANGED",
    actorUserId: actor.id,
    metadata: { entity: "execution_cohort_member", cohortId: parsed.data.cohortId, memberUserId: parsed.data.userId, action: "added" },
  });
  revalidatePath("/admin/execution-operations");
  return { success: true, error: null };
}

export async function removeCohortMemberAction(_prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireExecutionRolloutManager();
  const parsed = cohortMembershipSchema.safeParse({ cohortId: str(formData, "cohortId"), userId: str(formData, "userId") });
  if (!parsed.success) return { success: false, error: "Invalid request." };

  await removeCohortMember(parsed.data.cohortId, parsed.data.userId);
  await recordAuditEvent({
    eventType: "POLICY_CHANGED",
    actorUserId: actor.id,
    metadata: { entity: "execution_cohort_member", cohortId: parsed.data.cohortId, memberUserId: parsed.data.userId, action: "removed" },
  });
  revalidatePath("/admin/execution-operations");
  return { success: true, error: null };
}

export async function createLimitAction(_prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireExecutionControlsManager();
  const windowRaw = str(formData, "windowSeconds");
  const thresholdRaw = str(formData, "thresholdValue");
  const parsed = createLimitSchema.safeParse({
    scope: str(formData, "scope"),
    target: str(formData, "target"),
    limitType: str(formData, "limitType"),
    thresholdValue: thresholdRaw ? Number(thresholdRaw) : NaN,
    windowSeconds: windowRaw ? Number(windowRaw) : null,
  });
  if (!parsed.success) return { success: false, error: "Check the limit fields — scope, type, and a positive threshold are required." };
  if (parsed.data.scope !== "GLOBAL" && !parsed.data.target) return { success: false, error: "A target is required for every scope except GLOBAL." };
  if (parsed.data.limitType === "ROLLING_AMOUNT_CENTS" && !parsed.data.windowSeconds) {
    return { success: false, error: "A rolling limit needs a window in seconds." };
  }

  const limit = await createLimit({
    scope: parsed.data.scope,
    target: parsed.data.target,
    limitType: parsed.data.limitType,
    thresholdValue: parsed.data.thresholdValue,
    windowSeconds: parsed.data.limitType === "ROLLING_AMOUNT_CENTS" ? (parsed.data.windowSeconds ?? null) : null,
    createdBy: actor.id,
  });

  await recordAuditEvent({
    eventType: "POLICY_CHANGED",
    actorUserId: actor.id,
    severity: "WARN",
    metadata: { entity: "execution_limit", limitId: limit.id, scope: limit.scope, limitType: limit.limitType, thresholdValue: limit.thresholdValue, action: "created" },
  });
  revalidatePath("/admin/execution-operations");
  return { success: true, error: null };
}

export async function setLimitEnabledAction(_prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireExecutionControlsManager();
  const parsed = setLimitEnabledSchema.safeParse({ id: str(formData, "id"), enabled: str(formData, "enabled") === "true" });
  if (!parsed.success) return { success: false, error: "Invalid request." };

  const limit = await setLimitEnabled(parsed.data.id, parsed.data.enabled);
  if (!limit) return { success: false, error: "Limit not found." };

  await recordAuditEvent({
    eventType: "POLICY_CHANGED",
    actorUserId: actor.id,
    metadata: { entity: "execution_limit", limitId: limit.id, action: parsed.data.enabled ? "enabled" : "disabled" },
  });
  revalidatePath("/admin/execution-operations");
  return { success: true, error: null };
}

export async function setProviderOverrideAction(_prevState: ActionResult, formData: FormData): Promise<ActionResult> {
  const actor = await requireExecutionControlsManager();
  const parsed = setProviderOverrideSchema.safeParse({
    provider: str(formData, "provider"),
    disabled: str(formData, "disabled") === "true",
    reason: str(formData, "reason"),
  });
  if (!parsed.success) return { success: false, error: "Invalid request." };
  if (parsed.data.disabled && !parsed.data.reason) return { success: false, error: "A reason is required to manually disable a provider." };

  await setManualProviderOverride({ provider: parsed.data.provider, disabled: parsed.data.disabled, reason: parsed.data.reason ?? null, setBy: actor.id });

  await recordAuditEvent({
    eventType: "PROVIDER_HEALTH_CHANGED",
    actorUserId: actor.id,
    provider: parsed.data.provider,
    severity: parsed.data.disabled ? "WARN" : "INFO",
    metadata: { manuallyDisabled: parsed.data.disabled, reason: parsed.data.reason ?? null },
  });
  revalidatePath("/admin/execution-operations");
  return { success: true, error: null };
}
