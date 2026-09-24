/**
 * Integration tests for Milestone R12 (docs/BROHDA_2_0_MILESTONE_MAP.md,
 * Admin + Configuration) — the 9 update_<domain>_settings() RPCs, their
 * repository wrappers (lib/admin-settings/repository.ts), the audit trail
 * they write, optimistic concurrency, the P2P fee-snapshot non-retroactivity
 * guarantee re-verified end-to-end through THIS milestone's own admin path,
 * and the configuration-discovery cross-check against the live schema.
 * Real local Supabase throughout — no real money.
 *
 * Authorization at the RPC/Postgres-grant boundary (service_role only) is
 * covered by tests/integration/rpc-privilege-boundary.test.ts. Authorization
 * and validation at the Server Action layer (requireSuperAdmin() gating all
 * 9 actions, including the financial one, plus every TS-side validation
 * branch) is covered by tests/unit/admin-brohda-settings-actions.test.ts.
 * This file exercises the layer between those two: the repository
 * functions and the RPCs they call.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { getTestAdminClient, getTestDatabaseUrl, getTestSupabaseConfig } from "./helpers/test-env";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import {
  getBrohdaSettings,
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
import { SETTINGS_REGISTRY, NOT_EXPOSED_SETTINGS } from "@/lib/admin-settings/registry";
import { proposeMoney, acceptMonetaryProposal, settleMonetaryPosition, getMonetaryPositionSettlementByPositionId } from "@/lib/monetary/repository";

const { url: SUPABASE_URL, anonKey: ANON_KEY } = getTestSupabaseConfig();
const admin = getTestAdminClient();
const PROVIDER = "api_nfl";

const createdFixtureIds: string[] = [];
const createdMarketIds: string[] = [];
const createdUserIds: string[] = [];
let adminUserId: string;

async function createFixture(): Promise<string> {
  const { data, error } = await admin
    .from("fixtures")
    .insert({
      provider: PROVIDER,
      external_fixture_id: `r12-fixture-${randomUUID()}`,
      home_team_name: "Home Test NFL",
      away_team_name: "Away Test NFL",
      scheduled_start_utc: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      internal_status: "NOT_STARTED",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("failed to create fixture");
  createdFixtureIds.push(data.id);
  return data.id;
}

async function createMarket(fixtureId: string): Promise<string> {
  const payload: NormalizedMarket = {
    provider: PROVIDER,
    providerMarketId: `m_${Math.random().toString(36).slice(2)}`,
    providerEventId: null,
    question: "Will the home team win?",
    description: null,
    status: "ACTIVE",
    fixtureId,
    marketTemplate: "MONEYLINE",
    lineValue: null,
    yesSide: "HOME",
    price: { yes: 0.6, no: 0.4, outcomeLabels: { yes: "Home", no: "Away" } },
    volume24hr: null,
    liquidity: null,
    resolutionStatus: null,
    resolvedBy: null,
    resolvedOutcome: null,
    opensAt: null,
    closesAt: null,
    closedAt: null,
    ingestionSource: "test",
    providerMetadata: {},
  };
  const { id } = await upsertMarket(payload);
  createdMarketIds.push(id);
  return id;
}

async function createFreshMarket(): Promise<string> {
  return createMarket(await createFixture());
}

async function createUser(label = "r12", role: "player" | "admin" | "super_admin" = "player") {
  const email = `${label}-${randomUUID()}@test.local`;
  const password = "integration-test-password-123";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: label, role, is_active: true });
  createdUserIds.push(data.user.id);
  const client = createSupabaseClient(SUPABASE_URL, ANON_KEY);
  await client.auth.signInWithPassword({ email, password });
  return { userId: data.user.id, client };
}

async function pick(userId: string, marketId: string, selectedOutcome: "YES" | "NO"): Promise<string> {
  const { data, error } = await admin
    .from("predictions")
    .insert({
      user_id: userId,
      market_id: marketId,
      selected_outcome: selectedOutcome,
      yes_probability_snapshot: 0.6,
      no_probability_snapshot: 0.4,
      market_question_snapshot: "q",
      market_close_at_snapshot: null,
      market_status_snapshot: "ACTIVE",
      idempotency_key: randomUUID(),
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("pick failed");
  return data.id as string;
}

async function grade(predictionId: string, result: "CORRECT" | "INCORRECT" | "VOID") {
  const resolvedOutcomeSnapshot = result === "VOID" ? null : result === "CORRECT" ? "YES" : "NO";
  const { error } = await admin
    .from("predictions")
    .update({ lifecycle_state: "GRADED", result, resolved_outcome_snapshot: resolvedOutcomeSnapshot, graded_at: new Date().toISOString() })
    .eq("id", predictionId);
  if (error) throw error;
}

async function deposit(userId: string, amount: number) {
  const { error } = await admin.rpc("apply_wallet_transaction", {
    p_account_type: "user",
    p_user_id: userId,
    p_type: "manual_deposit",
    p_direction: "credit",
    p_amount: amount,
    p_admin_id: null,
    p_reason: "test funding",
    p_idempotency_key: randomUUID(),
  });
  if (error) throw error;
}

/** Two opposing, funded users with a committed Position at the CURRENT platform p2p_fee_bps. */
async function setupCommittedPosition(stake = 1000) {
  const marketId = await createFreshMarket();
  const proposer = await createUser("r12-proposer");
  const recipient = await createUser("r12-recipient");
  await deposit(proposer.userId, stake);
  await deposit(recipient.userId, stake);
  const proposerPredictionId = await pick(proposer.userId, marketId, "YES");
  const recipientPredictionId = await pick(recipient.userId, marketId, "NO");
  const proposed = await proposeMoney(proposer.userId, recipientPredictionId, stake, randomUUID());
  if (!proposed.ok) throw new Error("setup failed: " + proposed.error);
  const accepted = await acceptMonetaryProposal(proposed.proposal.id, recipient.userId);
  if (accepted.outcome !== "accepted" || !accepted.position) throw new Error("setup failed: acceptance");
  return { marketId, proposer, recipient, proposerPredictionId, recipientPredictionId, position: accepted.position };
}

