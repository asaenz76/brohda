// Brohda Prediction domain (Milestone 3, docs/PRODUCT_TRANSFORMATION_ROADMAP.md).
// A Brohda Prediction is a permanent social/history/reputation record of
// what a user believed about a market at a specific moment. It is NOT an
// Order, Trade, Position, wallet transaction, or financial exposure — see
// docs/architecture/prediction-layer.md for the full domain distinction.
//
// This file defines the domain's own shape only. It never imports from
// lib/prediction-markets/providers/ — nothing provider-specific may leak
// into this domain (roadmap §2, restated for Prediction specifically in
// docs/architecture/prediction-layer.md).

/** The user's belief. A closed, two-outcome set — a true domain invariant, not policy. */
export type PredictionOutcome = "YES" | "NO";

/**
 * Lifecycle state, distinct from both the user's selected outcome and the
 * eventual resolved outcome. A Prediction is PENDING from creation until
 * the grading job authoritatively resolves it — see
 * docs/architecture/prediction-layer.md §7-8.
 */
export type PredictionLifecycleState = "PENDING" | "GRADED";

/**
 * Correctness, computed once at grading time and stored — never re-derived
 * on read, so a later provider correction can never silently change a
 * user's history (docs/architecture/prediction-layer.md's correction/
 * reversal limitations). VOID means the market never reached a trustworthy
 * resolution (e.g. it was archived before resolving) — genuinely necessary,
 * not a default: see lib/predictions/grading.ts.
 */
export type PredictionResult = "CORRECT" | "INCORRECT" | "VOID";

/** Brohda's own provider-neutral consumer market status, snapshotted at prediction time. */
export type PredictionMarketStatusSnapshot = "ACTIVE" | "CLOSED" | "RESOLVED";

/**
 * The full domain record. Fields marked immutable below are never written
 * to after creation by any code path in this codebase — enforced by
 * convention (no Server Action ever updates them) and by RLS (no
 * `authenticated` UPDATE policy exists on `predictions` at all).
 */
export interface Prediction {
  id: string;
  userId: string;
  /** Soft reference to markets.id — see lib/predictions/repository.ts. Immutable. */
  marketId: string;

  /** Immutable. */
  selectedOutcome: PredictionOutcome;
  /** Immutable. 0-1 range, independently captured — never derived from the other. */
  yesProbabilitySnapshot: number;
  /** Immutable. */
  noProbabilitySnapshot: number;
  /** Immutable. */
  marketQuestionSnapshot: string;
  /** Immutable. */
  marketCloseAtSnapshot: string | null;
  /** Immutable. */
  marketStatusSnapshot: PredictionMarketStatusSnapshot;

  lifecycleState: PredictionLifecycleState;
  result: PredictionResult | null;
  resolvedOutcomeSnapshot: PredictionOutcome | null;
  gradedAt: string | null;

  createdAt: string;
  updatedAt: string;
}

/**
 * The configurable policy governing prediction eligibility (roadmap-adjacent
 * decisions made explicitly in this milestone, not hard-coded — see
 * docs/architecture/prediction-layer.md §9-11). Read from
 * `platform_settings` by lib/predictions/policy.ts's getPredictionPolicy().
 */
export interface PredictionPolicy {
  allowRepeat: boolean;
  cutoffMinutesBeforeClose: number;
  allowStalePrice: boolean;
  allowUnavailablePrice: boolean;
  allowClosedMarket: boolean;
}

/** Why a prediction attempt was rejected, for user-facing copy — never a raw exception message. */
export type PredictionIneligibleReason =
  | "MARKET_NOT_FOUND"
  | "MARKET_RESOLVED"
  | "MARKET_CLOSED"
  | "MARKET_INACTIVE"
  | "PRICE_UNAVAILABLE"
  | "PRICE_STALE"
  | "PAST_CUTOFF"
  | "ALREADY_PREDICTED";

export type PredictionEligibility = { eligible: true } | { eligible: false; reason: PredictionIneligibleReason };

/**
 * The configurable policy governing whether/which grading results send a
 * `prediction_graded` notification (Milestone 3 final standing-rule
 * remediation). Read from `platform_settings` by
 * lib/predictions/policy.ts's getPredictionNotificationPolicy(). Unlike
 * `PredictionPolicy` above (eligibility, which fails OPEN), this fails
 * CLOSED when unreadable — see that function's own comment for why.
 */
export interface PredictionNotificationPolicy {
  enabled: boolean;
  notifyOnCorrect: boolean;
  notifyOnIncorrect: boolean;
  notifyOnVoid: boolean;
}

/** A single title/body template pair. `{{question}}` is a plain literal placeholder — never evaluated as code. */
export interface PredictionNotificationCopyTemplate {
  title: string;
  body: string;
}

/**
 * The configurable `prediction_graded` notification wording, one template
 * per grading result. Read from `platform_settings` by
 * lib/predictions/policy.ts's getPredictionNotificationCopyPolicy(). Plain
 * text substitution only (§ lib/notifications/predictions.ts's
 * renderNotificationCopy) — not a template-expression language, not a CMS.
 */
export interface PredictionNotificationCopyPolicy {
  correct: PredictionNotificationCopyTemplate;
  incorrect: PredictionNotificationCopyTemplate;
  void: PredictionNotificationCopyTemplate;
}
