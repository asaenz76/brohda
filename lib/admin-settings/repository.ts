import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  BrohdaSettings,
  PredictionSettings,
  NotificationSettings,
  MarketSettings,
  CommunitySettings,
  ConversationSettings,
  CallBsSettings,
  MonetarySettings,
  ReputationSettings,
  OperationsSettings,
  SettingsUpdateResult,
} from "./types";

// Milestone R12 — the sole read/write surface for the Brohda 2.0 admin
// settings domain. All nine mutation RPCs are `service_role`-only
// (see the migration's own grants) — every call here is made from
// within a Server Action that has ALREADY independently verified
// `requireSuperAdmin()` server-side; this file never trusts a caller's
// claimed identity, it only forwards the already-verified admin's id.

interface PlatformSettingsRow {
  pick_lock_minutes_before_kickoff: number;
  prediction_cutoff_minutes_before_close: number;
  prediction_allow_repeat: boolean;
  prediction_allow_stale_price: boolean;
  prediction_allow_unavailable_price: boolean;
  prediction_allow_closed_market: boolean;
  prediction_notifications_enabled: boolean;
  prediction_notify_on_correct: boolean;
  prediction_notify_on_incorrect: boolean;
  prediction_notify_on_void: boolean;
  prediction_notify_title_correct: string;
  prediction_notify_body_correct: string;
  prediction_notify_title_incorrect: string;
  prediction_notify_body_incorrect: string;
  prediction_notify_title_void: string;
  prediction_notify_body_void: string;
  market_ingestion_enabled: boolean;
  market_ingestion_min_bookmaker_count: number;
  post_publication_enabled: boolean;
  post_publication_requires_active_market: boolean;
  community_distribution_enabled: boolean;
  community_team_distribution_enabled: boolean;
  community_league_distribution_enabled: boolean;
  community_sport_distribution_enabled: boolean;
  post_comment_max_length: number;
  post_comment_rate_limit_window_seconds: number;
  post_comment_rate_limit_max_attempts: number;
  call_bs_enabled: boolean;
  call_bs_rate_limit_window_seconds: number;
  call_bs_rate_limit_max_attempts: number;
  monetary_p2p_enabled: boolean;
  monetary_proposal_rate_limit_window_seconds: number;
  monetary_proposal_rate_limit_max_attempts: number;
  p2p_fee_bps: number;
  leaderboard_min_decided_picks: number;
  settlement_batch_size: number;
  grading_batch_size: number;
  challenge_resolution_batch_size: number;
  job_staleness_multiplier: number;
  updated_at: string;
  updated_by: string | null;
}

function toPredictions(row: PlatformSettingsRow): PredictionSettings {
  return {
    pickLockMinutesBeforeKickoff: row.pick_lock_minutes_before_kickoff,
    predictionCutoffMinutesBeforeClose: row.prediction_cutoff_minutes_before_close,
    predictionAllowRepeat: row.prediction_allow_repeat,
    predictionAllowStalePrice: row.prediction_allow_stale_price,
    predictionAllowUnavailablePrice: row.prediction_allow_unavailable_price,
    predictionAllowClosedMarket: row.prediction_allow_closed_market,
  };
}

function toNotifications(row: PlatformSettingsRow): NotificationSettings {
  return {
    predictionNotificationsEnabled: row.prediction_notifications_enabled,
    predictionNotifyOnCorrect: row.prediction_notify_on_correct,
    predictionNotifyOnIncorrect: row.prediction_notify_on_incorrect,
    predictionNotifyOnVoid: row.prediction_notify_on_void,
    predictionNotifyTitleCorrect: row.prediction_notify_title_correct,
    predictionNotifyBodyCorrect: row.prediction_notify_body_correct,
    predictionNotifyTitleIncorrect: row.prediction_notify_title_incorrect,
    predictionNotifyBodyIncorrect: row.prediction_notify_body_incorrect,
    predictionNotifyTitleVoid: row.prediction_notify_title_void,
    predictionNotifyBodyVoid: row.prediction_notify_body_void,
  };
}