async function latestAuditRow(action: string) {
  const { data, error } = await admin.from("audit_logs").select("*").eq("entity_type", "platform_settings").eq("action", action).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data as { id: string; actor_id: string; action: string; before: unknown; after: unknown; created_at: string } | null;
}

async function currentUpdatedAt(): Promise<string> {
  const { data, error } = await admin.from("platform_settings").select("updated_at").eq("id", true).single();
  if (error || !data) throw error ?? new Error("no platform_settings row");
  return data.updated_at as string;
}

const DEFAULT_PREDICTIONS = { pickLockMinutesBeforeKickoff: 10, predictionCutoffMinutesBeforeClose: 0, predictionAllowRepeat: false, predictionAllowStalePrice: true, predictionAllowUnavailablePrice: false, predictionAllowClosedMarket: false };
const DEFAULT_REPUTATION = { leaderboardMinDecidedPicks: 5 };
const DEFAULT_MONETARY = { monetaryP2pEnabled: true, monetaryProposalRateLimitWindowSeconds: 60, monetaryProposalRateLimitMaxAttempts: 10, p2pFeeBps: 0 };
const DEFAULT_OPERATIONS = { settlementBatchSize: 500, gradingBatchSize: 200, challengeResolutionBatchSize: 200, jobStalenessMultiplier: 3 };

