"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import {
  updatePredictionSettings,
  updateNotificationSettings,
  updateMarketSettings,
  updateCommunitySettings,
  updateConversationSettings,
  updateCallBsSettings,
  updateMonetarySettings,
  updateReputationSettings,
  updateOperationsSettings,
} from "@/lib/admin-settings/repository";
import type {
  PredictionSettings,
  NotificationSettings,
  MarketSettings,
  CommunitySettings,
  ConversationSettings,
  CallBsSettings,
  MonetarySettings,
  ReputationSettings,
  OperationsSettings,
  BrohdaSettings,
} from "@/lib/admin-settings/types";
import { parsePercentToBps } from "@/lib/utils/money";

// Milestone R12. Every action here: (1) requireSuperAdmin() first line —
// server-side authorization, never trusting client role state (§8); this
// whole surface is super_admin-only, mirroring the pre-existing
// /admin/settings page's own established monolithic gate (§7 — see
// docs/architecture/admin-configuration.md's "Role model" section for
// the full reasoning); (2) explicit typed parameters only, never a
// generic key/value payload (§9); (3) validate, returning a clean
// operator-readable error on failure, never throwing for an ordinary bad
// input; (4) call the one RPC that atomically updates platform_settings
// AND writes the audit_logs row in the same transaction (§89) — this
// file never calls writeAuditLog() itself, since that would create a
// second, non-atomic audit entry duplicating what the RPC already wrote;
// (5) map the RPC's own `conflict` outcome to a distinct, actionable
// result rather than silently overwriting a newer admin's change
// (§42, §59, §74); (6) revalidate every affected route.

export type BrohdaSettingsActionResult = { success: boolean; error: string | null; conflict: boolean; settings: BrohdaSettings | null };

function revalidateBrohdaSettings() {
  revalidatePath("/admin/settings/brohda");
  revalidatePath("/admin/settings/brohda/history");
}

export async function updatePredictionSettingsAction(expectedUpdatedAt: string, values: PredictionSettings): Promise<BrohdaSettingsActionResult> {
  const admin = await requireSuperAdmin();

  if (values.pickLockMinutesBeforeKickoff < 0) return { success: false, error: "Pick lock must be zero or more minutes.", conflict: false, settings: null };
  if (values.predictionCutoffMinutesBeforeClose < 0) return { success: false, error: "Prediction cutoff must be zero or more minutes.", conflict: false, settings: null };

  let result;
  try {
    result = await updatePredictionSettings(admin.id, expectedUpdatedAt, values);
  } catch {
    return { success: false, error: "Could not update Predictions settings.", conflict: false, settings: null };
  }

  if (result.outcome === "conflict") {
    return { success: false, error: "Someone else changed these settings since you loaded this page. Review the current values and try again.", conflict: true, settings: result.settings };
  }

  revalidateBrohdaSettings();
  return { success: true, error: null, conflict: false, settings: result.settings };
}

export async function updateNotificationSettingsAction(expectedUpdatedAt: string, values: NotificationSettings): Promise<BrohdaSettingsActionResult> {
  const admin = await requireSuperAdmin();

  const copyFields = [
    values.predictionNotifyTitleCorrect,
    values.predictionNotifyBodyCorrect,
    values.predictionNotifyTitleIncorrect,
    values.predictionNotifyBodyIncorrect,
    values.predictionNotifyTitleVoid,
    values.predictionNotifyBodyVoid,
  ];
  if (copyFields.some((value) => value.trim().length === 0)) {
    return { success: false, error: "Every notification title and body must be non-empty.", conflict: false, settings: null };
  }

  let result;
  try {
    result = await updateNotificationSettings(admin.id, expectedUpdatedAt, values);
  } catch {
    return { success: false, error: "Could not update Notifications settings.", conflict: false, settings: null };
  }

  if (result.outcome === "conflict") {
    return { success: false, error: "Someone else changed these settings since you loaded this page. Review the current values and try again.", conflict: true, settings: result.settings };
  }

  revalidateBrohdaSettings();
  return { success: true, error: null, conflict: false, settings: result.settings };
}

