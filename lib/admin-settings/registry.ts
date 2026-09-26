// Milestone R12 §79: one typed, application-level registry describing
// every Brohda 2.0 setting this milestone exposes through the admin UI —
// domain, field, operator-facing label/description, type, and (where the
// change's timing semantics aren't obvious) an impact note. This drives
// PRESENTATION only. It is explicitly NOT the security boundary — every
// mutation still goes through its own `requireSuperAdmin()`-gated Server
// Action calling its own explicitly-typed RPC (lib/actions/brohda-settings.ts,
// supabase/migrations/20260101000159_admin_brohda_settings.sql). Deleting
// an entry from this file would only break the UI's own labels, never
// widen what a client can write.
//
// §78's "configuration discovery" requirement — reducing the chance a
// future `platform_settings` column is added but forgotten here — is
// satisfied by `tests/integration/admin-brohda-settings.test.ts`'s own
// "every platform_settings column is either registered or explicitly
// listed as not-exposed" test, which queries the live schema directly
// rather than relying on this file alone.

export type SettingType = "boolean" | "integer" | "basis-points" | "text";

export interface SettingRegistryEntry {
  domain: string;
  key: string;
  /** The exact `platform_settings` column this field reads/writes. */
  column: string;
  label: string;
  description: string;
  type: SettingType;
  /** Only present when a change's effective timing is non-obvious (§17, §49) — e.g. financial snapshot semantics. */
  impactNote?: string;
}