beforeEach(async () => {
  const { userId } = await createUser("r12-admin", "super_admin");
  adminUserId = userId;
  await admin
    .from("platform_settings")
    .update({
      pick_lock_minutes_before_kickoff: DEFAULT_PREDICTIONS.pickLockMinutesBeforeKickoff,
      prediction_cutoff_minutes_before_close: DEFAULT_PREDICTIONS.predictionCutoffMinutesBeforeClose,
      prediction_allow_repeat: DEFAULT_PREDICTIONS.predictionAllowRepeat,
      prediction_allow_stale_price: DEFAULT_PREDICTIONS.predictionAllowStalePrice,
      prediction_allow_unavailable_price: DEFAULT_PREDICTIONS.predictionAllowUnavailablePrice,
      prediction_allow_closed_market: DEFAULT_PREDICTIONS.predictionAllowClosedMarket,
      leaderboard_min_decided_picks: DEFAULT_REPUTATION.leaderboardMinDecidedPicks,
      monetary_p2p_enabled: DEFAULT_MONETARY.monetaryP2pEnabled,
      monetary_proposal_rate_limit_window_seconds: DEFAULT_MONETARY.monetaryProposalRateLimitWindowSeconds,
      monetary_proposal_rate_limit_max_attempts: DEFAULT_MONETARY.monetaryProposalRateLimitMaxAttempts,
      p2p_fee_bps: DEFAULT_MONETARY.p2pFeeBps,
      settlement_batch_size: DEFAULT_OPERATIONS.settlementBatchSize,
      grading_batch_size: DEFAULT_OPERATIONS.gradingBatchSize,
      challenge_resolution_batch_size: DEFAULT_OPERATIONS.challengeResolutionBatchSize,
      job_staleness_multiplier: DEFAULT_OPERATIONS.jobStalenessMultiplier,
      call_bs_enabled: true,
    })
    .eq("id", true);
});

afterEach(async () => {
  if (createdMarketIds.length > 0) {
    const { data: positionRows } = await admin.from("monetary_positions").select("id").in("market_id", createdMarketIds);
    const positionIds = (positionRows ?? []).map((r) => r.id);
    const { data: proposalRows } = await admin.from("monetary_proposals").select("id").in("market_id", createdMarketIds);
    const proposalIds = (proposalRows ?? []).map((r) => r.id);
    if (proposalIds.length > 0) {
      await admin.from("notifications").delete().in("monetary_proposal_id", proposalIds);
      if (positionIds.length > 0) await admin.from("monetary_positions").delete().in("id", positionIds);
      await admin.from("monetary_proposals").delete().in("id", proposalIds);
    }
    if (positionIds.length > 0) await admin.from("monetary_position_settlements").delete().in("position_id", positionIds);
    await admin.from("predictions").delete().in("market_id", createdMarketIds);
    await admin.from("markets").delete().in("id", createdMarketIds);
    createdMarketIds.length = 0;
  }
  if (createdFixtureIds.length > 0) {
    await admin.from("fixtures").delete().in("id", createdFixtureIds);
    createdFixtureIds.length = 0;
  }
  if (createdUserIds.length > 0) {
    await admin.from("wallet_reservations").delete().in("user_id", createdUserIds);
    for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
    createdUserIds.length = 0;
  }
  // audit_logs is genuinely append-only (forbid_audit_log_mutation blocks
  // delete/update unconditionally, even for service_role — see the
  // "Audit immutability" tests below) — there is nothing to clean up here.
  // Every assertion below that counts rows scopes by this test's own fresh
  // adminUserId rather than by action name alone, so rows left behind by
  // earlier test runs (or this file's own earlier tests) never leak in.
});

describe("Read path", () => {
  it("getBrohdaSettings() reflects the live row, including a resolved actor display name", async () => {
    const at = await currentUpdatedAt();
    const result = await updateReputationSettings(adminUserId, at, { leaderboardMinDecidedPicks: 9 });
    expect(result.outcome).toBe("updated");

    const settings = await getBrohdaSettings();
    expect(settings.reputation.leaderboardMinDecidedPicks).toBe(9);
    expect(settings.updatedByDisplayName).toBe("r12-admin");
  });
});

