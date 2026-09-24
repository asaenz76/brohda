// Milestone R12 (docs/BROHDA_2_0_MILESTONE_MAP.md, Admin + Configuration).
// Typed shapes for the 9 Brohda 2.0 settings domains this milestone
// exposes through an admin surface. Every field here maps 1:1 to an
// existing `platform_settings` column (plus the one new
// `settlement_batch_size` column this milestone adds) — see
// docs/architecture/admin-configuration.md for the full catalog,
// including everything deliberately NOT exposed here.

export interface PredictionSettings {
  pickLockMinutesBeforeKickoff: number;
  predictionCutoffMinutesBeforeClose: number;
  predictionAllowRepeat: boolean;
  predictionAllowStalePrice: boolean;
  predictionAllowUnavailablePrice: boolean;
  predictionAllowClosedMarket: boolean;
}

export interface NotificationSettings {
  predictionNotificationsEnabled: boolean;
  predictionNotifyOnCorrect: boolean;
  predictionNotifyOnIncorrect: boolean;
  predictionNotifyOnVoid: boolean;
  predictionNotifyTitleCorrect: string;
  predictionNotifyBodyCorrect: string;
  predictionNotifyTitleIncorrect: string;
  predictionNotifyBodyIncorrect: string;
  predictionNotifyTitleVoid: string;
  predictionNotifyBodyVoid: string;
}

export interface MarketSettings {
  marketIngestionEnabled: boolean;
  marketIngestionMinBookmakerCount: number;
  postPublicationEnabled: boolean;
  postPublicationRequiresActiveMarket: boolean;
  /** Milestone R13.10 — gates ordinary-user access to the Brohda 2.0 social prediction routes, independent of the three content-preparation flags above. See lib/social/access.ts. */
  socialPredictionEnabled: boolean;
}

export interface CommunitySettings {
  communityDistributionEnabled: boolean;
  communityTeamDistributionEnabled: boolean;
  communityLeagueDistributionEnabled: boolean;
  communitySportDistributionEnabled: boolean;
}

export interface ConversationSettings {
  postCommentMaxLength: number;
  postCommentRateLimitWindowSeconds: number;
  postCommentRateLimitMaxAttempts: number;
}

export interface CallBsSettings {
  callBsEnabled: boolean;
  callBsRateLimitWindowSeconds: number;
  callBsRateLimitMaxAttempts: number;
}

export interface MonetarySettings {
  monetaryP2pEnabled: boolean;
  monetaryProposalRateLimitWindowSeconds: number;
  monetaryProposalRateLimitMaxAttempts: number;
  /** Basis points, 0-10000. Snapshotted onto monetary_positions.fee_bps at acceptance time — changing this NEVER alters an already-committed Position (see docs/architecture/p2p-settlement.md and this milestone's own dedicated test). */
  p2pFeeBps: number;
}

export interface ReputationSettings {
  leaderboardMinDecidedPicks: number;
}

export interface OperationsSettings {
  settlementBatchSize: number;
  /** Milestone R13.5 — max PENDING Predictions the grading runner considers per invocation. */
  gradingBatchSize: number;
  /** Milestone R13.5 — max ACCEPTED Call BS Challenges the resolution runner considers per invocation. */
  challengeResolutionBatchSize: number;
  /** Milestone R13.9 — multiplier applied to each lifecycle job's own expected cadence (lib/jobs/registry.ts) before the admin Job Health view calls it STALE. */
  jobStalenessMultiplier: number;
}

/** The full effective Brohda 2.0 settings snapshot, plus the concurrency token every domain's own update action must echo back. */
export interface BrohdaSettings {
  predictions: PredictionSettings;
  notifications: NotificationSettings;
  markets: MarketSettings;
  communities: CommunitySettings;
  conversation: ConversationSettings;
  callBs: CallBsSettings;
  monetary: MonetarySettings;
  reputation: ReputationSettings;
  operations: OperationsSettings;
  /** Optimistic-concurrency token (platform_settings.updated_at) — every domain update action must echo the value it read back, or receive a `conflict` outcome instead of silently overwriting a newer change (§42, §74, §89). */
  updatedAt: string;
  updatedByDisplayName: string | null;
}

export type SettingsUpdateOutcome = "updated" | "conflict";

export interface SettingsUpdateResult {
  settings: BrohdaSettings;
  outcome: SettingsUpdateOutcome;
}