export const SETTINGS_REGISTRY: SettingRegistryEntry[] = [
  // Predictions
  {
    domain: "Predictions",
    key: "pickLockMinutesBeforeKickoff",
    column: "pick_lock_minutes_before_kickoff",
    label: "Pick lock",
    description: "Players may change their Pick until this many minutes before scheduled kickoff.",
    type: "integer",
  },
  {
    domain: "Predictions",
    key: "predictionCutoffMinutesBeforeClose",
    column: "prediction_cutoff_minutes_before_close",
    label: "Prediction cutoff before market close",
    description: "A new prediction may not be made within this many minutes of the Market's own close time. 0 means no separate cutoff beyond the Market's own state.",
    type: "integer",
  },
  {
    domain: "Predictions",
    key: "predictionAllowRepeat",
    column: "prediction_allow_repeat",
    label: "Allow repeat predictions",
    description: "Whether a user may submit more than one Pick on the same Market over time (distinct from R5 Pick editing, which always replaces the current Pick).",
    type: "boolean",
  },
  {
    domain: "Predictions",
    key: "predictionAllowStalePrice",
    column: "prediction_allow_stale_price",
    label: "Allow predicting on a stale price",
    description: "Whether a Pick may be made when the displayed price is stale (not fresh, but not entirely unavailable).",
    type: "boolean",
  },
  {
    domain: "Predictions",
    key: "predictionAllowUnavailablePrice",
    column: "prediction_allow_unavailable_price",
    label: "Allow predicting with no price",
    description: "Whether a Pick may be made when no usable price is available at all for the Market.",
    type: "boolean",
  },
  {
    domain: "Predictions",
    key: "predictionAllowClosedMarket",
    column: "prediction_allow_closed_market",
    label: "Allow predicting on a closed Market",
    description: "Whether a Pick may be made after the Market has closed (a RESOLVED Market is never predictable regardless of this setting — that is a true invariant, not policy).",
    type: "boolean",
  },

  // Notifications
  {
    domain: "Notifications",
    key: "predictionNotificationsEnabled",
    column: "prediction_notifications_enabled",
    label: "Send grading notifications",
    description: "Master switch for the \"your prediction was graded\" notification. Grading itself always happens regardless of this setting — this only controls the optional notification.",
    type: "boolean",
  },
  {
    domain: "Notifications",
    key: "predictionNotifyOnCorrect",
    column: "prediction_notify_on_correct",
    label: "Notify on correct",
    description: "Send a notification when a Pick grades CORRECT.",
    type: "boolean",
  },
  {
    domain: "Notifications",
    key: "predictionNotifyOnIncorrect",
    column: "prediction_notify_on_incorrect",
    label: "Notify on incorrect",
    description: "Send a notification when a Pick grades INCORRECT.",
    type: "boolean",
  },
  {
    domain: "Notifications",
    key: "predictionNotifyOnVoid",
    column: "prediction_notify_on_void",
    label: "Notify on void",
    description: "Send a notification when a Pick grades VOID.",
    type: "boolean",
  },
  {
    domain: "Notifications",
    key: "predictionNotifyTitleCorrect",
    column: "prediction_notify_title_correct",
    label: "Correct — title",
    description: "Notification title sent when a Pick grades CORRECT. Supports the {{question}} placeholder.",
    type: "text",
  },
  {
    domain: "Notifications",
    key: "predictionNotifyBodyCorrect",
    column: "prediction_notify_body_correct",
    label: "Correct — body",
    description: "Notification body sent when a Pick grades CORRECT. Supports the {{question}} placeholder.",
    type: "text",
  },
  {
    domain: "Notifications",
    key: "predictionNotifyTitleIncorrect",
    column: "prediction_notify_title_incorrect",
    label: "Incorrect — title",
    description: "Notification title sent when a Pick grades INCORRECT. Supports the {{question}} placeholder.",
    type: "text",
  },
  {
    domain: "Notifications",
    key: "predictionNotifyBodyIncorrect",
    column: "prediction_notify_body_incorrect",
    label: "Incorrect — body",
    description: "Notification body sent when a Pick grades INCORRECT. Supports the {{question}} placeholder.",
    type: "text",
  },
  {
    domain: "Notifications",
    key: "predictionNotifyTitleVoid",
    column: "prediction_notify_title_void",
    label: "Void — title",
    description: "Notification title sent when a Pick grades VOID. Supports the {{question}} placeholder.",
    type: "text",
  },
  {
    domain: "Notifications",
    key: "predictionNotifyBodyVoid",
    column: "prediction_notify_body_void",
    label: "Void — body",
    description: "Notification body sent when a Pick grades VOID. Supports the {{question}} placeholder.",
    type: "text",
  },

  // Markets
  {
    domain: "Markets",
    key: "marketIngestionEnabled",
    column: "market_ingestion_enabled",
    label: "Market ingestion",
    description: "Master switch for automatically ingesting new sports Markets from the configured provider.",
    type: "boolean",
  },
  {
    domain: "Markets",
    key: "marketIngestionMinBookmakerCount",
    column: "market_ingestion_min_bookmaker_count",
    label: "Minimum bookmaker count",
    description: "A proposition must be quoted by at least this many independent bookmakers before it is ingested as a Market.",
    type: "integer",
  },
  {
    domain: "Markets",
    key: "postPublicationEnabled",
    column: "post_publication_enabled",
    label: "Post publication",
    description: "Master switch for automatically publishing a Post once its underlying Market/Game is ready.",
    type: "boolean",
  },
  {
    domain: "Markets",
    key: "postPublicationRequiresActiveMarket",
    column: "post_publication_requires_active_market",
    label: "Require an active Market to publish",
    description: "Whether a Post may only publish once it has at least one ACTIVE Market.",
    type: "boolean",
  },
  {
    domain: "Markets",
    key: "socialPredictionEnabled",
    column: "social_prediction_enabled",
    label: "Social prediction access",
    description: "Master switch controlling whether ordinary users can reach the Brohda 2.0 social prediction experience (Markets, Posts, Communities, Picks). Independent of the content-preparation flags above — Super Admin/Admin always retain preview access regardless of this setting.",
    type: "boolean",
    impactNote: "This is the DEPLOY vs ACTIVATE boundary — content can be ingested/published/distributed while this stays off. Takes effect immediately for ordinary users; no deployment needed.",
  },
  {
    domain: "Markets",
    key: "feedCompletedGameRetentionHours",
    column: "feed_completed_game_retention_hours",
    label: "Feed retention for completed games (hours)",
    description: "How long a finished game's Post stays visible in the discovery feed (lib/communities/feed.ts) before dropping out. Never affects grading, reputation, or notifications — those are keyed off Prediction lifecycle state, not this.",
    type: "integer",
  },

  // Communities
  {
    domain: "Communities",
    key: "communityDistributionEnabled",
    column: "community_distribution_enabled",
    label: "Community distribution",
    description: "Master switch for automatically distributing a Post into its relevant Communities. Disabling this never deletes or rewrites existing Post/Community relationships — it only stops new distribution.",
    type: "boolean",
  },
  {
    domain: "Communities",
    key: "communityTeamDistributionEnabled",
    column: "community_team_distribution_enabled",
    label: "Team Communities",
    description: "Whether new Posts distribute into TEAM Communities specifically (only relevant while distribution overall is enabled).",
    type: "boolean",
  },
  {
    domain: "Communities",
    key: "communityLeagueDistributionEnabled",
    column: "community_league_distribution_enabled",
    label: "League Communities",
    description: "Whether new Posts distribute into LEAGUE Communities specifically.",
    type: "boolean",
  },
  {
    domain: "Communities",
    key: "communitySportDistributionEnabled",
    column: "community_sport_distribution_enabled",
    label: "Sport Communities",
    description: "Whether new Posts distribute into SPORT Communities specifically.",
    type: "boolean",
  },

  // Conversation
  {
    domain: "Conversation",
    key: "postCommentMaxLength",
    column: "post_comment_max_length",
    label: "Max comment length",
    description: "Maximum characters allowed in a Post comment. Capped at 2000 by an unconditional database limit regardless of this setting.",
    type: "integer",
  },
  {
    domain: "Conversation",
    key: "postCommentRateLimitWindowSeconds",
    column: "post_comment_rate_limit_window_seconds",
    label: "Comment rate-limit window",
    description: "The time window, in seconds, over which the comment-posting attempt cap below applies.",
    type: "integer",
  },
  {
    domain: "Conversation",
    key: "postCommentRateLimitMaxAttempts",
    column: "post_comment_rate_limit_max_attempts",
    label: "Comment rate-limit attempts",
    description: "Maximum comments a single user may post within the configured window.",
    type: "integer",
  },

  // Call BS
  {
    domain: "Call BS",
    key: "callBsEnabled",
    column: "call_bs_enabled",
    label: "Call BS",
    description: "Master switch for creating new free Call BS Challenges. Does not affect an already-PENDING/ACCEPTED Challenge's own lifecycle if later disabled.",
    type: "boolean",
  },
  {
    domain: "Call BS",
    key: "callBsRateLimitWindowSeconds",
    column: "call_bs_rate_limit_window_seconds",
    label: "Call BS rate-limit window",
    description: "The time window, in seconds, over which the Call BS creation attempt cap below applies.",
    type: "integer",
  },
  {
    domain: "Call BS",
    key: "callBsRateLimitMaxAttempts",
    column: "call_bs_rate_limit_max_attempts",
    label: "Call BS rate-limit attempts",
    description: "Maximum Call BS Challenges a single user may create within the configured window.",
    type: "integer",
  },

  // Monetary P2P
  {
    domain: "Monetary P2P",
    key: "monetaryP2pEnabled",
    column: "monetary_p2p_enabled",
    label: "Monetary P2P",
    description: "Master switch for creating new monetary proposals and accepting them into committed Positions.",
    type: "boolean",
    impactNote: "Turning this off blocks new proposals and new acceptances only. It never blocks settlement of an already-committed Position, and never releases or freezes an existing reservation — committed financial obligations are always honored.",
  },
  {
    domain: "Monetary P2P",
    key: "monetaryProposalRateLimitWindowSeconds",
    column: "monetary_proposal_rate_limit_window_seconds",
    label: "Proposal rate-limit window",
    description: "The time window, in seconds, over which the monetary-proposal creation attempt cap below applies.",
    type: "integer",
  },
  {
    domain: "Monetary P2P",
    key: "monetaryProposalRateLimitMaxAttempts",
    column: "monetary_proposal_rate_limit_max_attempts",
    label: "Proposal rate-limit attempts",
    description: "Maximum monetary proposals a single user may create within the configured window.",
    type: "integer",
  },
  {
    domain: "Monetary P2P",
    key: "p2pFeeBps",
    column: "p2p_fee_bps",
    label: "P2P settlement fee",
    description: "The percentage of the losing stake Brohda keeps when a monetary Position settles with a winner. 0% by default — no fee is charged today.",
    type: "basis-points",
    impactNote: "Applies only to Positions committed AFTER this change. An already-committed Position keeps the exact fee rate that was in effect the moment it was accepted, forever — this change is never retroactive.",
  },

  // Reputation
  {
    domain: "Reputation",
    key: "leaderboardMinDecidedPicks",
    column: "leaderboard_min_decided_picks",
    label: "Leaderboard minimum sample",
    description: "Minimum number of decided (correct + incorrect) graded Picks a user must have before appearing in the Prediction Leaderboard.",
    type: "integer",
    impactNote: "Takes effect immediately for ranking eligibility. Never changes anyone's actual prediction history, and never requires a deployment.",
  },

  // Operations
  {
    domain: "Operations",
    key: "settlementBatchSize",
    column: "settlement_batch_size",
    label: "Settlement batch size",
    description: "Maximum number of committed Positions the settlement runner processes in one invocation.",
    type: "integer",
    impactNote: "A pure operational throughput knob — never affects settlement correctness, only how much work one run does.",
  },
  {
    domain: "Operations",
    key: "gradingBatchSize",
    column: "grading_batch_size",
    label: "Grading batch size",
    description: "Maximum number of pending Predictions the grading runner processes in one invocation.",
    type: "integer",
    impactNote: "A pure operational throughput knob — never affects grading correctness, only how much work one run does.",
  },
  {
    domain: "Operations",
    key: "challengeResolutionBatchSize",
    column: "challenge_resolution_batch_size",
    label: "Challenge resolution batch size",
    description: "Maximum number of accepted Call BS Challenges the resolution runner processes in one invocation.",
    type: "integer",
    impactNote: "A pure operational throughput knob — never affects resolution correctness, only how much work one run does.",
  },
  {
    domain: "Operations",
    key: "jobStalenessMultiplier",
    column: "job_staleness_multiplier",
    label: "Job staleness tolerance",
    description: "Multiplier applied to each lifecycle job's own expected cadence before the admin Job Health view flags it as stale.",
    type: "integer",
    impactNote: "A pure alerting-sensitivity knob — never affects any job's own scheduling, execution, or correctness.",
  },
];