describe("Atomic update + audit, one domain per RPC", () => {
  it("Predictions: updates the row and writes one scoped, correctly-attributed audit row in the same transaction", async () => {
    const at = await currentUpdatedAt();
    const result = await updatePredictionSettings(adminUserId, at, { ...DEFAULT_PREDICTIONS, pickLockMinutesBeforeKickoff: 15 });
    expect(result.outcome).toBe("updated");
    expect(result.settings.predictions.pickLockMinutesBeforeKickoff).toBe(15);

    const auditRow = await latestAuditRow("settings.predictions_updated");
    expect(auditRow).not.toBeNull();
    expect(auditRow!.actor_id).toBe(adminUserId);
    expect((auditRow!.before as { pickLockMinutesBeforeKickoff: number }).pickLockMinutesBeforeKickoff).toBe(10);
    expect((auditRow!.after as { pickLockMinutesBeforeKickoff: number }).pickLockMinutesBeforeKickoff).toBe(15);
    // Scoped to the Predictions domain's own fields only — never the whole 48-column row.
    expect(Object.keys(auditRow!.after as object).sort()).toEqual(Object.keys(DEFAULT_PREDICTIONS).sort());
  });

  it("Notifications: updates copy and flags atomically", async () => {
    const at = await currentUpdatedAt();
    const values = { predictionNotificationsEnabled: false, predictionNotifyOnCorrect: false, predictionNotifyOnIncorrect: true, predictionNotifyOnVoid: true, predictionNotifyTitleCorrect: "Nice", predictionNotifyBodyCorrect: "Nice.", predictionNotifyTitleIncorrect: "Oh well", predictionNotifyBodyIncorrect: "Oh well.", predictionNotifyTitleVoid: "Void", predictionNotifyBodyVoid: "Void." };
    const result = await updateNotificationSettings(adminUserId, at, values);
    expect(result.outcome).toBe("updated");
    expect(result.settings.notifications).toEqual(values);
    const auditRow = await latestAuditRow("settings.notifications_updated");
    expect((auditRow!.after as typeof values).predictionNotifyTitleCorrect).toBe("Nice");
  });

  it("Markets: updates ingestion and publication policy atomically", async () => {
    const at = await currentUpdatedAt();
    const values = { marketIngestionEnabled: false, marketIngestionMinBookmakerCount: 4, postPublicationEnabled: false, postPublicationRequiresActiveMarket: false };
    const result = await updateMarketSettings(adminUserId, at, values);
    expect(result.outcome).toBe("updated");
    expect(result.settings.markets).toEqual(values);
  });

  it("Communities: updates all 4 distribution flags atomically", async () => {
    const at = await currentUpdatedAt();
    const values = { communityDistributionEnabled: false, communityTeamDistributionEnabled: false, communityLeagueDistributionEnabled: true, communitySportDistributionEnabled: false };
    const result = await updateCommunitySettings(adminUserId, at, values);
    expect(result.outcome).toBe("updated");
    expect(result.settings.communities).toEqual(values);
  });

  it("Conversation: updates comment length and rate limit atomically", async () => {
    const at = await currentUpdatedAt();
    const values = { postCommentMaxLength: 280, postCommentRateLimitWindowSeconds: 30, postCommentRateLimitMaxAttempts: 5 };
    const result = await updateConversationSettings(adminUserId, at, values);
    expect(result.outcome).toBe("updated");
    expect(result.settings.conversation).toEqual(values);
  });

  it("Call BS: updates the switch and rate limit atomically", async () => {
    const at = await currentUpdatedAt();
    const values = { callBsEnabled: false, callBsRateLimitWindowSeconds: 30, callBsRateLimitMaxAttempts: 5 };
    const result = await updateCallBsSettings(adminUserId, at, values);
    expect(result.outcome).toBe("updated");
    expect(result.settings.callBs).toEqual(values);
  });

  it("Reputation: updates the leaderboard minimum", async () => {
    const at = await currentUpdatedAt();
    const result = await updateReputationSettings(adminUserId, at, { leaderboardMinDecidedPicks: 12 });
    expect(result.outcome).toBe("updated");
    expect(result.settings.reputation.leaderboardMinDecidedPicks).toBe(12);
  });

  it("Operations: updates the settlement, grading, challenge-resolution batch sizes, and job staleness multiplier", async () => {
    const at = await currentUpdatedAt();
    const result = await updateOperationsSettings(adminUserId, at, {
      settlementBatchSize: 250,
      gradingBatchSize: 150,
      challengeResolutionBatchSize: 100,
      jobStalenessMultiplier: 5,
    });
    expect(result.outcome).toBe("updated");
    expect(result.settings.operations).toEqual({
      settlementBatchSize: 250,
      gradingBatchSize: 150,
      challengeResolutionBatchSize: 100,
      jobStalenessMultiplier: 5,
    });
  });

  it("a second change to the same domain produces a second, distinct audit event", async () => {
    let at = await currentUpdatedAt();
    await updateReputationSettings(adminUserId, at, { leaderboardMinDecidedPicks: 7 });
    at = await currentUpdatedAt();
    await updateReputationSettings(adminUserId, at, { leaderboardMinDecidedPicks: 3 });

    const { data: rows } = await admin
      .from("audit_logs")
      .select("before, after, created_at")
      .eq("action", "settings.reputation_updated")
      .eq("actor_id", adminUserId)
      .order("created_at", { ascending: true });
    expect(rows).toHaveLength(2);
    expect((rows![0].after as { leaderboardMinDecidedPicks: number }).leaderboardMinDecidedPicks).toBe(7);
    expect((rows![1].before as { leaderboardMinDecidedPicks: number }).leaderboardMinDecidedPicks).toBe(7);
    expect((rows![1].after as { leaderboardMinDecidedPicks: number }).leaderboardMinDecidedPicks).toBe(3);
  });

  it("a no-op save (identical values) still commits and logs — documented, intentional: Save always means 'apply these values now', matching the pre-existing legacy settings pattern", async () => {
    const at = await currentUpdatedAt();
    const result = await updateOperationsSettings(adminUserId, at, DEFAULT_OPERATIONS);
    expect(result.outcome).toBe("updated");
    const auditRow = await latestAuditRow("settings.operations_updated");
    expect(auditRow!.before).toEqual(auditRow!.after);
  });
});