export async function updateMarketSettingsAction(expectedUpdatedAt: string, values: MarketSettings): Promise<BrohdaSettingsActionResult> {
  const admin = await requireSuperAdmin();

  if (values.marketIngestionMinBookmakerCount < 1) return { success: false, error: "Minimum bookmaker count must be at least 1.", conflict: false, settings: null };
  if (values.feedCompletedGameRetentionHours < 0) return { success: false, error: "Feed completed-game retention hours cannot be negative.", conflict: false, settings: null };

  let result;
  try {
    result = await updateMarketSettings(admin.id, expectedUpdatedAt, values);
  } catch {
    return { success: false, error: "Could not update Markets settings.", conflict: false, settings: null };
  }

  if (result.outcome === "conflict") {
    return { success: false, error: "Someone else changed these settings since you loaded this page. Review the current values and try again.", conflict: true, settings: result.settings };
  }

  revalidateBrohdaSettings();
  revalidatePath("/markets");
  return { success: true, error: null, conflict: false, settings: result.settings };
}

export async function updateCommunitySettingsAction(expectedUpdatedAt: string, values: CommunitySettings): Promise<BrohdaSettingsActionResult> {
  const admin = await requireSuperAdmin();

  let result;
  try {
    result = await updateCommunitySettings(admin.id, expectedUpdatedAt, values);
  } catch {
    return { success: false, error: "Could not update Communities settings.", conflict: false, settings: null };
  }

  if (result.outcome === "conflict") {
    return { success: false, error: "Someone else changed these settings since you loaded this page. Review the current values and try again.", conflict: true, settings: result.settings };
  }

  revalidateBrohdaSettings();
  return { success: true, error: null, conflict: false, settings: result.settings };
}

export async function updateConversationSettingsAction(expectedUpdatedAt: string, values: ConversationSettings): Promise<BrohdaSettingsActionResult> {
  const admin = await requireSuperAdmin();

  if (values.postCommentMaxLength < 1 || values.postCommentMaxLength > 2000) {
    return { success: false, error: "Max comment length must be between 1 and 2000 characters.", conflict: false, settings: null };
  }
  if (values.postCommentRateLimitWindowSeconds < 1) return { success: false, error: "Rate-limit window must be at least 1 second.", conflict: false, settings: null };
  if (values.postCommentRateLimitMaxAttempts < 1) return { success: false, error: "Rate-limit attempts must be at least 1.", conflict: false, settings: null };

  let result;
  try {
    result = await updateConversationSettings(admin.id, expectedUpdatedAt, values);
  } catch {
    return { success: false, error: "Could not update Conversation settings.", conflict: false, settings: null };
  }

  if (result.outcome === "conflict") {
    return { success: false, error: "Someone else changed these settings since you loaded this page. Review the current values and try again.", conflict: true, settings: result.settings };
  }

  revalidateBrohdaSettings();
  return { success: true, error: null, conflict: false, settings: result.settings };
}

export async function updateCallBsSettingsAction(expectedUpdatedAt: string, values: CallBsSettings): Promise<BrohdaSettingsActionResult> {
  const admin = await requireSuperAdmin();

  if (values.callBsRateLimitWindowSeconds < 1) return { success: false, error: "Rate-limit window must be at least 1 second.", conflict: false, settings: null };
  if (values.callBsRateLimitMaxAttempts < 1) return { success: false, error: "Rate-limit attempts must be at least 1.", conflict: false, settings: null };

  let result;
  try {
    result = await updateCallBsSettings(admin.id, expectedUpdatedAt, values);
  } catch {
    return { success: false, error: "Could not update Call BS settings.", conflict: false, settings: null };
  }

  if (result.outcome === "conflict") {
    return { success: false, error: "Someone else changed these settings since you loaded this page. Review the current values and try again.", conflict: true, settings: result.settings };
  }

  revalidateBrohdaSettings();
  return { success: true, error: null, conflict: false, settings: result.settings };
}