/**
 * Every `platform_settings` column that exists today but is deliberately
 * NOT exposed through this milestone's admin UI, with the reason —
 * §80's own explicit requirement that this list is as important as what
 * IS exposed. Checked directly against the live schema by
 * `tests/integration/admin-brohda-settings.test.ts`'s own discovery test
 * (§78) so a future column can't silently fall through both lists
 * unnoticed.
 */
export const NOT_EXPOSED_SETTINGS: Array<{ column: string; reason: string }> = [
  { column: "id", reason: "Singleton primary key, not a setting." },
  { column: "updated_at", reason: "Derived/audit metadata — the optimistic-concurrency token itself, not a setting." },
  { column: "updated_by", reason: "Derived/audit metadata." },
  { column: "registration_enabled", reason: "Pre-existing legacy setting, already exposed on the existing /admin/settings page — out of this milestone's own Brohda 2.0 scope." },
  { column: "default_entry_fee_cents", reason: "Legacy pool setting, already exposed on the existing /admin/settings page." },
  { column: "default_house_fee_bps", reason: "Legacy pool setting, already exposed on the existing /admin/settings page." },
  { column: "default_tier_entry_fees_cents", reason: "Legacy pool setting, already exposed on the existing /admin/settings page." },
  { column: "paid_pools_enabled", reason: "Legacy pool setting, already exposed on the existing /admin/settings page." },
  { column: "free_pools_enabled", reason: "Legacy pool setting, already exposed on the existing /admin/settings page." },
  { column: "discovery_fresh_within_minutes", reason: "Pre-existing Milestone 2 discovery-freshness policy, orthogonal to the R1-R11 domains this milestone's own task text enumerates; no existing admin UI exposes it today either — deferred rather than expanding scope without an explicit product ask." },
  { column: "discovery_stale_within_minutes", reason: "Same as discovery_fresh_within_minutes." },
  { column: "post_primary_market_template_priority", reason: "A display-ordering array over the fixed MONEYLINE/SPREAD/TOTAL set, not an enable/disable policy. No operator-control signal exists for reordering it; the underlying template set itself is a hard-coded technical capability (a Postgres enum), not configurable at all." },
];