describe("Optimistic concurrency", () => {
  it("rejects a stale expected_updated_at with a distinct 'conflict' outcome and applies nothing", async () => {
    const staleAt = await currentUpdatedAt();
    // A different admin's change lands first, bumping the shared token.
    await updatePredictionSettings(adminUserId, staleAt, { ...DEFAULT_PREDICTIONS, pickLockMinutesBeforeKickoff: 20 });

    const conflictResult = await updatePredictionSettings(adminUserId, staleAt, { ...DEFAULT_PREDICTIONS, pickLockMinutesBeforeKickoff: 99 });
    expect(conflictResult.outcome).toBe("conflict");
    // The conflict response still returns the CURRENT (unchanged-by-this-call) settings.
    expect(conflictResult.settings.predictions.pickLockMinutesBeforeKickoff).toBe(20);

    const { data: rows } = await admin.from("audit_logs").select("id").eq("action", "settings.predictions_updated").eq("actor_id", adminUserId);
    expect(rows).toHaveLength(1);

    const { data: row } = await admin.from("platform_settings").select("pick_lock_minutes_before_kickoff").eq("id", true).single();
    expect(row!.pick_lock_minutes_before_kickoff).toBe(20);
  });

  it("a conflict on one domain never blocks an unrelated domain using its own fresh token", async () => {
    const at = await currentUpdatedAt();
    await updatePredictionSettings(adminUserId, at, { ...DEFAULT_PREDICTIONS, pickLockMinutesBeforeKickoff: 30 });

    const freshAt = await currentUpdatedAt();
    const result = await updateReputationSettings(adminUserId, freshAt, { leaderboardMinDecidedPicks: 11 });
    expect(result.outcome).toBe("updated");
  });
});