function toMarkets(row: PlatformSettingsRow): MarketSettings {
  return {
    marketIngestionEnabled: row.market_ingestion_enabled,
    marketIngestionMinBookmakerCount: row.market_ingestion_min_bookmaker_count,
    postPublicationEnabled: row.post_publication_enabled,
    postPublicationRequiresActiveMarket: row.post_publication_requires_active_market,
  };
}

function toCommunities(row: PlatformSettingsRow): CommunitySettings {
  return {
    communityDistributionEnabled: row.community_distribution_enabled,
    communityTeamDistributionEnabled: row.community_team_distribution_enabled,
    communityLeagueDistributionEnabled: row.community_league_distribution_enabled,
    communitySportDistributionEnabled: row.community_sport_distribution_enabled,
  };
}

function toConversation(row: PlatformSettingsRow): ConversationSettings {
  return {
    postCommentMaxLength: row.post_comment_max_length,
    postCommentRateLimitWindowSeconds: row.post_comment_rate_limit_window_seconds,
    postCommentRateLimitMaxAttempts: row.post_comment_rate_limit_max_attempts,
  };
}

function toCallBs(row: PlatformSettingsRow): CallBsSettings {
  return {
    callBsEnabled: row.call_bs_enabled,
    callBsRateLimitWindowSeconds: row.call_bs_rate_limit_window_seconds,
    callBsRateLimitMaxAttempts: row.call_bs_rate_limit_max_attempts,
  };
}

function toMonetary(row: PlatformSettingsRow): MonetarySettings {
  return {
    monetaryP2pEnabled: row.monetary_p2p_enabled,
    monetaryProposalRateLimitWindowSeconds: row.monetary_proposal_rate_limit_window_seconds,
    monetaryProposalRateLimitMaxAttempts: row.monetary_proposal_rate_limit_max_attempts,
    p2pFeeBps: row.p2p_fee_bps,
  };
}

function toReputation(row: PlatformSettingsRow): ReputationSettings {
  return { leaderboardMinDecidedPicks: row.leaderboard_min_decided_picks };
}

function toOperations(row: PlatformSettingsRow): OperationsSettings {
  return {
    settlementBatchSize: row.settlement_batch_size,
    gradingBatchSize: row.grading_batch_size,
    challengeResolutionBatchSize: row.challenge_resolution_batch_size,
    jobStalenessMultiplier: row.job_staleness_multiplier,
  };
}

async function toBrohdaSettings(row: PlatformSettingsRow): Promise<BrohdaSettings> {
  const admin = createAdminClient();
  let updatedByDisplayName: string | null = null;
  if (row.updated_by) {
    const { data } = await admin.from("user_profiles").select("display_name").eq("id", row.updated_by).maybeSingle();
    updatedByDisplayName = data?.display_name ?? null;
  }
  return {
    predictions: toPredictions(row),
    notifications: toNotifications(row),
    markets: toMarkets(row),
    communities: toCommunities(row),
    conversation: toConversation(row),
    callBs: toCallBs(row),
    monetary: toMonetary(row),
    reputation: toReputation(row),
    operations: toOperations(row),
    updatedAt: row.updated_at,
    updatedByDisplayName,
  };
}