/** `feePercent` is a display-layer string (e.g. "2.5") converted here via the existing parsePercentToBps utility (lib/utils/money.ts) — the same integer-basis-points parsing already used for pool house-fee configuration, never floating-point financial arithmetic. */
export async function updateMonetarySettingsAction(
  expectedUpdatedAt: string,
  values: { monetaryP2pEnabled: boolean; monetaryProposalRateLimitWindowSeconds: number; monetaryProposalRateLimitMaxAttempts: number; feePercent: string },
): Promise<BrohdaSettingsActionResult> {
  const admin = await requireSuperAdmin();

  if (values.monetaryProposalRateLimitWindowSeconds < 1) return { success: false, error: "Rate-limit window must be at least 1 second.", conflict: false, settings: null };
  if (values.monetaryProposalRateLimitMaxAttempts < 1) return { success: false, error: "Rate-limit attempts must be at least 1.", conflict: false, settings: null };

  const p2pFeeBps = parsePercentToBps(values.feePercent);
  if (p2pFeeBps === null) return { success: false, error: "Enter a valid fee percentage between 0% and 100%.", conflict: false, settings: null };

  const settingsValues: MonetarySettings = {
    monetaryP2pEnabled: values.monetaryP2pEnabled,
    monetaryProposalRateLimitWindowSeconds: values.monetaryProposalRateLimitWindowSeconds,
    monetaryProposalRateLimitMaxAttempts: values.monetaryProposalRateLimitMaxAttempts,
    p2pFeeBps,
  };

  let result;
  try {
    result = await updateMonetarySettings(admin.id, expectedUpdatedAt, settingsValues);
  } catch {
    return { success: false, error: "Could not update Monetary P2P settings.", conflict: false, settings: null };
  }

  if (result.outcome === "conflict") {
    return { success: false, error: "Someone else changed these settings since you loaded this page. Review the current values and try again.", conflict: true, settings: result.settings };
  }

  revalidateBrohdaSettings();
  return { success: true, error: null, conflict: false, settings: result.settings };
}

export async function updateReputationSettingsAction(expectedUpdatedAt: string, values: ReputationSettings): Promise<BrohdaSettingsActionResult> {
  const admin = await requireSuperAdmin();

  if (values.leaderboardMinDecidedPicks < 0) return { success: false, error: "Leaderboard minimum must be zero or more.", conflict: false, settings: null };

  let result;
  try {
    result = await updateReputationSettings(admin.id, expectedUpdatedAt, values);
  } catch {
    return { success: false, error: "Could not update Reputation settings.", conflict: false, settings: null };
  }

  if (result.outcome === "conflict") {
    return { success: false, error: "Someone else changed these settings since you loaded this page. Review the current values and try again.", conflict: true, settings: result.settings };
  }

  revalidateBrohdaSettings();
  revalidatePath("/leaderboard/predictions");
  return { success: true, error: null, conflict: false, settings: result.settings };
}

export async function updateOperationsSettingsAction(expectedUpdatedAt: string, values: OperationsSettings): Promise<BrohdaSettingsActionResult> {
  const admin = await requireSuperAdmin();

  if (values.settlementBatchSize < 1 || values.settlementBatchSize > 5000) {
    return { success: false, error: "Settlement batch size must be between 1 and 5000.", conflict: false, settings: null };
  }
  if (values.gradingBatchSize < 1 || values.gradingBatchSize > 5000) {
    return { success: false, error: "Grading batch size must be between 1 and 5000.", conflict: false, settings: null };
  }
  if (values.challengeResolutionBatchSize < 1 || values.challengeResolutionBatchSize > 5000) {
    return { success: false, error: "Challenge resolution batch size must be between 1 and 5000.", conflict: false, settings: null };
  }
  if (values.jobStalenessMultiplier < 1 || values.jobStalenessMultiplier > 20) {
    return { success: false, error: "Job staleness tolerance must be between 1 and 20.", conflict: false, settings: null };
  }

  let result;
  try {
    result = await updateOperationsSettings(admin.id, expectedUpdatedAt, values);
  } catch {
    return { success: false, error: "Could not update Operations settings.", conflict: false, settings: null };
  }

  if (result.outcome === "conflict") {
    return { success: false, error: "Someone else changed these settings since you loaded this page. Review the current values and try again.", conflict: true, settings: result.settings };
  }

  revalidateBrohdaSettings();
  return { success: true, error: null, conflict: false, settings: result.settings };
}