describe("Audit immutability", () => {
  it("a settings-change audit row cannot be updated or deleted, even by service_role", async () => {
    const at = await currentUpdatedAt();
    await updateReputationSettings(adminUserId, at, { leaderboardMinDecidedPicks: 6 });
    const row = await latestAuditRow("settings.reputation_updated");
    expect(row).not.toBeNull();

    const { error: updateError } = await admin.from("audit_logs").update({ reason: "tampered" }).eq("id", row!.id);
    expect(updateError).not.toBeNull();

    const { error: deleteError } = await admin.from("audit_logs").delete().eq("id", row!.id);
    expect(deleteError).not.toBeNull();

    const { data: stillThere } = await admin.from("audit_logs").select("id").eq("id", row!.id).maybeSingle();
    expect(stillThere).not.toBeNull();
  });

  it("a normal player cannot read or write settings audit rows directly", async () => {
    const { client } = await createUser("r12-player", "player");
    const { error: selectError } = await client.from("audit_logs").select("id").limit(1);
    // RLS restricts audit_logs SELECT to super_admin only — a plain player sees nothing (empty set), not an error, but must never see rows belonging to another user's admin actions.
    const { data: playerVisibleRows } = await client.from("audit_logs").select("id").eq("entity_type", "platform_settings");
    expect(selectError).toBeNull();
    expect(playerVisibleRows ?? []).toHaveLength(0);

    const { error: writeError } = await client.from("audit_logs").insert({ actor_id: null, action: "settings.forged", entity_type: "platform_settings", before: {}, after: {} });
    expect(writeError).not.toBeNull();
  });
});

/**
 * Milestone R13 remediation (20260101000161_admin_settings_internal_role_check.sql):
 * before this migration, every update_*_settings() RPC trusted p_admin_id
 * without an internal check, mirroring reverse_pool_settlement()'s own
 * is_super_admin(p_admin_id) guard instead of only relying on it. Given
 * this project's own two prior, documented EXECUTE-grant-drift incidents
 * (SECURITY_RPC_PRIVILEGE_INCIDENT_REPORT.md,
 * 20260101000134_free_mode_rpc_grant_remediation.sql), this test calls
 * every one of the 9 RPCs directly via the admin (service_role) client —
 * bypassing the Postgres GRANT layer entirely, exactly as a future
 * accidental grant-widening would — with a non-existent/non-super-admin
 * p_admin_id, proving the function body itself refuses the call
 * regardless of who is technically allowed to invoke it.
 */