const SETTINGS_COLUMNS =
  "pick_lock_minutes_before_kickoff, prediction_cutoff_minutes_before_close, prediction_allow_repeat, prediction_allow_stale_price, prediction_allow_unavailable_price, prediction_allow_closed_market, prediction_notifications_enabled, prediction_notify_on_correct, prediction_notify_on_incorrect, prediction_notify_on_void, prediction_notify_title_correct, prediction_notify_body_correct, prediction_notify_title_incorrect, prediction_notify_body_incorrect, prediction_notify_title_void, prediction_notify_body_void, market_ingestion_enabled, market_ingestion_min_bookmaker_count, post_publication_enabled, post_publication_requires_active_market, community_distribution_enabled, community_team_distribution_enabled, community_league_distribution_enabled, community_sport_distribution_enabled, post_comment_max_length, post_comment_rate_limit_window_seconds, post_comment_rate_limit_max_attempts, call_bs_enabled, call_bs_rate_limit_window_seconds, call_bs_rate_limit_max_attempts, monetary_p2p_enabled, monetary_proposal_rate_limit_window_seconds, monetary_proposal_rate_limit_max_attempts, p2p_fee_bps, leaderboard_min_decided_picks, settlement_batch_size, grading_batch_size, challenge_resolution_batch_size, job_staleness_multiplier, updated_at, updated_by";

/** The full effective Brohda 2.0 settings snapshot — the one place "what policy is Brohda using right now?" (§14) is answered, for both the admin UI and any test/script that needs it. */
export async function getBrohdaSettings(): Promise<BrohdaSettings> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("platform_settings").select(SETTINGS_COLUMNS).eq("id", true).single();
  if (error || !data) throw error ?? new Error("platform_settings row not found");
  return toBrohdaSettings(data as unknown as PlatformSettingsRow);
}

interface RpcRow {
  settings: PlatformSettingsRow;
  outcome: "updated" | "conflict";
}

async function toResult(row: RpcRow): Promise<SettingsUpdateResult> {
  return { settings: await toBrohdaSettings(row.settings), outcome: row.outcome };
}

export async function updatePredictionSettings(adminId: string, expectedUpdatedAt: string, values: PredictionSettings): Promise<SettingsUpdateResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("update_prediction_settings", {
      p_admin_id: adminId,
      p_expected_updated_at: expectedUpdatedAt,
      p_pick_lock_minutes_before_kickoff: values.pickLockMinutesBeforeKickoff,
      p_prediction_cutoff_minutes_before_close: values.predictionCutoffMinutesBeforeClose,
      p_prediction_allow_repeat: values.predictionAllowRepeat,
      p_prediction_allow_stale_price: values.predictionAllowStalePrice,
      p_prediction_allow_unavailable_price: values.predictionAllowUnavailablePrice,
      p_prediction_allow_closed_market: values.predictionAllowClosedMarket,
    })
    .single();
  if (error) throw error;
  return toResult(data as RpcRow);
}

export async function updateNotificationSettings(adminId: string, expectedUpdatedAt: string, values: NotificationSettings): Promise<SettingsUpdateResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("update_notification_settings", {
      p_admin_id: adminId,
      p_expected_updated_at: expectedUpdatedAt,
      p_prediction_notifications_enabled: values.predictionNotificationsEnabled,
      p_prediction_notify_on_correct: values.predictionNotifyOnCorrect,
      p_prediction_notify_on_incorrect: values.predictionNotifyOnIncorrect,
      p_prediction_notify_on_void: values.predictionNotifyOnVoid,
      p_prediction_notify_title_correct: values.predictionNotifyTitleCorrect,
      p_prediction_notify_body_correct: values.predictionNotifyBodyCorrect,
      p_prediction_notify_title_incorrect: values.predictionNotifyTitleIncorrect,
      p_prediction_notify_body_incorrect: values.predictionNotifyBodyIncorrect,
      p_prediction_notify_title_void: values.predictionNotifyTitleVoid,
      p_prediction_notify_body_void: values.predictionNotifyBodyVoid,
    })
    .single();
  if (error) throw error;
  return toResult(data as RpcRow);
}

export async function updateMarketSettings(adminId: string, expectedUpdatedAt: string, values: MarketSettings): Promise<SettingsUpdateResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("update_market_settings", {
      p_admin_id: adminId,
      p_expected_updated_at: expectedUpdatedAt,
      p_market_ingestion_enabled: values.marketIngestionEnabled,
      p_market_ingestion_min_bookmaker_count: values.marketIngestionMinBookmakerCount,
      p_post_publication_enabled: values.postPublicationEnabled,
      p_post_publication_requires_active_market: values.postPublicationRequiresActiveMarket,
    })
    .single();
  if (error) throw error;
  return toResult(data as RpcRow);
}