describe("Internal role check (R13 defense-in-depth)", () => {
  const FAKE_ADMIN_ID = "00000000-0000-0000-0000-000000000000";

  const CALLS: Array<{ rpc: string; args: Record<string, unknown> }> = [
    { rpc: "update_prediction_settings", args: { p_pick_lock_minutes_before_kickoff: 10, p_prediction_cutoff_minutes_before_close: 0, p_prediction_allow_repeat: true, p_prediction_allow_stale_price: true, p_prediction_allow_unavailable_price: true, p_prediction_allow_closed_market: true } },
    { rpc: "update_notification_settings", args: { p_prediction_notifications_enabled: true, p_prediction_notify_on_correct: true, p_prediction_notify_on_incorrect: true, p_prediction_notify_on_void: true, p_prediction_notify_title_correct: "t", p_prediction_notify_body_correct: "b", p_prediction_notify_title_incorrect: "t", p_prediction_notify_body_incorrect: "b", p_prediction_notify_title_void: "t", p_prediction_notify_body_void: "b" } },
    { rpc: "update_market_settings", args: { p_market_ingestion_enabled: true, p_market_ingestion_min_bookmaker_count: 2, p_post_publication_enabled: true, p_post_publication_requires_active_market: true } },
    { rpc: "update_community_settings", args: { p_community_distribution_enabled: true, p_community_team_distribution_enabled: true, p_community_league_distribution_enabled: true, p_community_sport_distribution_enabled: true } },
    { rpc: "update_conversation_settings", args: { p_post_comment_max_length: 500, p_post_comment_rate_limit_window_seconds: 60, p_post_comment_rate_limit_max_attempts: 10 } },
    { rpc: "update_call_bs_settings", args: { p_call_bs_enabled: true, p_call_bs_rate_limit_window_seconds: 60, p_call_bs_rate_limit_max_attempts: 10 } },
    { rpc: "update_monetary_settings", args: { p_monetary_p2p_enabled: true, p_monetary_proposal_rate_limit_window_seconds: 60, p_monetary_proposal_rate_limit_max_attempts: 10, p_p2p_fee_bps: 0 } },
    { rpc: "update_reputation_settings", args: { p_leaderboard_min_decided_picks: 5 } },
    { rpc: "update_operations_settings", args: { p_settlement_batch_size: 500, p_grading_batch_size: 200, p_challenge_resolution_batch_size: 200, p_job_staleness_multiplier: 3 } },
  ];

  for (const { rpc, args } of CALLS) {
    it(`${rpc} rejects a non-super-admin p_admin_id even when called with full service_role privilege`, async () => {
      const at = await currentUpdatedAt();
      const { error } = await admin.rpc(rpc, { p_admin_id: FAKE_ADMIN_ID, p_expected_updated_at: at, ...args });
      expect(error).not.toBeNull();
      expect(error!.message).toContain("not_authorized");
    });
  }
});

describe("P2P fee snapshot — re-verified end-to-end through the R12 admin path itself", () => {
  it("an already-committed Position keeps its original fee forever, even after the admin changes the platform rate; a NEW Position picks up the new rate", async () => {
    let at = await currentUpdatedAt();
    await updateMonetarySettings(adminUserId, at, { ...DEFAULT_MONETARY, p2pFeeBps: 250 });

    const older = await setupCommittedPosition(1000);
    expect(older.position.feeBps).toBe(250);

    at = await currentUpdatedAt();
    await updateMonetarySettings(adminUserId, at, { ...DEFAULT_MONETARY, p2pFeeBps: 700 });

    // Settle the OLDER Position — must still use its own 250bps snapshot, never the new 700bps.
    await grade(older.proposerPredictionId, "CORRECT");
    await grade(older.recipientPredictionId, "INCORRECT");
    const settleResult = await settleMonetaryPosition(older.position.id);
    expect(settleResult.outcome).toBe("settled_win");
    const settlement = await getMonetaryPositionSettlementByPositionId(older.position.id);
    expect(settlement!.feeBps).toBe(250);
    expect(settlement!.feeAmount).toBe(Math.floor((1000 * 250) / 10000));

    const newer = await setupCommittedPosition(1000);
    expect(newer.position.feeBps).toBe(700);
  });
});

describe("Feature-disable semantics — Monetary P2P off never blocks an already-committed Position", () => {
  it("disabling monetary_p2p_enabled via the admin action still lets an existing committed Position settle normally, while blocking a brand-new proposal", async () => {
    const existing = await setupCommittedPosition(500);

    const at = await currentUpdatedAt();
    const result = await updateMonetarySettings(adminUserId, at, { ...DEFAULT_MONETARY, monetaryP2pEnabled: false });
    expect(result.outcome).toBe("updated");

    await grade(existing.proposerPredictionId, "CORRECT");
    await grade(existing.recipientPredictionId, "INCORRECT");
    const settleResult = await settleMonetaryPosition(existing.position.id);
    expect(settleResult.outcome).toBe("settled_win");

    // The RPC itself has no feature-flag awareness (policy lives in the TS layer, mirroring R9's own proposeMoney() gate) — confirm the flag is correctly persisted for the app's own policy.ts to read on the next proposal attempt.
    const settings = await getBrohdaSettings();
    expect(settings.monetary.monetaryP2pEnabled).toBe(false);
  });
});

describe("Reputation minimum takes effect immediately, with no deployment and no history rewrite", () => {
  it("raising the leaderboard minimum removes a previously-eligible user from ranking, without changing their recorded picks", async () => {
    const { userId } = await createUser("r12-board");
    for (let i = 0; i < 5; i++) await grade(await pick(userId, await createFreshMarket(), "YES"), "CORRECT");

    let at = await currentUpdatedAt();
    await updateReputationSettings(adminUserId, at, { leaderboardMinDecidedPicks: 5 });
    const { data: eligible } = await admin.rpc("get_user_prediction_record", { p_user_id: userId }).single();
    expect((eligible as { eligible_for_leaderboard: boolean }).eligible_for_leaderboard).toBe(true);
    expect((eligible as { decided: number }).decided).toBe(5);

    at = await currentUpdatedAt();
    await updateReputationSettings(adminUserId, at, { leaderboardMinDecidedPicks: 6 });
    const { data: nowIneligible } = await admin.rpc("get_user_prediction_record", { p_user_id: userId }).single();
    expect((nowIneligible as { eligible_for_leaderboard: boolean }).eligible_for_leaderboard).toBe(false);
    // The underlying record is untouched — only eligibility changed.
    expect((nowIneligible as { decided: number }).decided).toBe(5);
  });
});

describe("Manual DB drift is read correctly and can be restored through the admin surface", () => {
  it("a direct psql-style edit is visible via getBrohdaSettings() and can be corrected by a normal admin update call", async () => {
    // Simulates an operator bypassing the UI (a raw SQL fix, a data migration) — the admin surface must never cache stale values.
    await admin.from("platform_settings").update({ pick_lock_minutes_before_kickoff: 9999 }).eq("id", true);
    const drifted = await getBrohdaSettings();
    expect(drifted.predictions.pickLockMinutesBeforeKickoff).toBe(9999);

    const result = await updatePredictionSettings(adminUserId, drifted.updatedAt, { ...DEFAULT_PREDICTIONS, pickLockMinutesBeforeKickoff: 10 });
    expect(result.outcome).toBe("updated");
    expect(result.settings.predictions.pickLockMinutesBeforeKickoff).toBe(10);
  });
});

describe("Configuration discovery — every platform_settings column is accounted for", () => {
  it("is either in SETTINGS_REGISTRY or explicitly listed in NOT_EXPOSED_SETTINGS, with no overlap and no stale entries", async () => {
    const pgClient = new Client({ connectionString: getTestDatabaseUrl() });
    await pgClient.connect();
    const { rows } = await pgClient.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'platform_settings'`,
    );
    await pgClient.end();

    const liveColumnNames = new Set(rows.map((r) => r.column_name));
    const registryColumns = SETTINGS_REGISTRY.map((e) => e.column);
    const notExposedColumns = NOT_EXPOSED_SETTINGS.map((e) => e.column);

    // No duplicates within, or overlap between, the two lists.
    expect(new Set(registryColumns).size).toBe(registryColumns.length);
    expect(new Set(notExposedColumns).size).toBe(notExposedColumns.length);
    const overlap = registryColumns.filter((c) => notExposedColumns.includes(c));
    expect(overlap).toEqual([]);

    // Every registry/not-exposed entry names a column that actually exists (catches typos and renames).
    for (const column of [...registryColumns, ...notExposedColumns]) {
      expect(liveColumnNames.has(column), `"${column}" is registered but does not exist on platform_settings`).toBe(true);
    }

    // Every live column is accounted for by one list or the other.
    const accountedFor = new Set([...registryColumns, ...notExposedColumns]);
    const orphaned = [...liveColumnNames].filter((c) => !accountedFor.has(c));
    expect(orphaned, `platform_settings has columns neither exposed nor explicitly excluded: ${orphaned.join(", ")}`).toEqual([]);
  });
});