export async function updateCommunitySettings(adminId: string, expectedUpdatedAt: string, values: CommunitySettings): Promise<SettingsUpdateResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("update_community_settings", {
      p_admin_id: adminId,
      p_expected_updated_at: expectedUpdatedAt,
      p_community_distribution_enabled: values.communityDistributionEnabled,
      p_community_team_distribution_enabled: values.communityTeamDistributionEnabled,
      p_community_league_distribution_enabled: values.communityLeagueDistributionEnabled,
      p_community_sport_distribution_enabled: values.communitySportDistributionEnabled,
    })
    .single();
  if (error) throw error;
  return toResult(data as RpcRow);
}

export async function updateConversationSettings(adminId: string, expectedUpdatedAt: string, values: ConversationSettings): Promise<SettingsUpdateResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("update_conversation_settings", {
      p_admin_id: adminId,
      p_expected_updated_at: expectedUpdatedAt,
      p_post_comment_max_length: values.postCommentMaxLength,
      p_post_comment_rate_limit_window_seconds: values.postCommentRateLimitWindowSeconds,
      p_post_comment_rate_limit_max_attempts: values.postCommentRateLimitMaxAttempts,
    })
    .single();
  if (error) throw error;
  return toResult(data as RpcRow);
}

export async function updateCallBsSettings(adminId: string, expectedUpdatedAt: string, values: CallBsSettings): Promise<SettingsUpdateResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("update_call_bs_settings", {
      p_admin_id: adminId,
      p_expected_updated_at: expectedUpdatedAt,
      p_call_bs_enabled: values.callBsEnabled,
      p_call_bs_rate_limit_window_seconds: values.callBsRateLimitWindowSeconds,
      p_call_bs_rate_limit_max_attempts: values.callBsRateLimitMaxAttempts,
    })
    .single();
  if (error) throw error;
  return toResult(data as RpcRow);
}

export async function updateMonetarySettings(adminId: string, expectedUpdatedAt: string, values: MonetarySettings): Promise<SettingsUpdateResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("update_monetary_settings", {
      p_admin_id: adminId,
      p_expected_updated_at: expectedUpdatedAt,
      p_monetary_p2p_enabled: values.monetaryP2pEnabled,
      p_monetary_proposal_rate_limit_window_seconds: values.monetaryProposalRateLimitWindowSeconds,
      p_monetary_proposal_rate_limit_max_attempts: values.monetaryProposalRateLimitMaxAttempts,
      p_p2p_fee_bps: values.p2pFeeBps,
    })
    .single();
  if (error) throw error;
  return toResult(data as RpcRow);
}

export async function updateReputationSettings(adminId: string, expectedUpdatedAt: string, values: ReputationSettings): Promise<SettingsUpdateResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("update_reputation_settings", {
      p_admin_id: adminId,
      p_expected_updated_at: expectedUpdatedAt,
      p_leaderboard_min_decided_picks: values.leaderboardMinDecidedPicks,
    })
    .single();
  if (error) throw error;
  return toResult(data as RpcRow);
}

export async function updateOperationsSettings(adminId: string, expectedUpdatedAt: string, values: OperationsSettings): Promise<SettingsUpdateResult> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .rpc("update_operations_settings", {
      p_admin_id: adminId,
      p_expected_updated_at: expectedUpdatedAt,
      p_settlement_batch_size: values.settlementBatchSize,
      p_grading_batch_size: values.gradingBatchSize,
      p_challenge_resolution_batch_size: values.challengeResolutionBatchSize,
      p_job_staleness_multiplier: values.jobStalenessMultiplier,
    })
    .single();
  if (error) throw error;
  return toResult(data as RpcRow);
}
