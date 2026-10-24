import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ConsumerMarketStatus, Freshness } from "@/lib/prediction-markets/discovery/types";
import { parseMarketPolicy } from "@/lib/prediction-markets/market-policy-parse";
import type {
  PickLockPolicy,
  PredictionEligibility,
  PredictionNotificationCopyPolicy,
  PredictionNotificationPolicy,
  PredictionPolicy,
  PredictionResult,
} from "./types";

/**
 * Reads the five Milestone 3 prediction-policy knobs from `platform_settings`
 * (migration 20260101000142) — same reasoning and same admin-client pattern
 * as `getFreshnessPolicy()` (lib/prediction-markets/discovery/policy.ts):
 * this must be callable from a script, a job, or a test, not only from
 * inside a live HTTP request.
 *
 * Fail-open, matching this codebase's existing convention for
 * platform_settings reads (lib/settings/pool-capabilities.ts,
 * getFreshnessPolicy): an unreadable settings row falls back to the
 * documented defaults rather than blocking every prediction. This differs
 * deliberately from capability-policy's fail-CLOSED convention — that
 * governs a privilege decision (who may mutate taxonomy); this governs
 * ordinary product eligibility, where the existing platform_settings
 * precedent is fail-open.
 */
const DEFAULT_PREDICTION_POLICY: PredictionPolicy = {
  allowRepeat: false,
  cutoffMinutesBeforeClose: 0,
  allowStalePrice: true,
  allowUnavailablePrice: false,
  allowClosedMarket: false,
  // M2 — fail CLOSED: an unreadable settings row offers no template and still requires a price (the opposite of the fail-open knobs above, because these two decide who may act).
  requirePrice: true,
  allowedTemplates: [],
};

export async function getPredictionPolicy(): Promise<PredictionPolicy> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("platform_settings")
    .select(
      "prediction_allow_repeat, prediction_cutoff_minutes_before_close, prediction_allow_stale_price, prediction_allow_unavailable_price, prediction_allow_closed_market, prediction_require_price, prediction_allowed_templates",
    )
    .eq("id", true)
    .single();

  if (!data) return DEFAULT_PREDICTION_POLICY;
  return {
    allowRepeat: data.prediction_allow_repeat ?? DEFAULT_PREDICTION_POLICY.allowRepeat,
    cutoffMinutesBeforeClose:
      data.prediction_cutoff_minutes_before_close ?? DEFAULT_PREDICTION_POLICY.cutoffMinutesBeforeClose,
    allowStalePrice: data.prediction_allow_stale_price ?? DEFAULT_PREDICTION_POLICY.allowStalePrice,
    allowUnavailablePrice: data.prediction_allow_unavailable_price ?? DEFAULT_PREDICTION_POLICY.allowUnavailablePrice,
    allowClosedMarket: data.prediction_allow_closed_market ?? DEFAULT_PREDICTION_POLICY.allowClosedMarket,
    // M2: parsed fail-closed (see lib/prediction-markets/market-policy-parse.ts).
    requirePrice: parseMarketPolicy(data).requirePrice,
    allowedTemplates: parseMarketPolicy(data).allowedTemplates,
  };
}

export interface MarketEligibilityInput {
  consumerStatus: ConsumerMarketStatus | null;
  /** M2: MONEYLINE | SPREAD | TOTAL — checked against the allow-list before anything price-related. */
  marketTemplate: string;
  freshness: Freshness;
  yesPrice: number | null;
  noPrice: number | null;
  closesAt: string | null;
  /** Injected for testability — never `new Date()` inline in the pure function itself. */
  now: Date;
}

/**
 * The pure market-eligibility decision (roadmap-adjacent policy, made
 * explicitly in this milestone) — no I/O, exactly like
 * `classifyFreshness`/`policyAllowsRole` in this codebase's other domains,
 * so the whole rule is unit-testable with explicit inputs.
 *
 * Order of checks is significant and documented: a market that is
 * RESOLVED is never predictable regardless of policy (true invariant —
 * predicting on an already-known outcome isn't a prediction). Every other
 * check is genuinely configurable. This function does NOT check
 * "already predicted" (repeat policy) — that requires a database read and
 * is handled by the caller (lib/actions/predictions.ts), which reuses this
 * same PredictionEligibility shape for its own ALREADY_PREDICTED result.
 */
export function checkMarketEligibility(input: MarketEligibilityInput, policy: PredictionPolicy): PredictionEligibility {
  const { consumerStatus, marketTemplate, freshness, yesPrice, noPrice, closesAt, now } = input;

  if (consumerStatus === null) return { eligible: false, reason: "MARKET_INACTIVE" };
  if (consumerStatus === "RESOLVED") return { eligible: false, reason: "MARKET_RESOLVED" };
  if (consumerStatus === "CLOSED" && !policy.allowClosedMarket) {
    return { eligible: false, reason: "MARKET_CLOSED" };
  }

  // M2 — STRUCTURAL eligibility, kept apart from PRICE eligibility below: the Market must be of a template Members are currently offered. (The database enforces the same rule
  // in set_pick / call_bs; this is the early, friendly answer.) Historical Markets of other templates stay readable — this only stops NEW interaction.
  if (!policy.allowedTemplates.includes(marketTemplate)) return { eligible: false, reason: "TEMPLATE_NOT_ALLOWED" };

  // PRICE eligibility, policy-controlled (prediction_require_price). true = exactly the pre-M2 rules. false = price is enrichment only: a team-winner Pick stays available
  // until the real deadline whatever the sportsbook coverage, and a missing price is simply recorded as NULL (see priceSnapshotFor), never invented.
  if (policy.requirePrice) {
    if (freshness === "UNAVAILABLE" && !policy.allowUnavailablePrice) {
      return { eligible: false, reason: "PRICE_UNAVAILABLE" };
    }
    if (freshness === "STALE" && !policy.allowStalePrice) {
      return { eligible: false, reason: "PRICE_STALE" };
    }
    // A genuine snapshot needs both real values, regardless of freshness
    // classification (freshness alone doesn't guarantee both sides parsed).
    if (yesPrice === null || noPrice === null) {
      return { eligible: false, reason: "PRICE_UNAVAILABLE" };
    }
  }

  // DEPRECATED (Brohda 2.1): the market-close-relative cutoff is outside the Member contract. T-10 (pick_lock_minutes_before_kickoff, enforced in the database by pick_action_window) is the ONLY Member
  // prediction deadline, and sports Markets carry no close time (markets.closes_at is null for every ingested Market), so this branch does not fire. Kept, not deleted, until it can be retired safely.
  if (policy.cutoffMinutesBeforeClose > 0 && closesAt !== null) {
    const cutoffMs = new Date(closesAt).getTime() - policy.cutoffMinutesBeforeClose * 60_000;
    if (now.getTime() >= cutoffMs) return { eligible: false, reason: "PAST_CUTOFF" };
  }

  return { eligible: true };
}

/**
 * What a Pick records as its price snapshot (M2). Both sides or neither, and never a substituted number — a Pick made with no price says so with NULL, so history can always tell
 * "a price existed" from "none did".
 *  - requirePrice ON (the pre-M2 rule): exactly today's behaviour — the observed prices, whenever both exist.
 *  - requirePrice OFF: the observed prices only while they still describe Pick time; a price classified UNAVAILABLE (too old to be current) is recorded as NULL, not as if it were live.
 */
export function priceSnapshotFor(yesPrice: number | null, noPrice: number | null, freshness: Freshness, requirePrice: boolean): { yes: number; no: number } | { yes: null; no: null } {
  if (yesPrice === null || noPrice === null) return { yes: null, no: null };
  if (!requirePrice && freshness === "UNAVAILABLE") return { yes: null, no: null };
  return { yes: yesPrice, no: noPrice };
}

const DEFAULT_PICK_LOCK_POLICY: PickLockPolicy = { lockMinutesBeforeKickoff: 10 };

/**
 * Milestone R5: reads the Pick-cutoff-before-kickoff policy
 * (platform_settings.pick_lock_minutes_before_kickoff,
 * 20260101000152_pick_editing_and_locking.sql). Present mainly for
 * display/presentation purposes (e.g. a countdown deriving its own copy) —
 * the authoritative enforcement of this value lives inside the `set_pick`
 * SQL function itself, re-read fresh on every call, never trusted from a
 * value computed here and handed across a round-trip (§11, §28, §35).
 * Fail-open, matching getPredictionPolicy's own reasoning: this governs
 * ordinary product policy display, not a privilege decision.
 */
export async function getPickLockPolicy(): Promise<PickLockPolicy> {
  const supabase = createAdminClient();
  const { data } = await supabase.from("platform_settings").select("pick_lock_minutes_before_kickoff").eq("id", true).single();
  if (!data) return DEFAULT_PICK_LOCK_POLICY;
  return { lockMinutesBeforeKickoff: data.pick_lock_minutes_before_kickoff ?? DEFAULT_PICK_LOCK_POLICY.lockMinutesBeforeKickoff };
}

/**
 * Reads the four grading-notification policy knobs from `platform_settings`
 * (migration 20260101000146) — Milestone 3 final standing-rule remediation.
 *
 * Deliberately fail-CLOSED, unlike `getPredictionPolicy()` above: a
 * `prediction_graded` notification is an optional, best-effort side effect
 * of grading, never something grading's own correctness depends on. If the
 * policy row is missing, the query fails, or a column comes back a
 * non-boolean (defensive — the schema itself already constrains the type,
 * but this mirrors this codebase's other policy readers' "don't trust an
 * unreadable/malformed row" discipline), the caller must not send a
 * notification it cannot justify against real configuration. Returns
 * `null` for any of those cases; `shouldNotifyForResult` below treats
 * `null` as "do not send" — grading itself is entirely unaffected either
 * way (see lib/predictions/grading.ts / lib/notifications/predictions.ts).
 */
export async function getPredictionNotificationPolicy(): Promise<PredictionNotificationPolicy | null> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("platform_settings")
      .select(
        "prediction_notifications_enabled, prediction_notify_on_correct, prediction_notify_on_incorrect, prediction_notify_on_void",
      )
      .eq("id", true)
      .single();
    if (error || !data) return null;

    const {
      prediction_notifications_enabled: enabled,
      prediction_notify_on_correct: notifyOnCorrect,
      prediction_notify_on_incorrect: notifyOnIncorrect,
      prediction_notify_on_void: notifyOnVoid,
    } = data;
    if (
      typeof enabled !== "boolean" ||
      typeof notifyOnCorrect !== "boolean" ||
      typeof notifyOnIncorrect !== "boolean" ||
      typeof notifyOnVoid !== "boolean"
    ) {
      return null;
    }

    return { enabled, notifyOnCorrect, notifyOnIncorrect, notifyOnVoid };
  } catch {
    return null;
  }
}

/**
 * The pure notify/don't-notify decision — no I/O, unit-testable with an
 * explicit policy value. `null` policy (unreadable/malformed) always
 * denies. A `PredictionResult` this function does not explicitly
 * recognize also always denies — there is no `default: true` fallthrough,
 * so an unknown/future result value can never bypass policy by accident
 * (it would have to be added here deliberately, the same discipline
 * `policyAllowsRole`/`parseCapabilityPolicy` already apply to capability
 * policy).
 */
export function shouldNotifyForResult(result: PredictionResult, policy: PredictionNotificationPolicy | null): boolean {
  if (policy === null || !policy.enabled) return false;
  switch (result) {
    case "CORRECT":
      return policy.notifyOnCorrect;
    case "INCORRECT":
      return policy.notifyOnIncorrect;
    case "VOID":
      return policy.notifyOnVoid;
    default:
      return false;
  }
}

/**
 * Reads the six `prediction_graded` title/body copy columns from
 * `platform_settings` (migration 20260101000147). Every value must come
 * back a non-empty string, or the WHOLE policy is treated as unreadable
 * (`null`) — the same "one bad entry invalidates the whole row" discipline
 * `parseCapabilityPolicy` already applies, rather than mixing configured
 * and fallback wording within a single notification.
 *
 * Fails safe by falling back to known-good built-in copy
 * (`lib/notifications/predictions.ts`'s `DEFAULT_NOTIFICATION_COPY`) when
 * this returns `null` — deliberately NOT the same "fail closed, don't
 * send" strategy `getPredictionNotificationPolicy` above uses. That
 * function governs WHETHER an optional notification exists at all;
 * copy only governs its WORDING, and a missing/malformed template is not
 * a reason to withhold a notification a user is otherwise owed — "silence
 * is never acceptable where trust is at stake" (the roadmap's own
 * preserved Forever Principle) applies here too. Grading itself is
 * unaffected either way, exactly like the notification-enablement policy.
 */
export async function getPredictionNotificationCopyPolicy(): Promise<PredictionNotificationCopyPolicy | null> {
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("platform_settings")
      .select(
        "prediction_notify_title_correct, prediction_notify_body_correct, prediction_notify_title_incorrect, prediction_notify_body_incorrect, prediction_notify_title_void, prediction_notify_body_void",
      )
      .eq("id", true)
      .single();
    if (error || !data) return null;

    const {
      prediction_notify_title_correct: titleCorrect,
      prediction_notify_body_correct: bodyCorrect,
      prediction_notify_title_incorrect: titleIncorrect,
      prediction_notify_body_incorrect: bodyIncorrect,
      prediction_notify_title_void: titleVoid,
      prediction_notify_body_void: bodyVoid,
    } = data;
    const values = [titleCorrect, bodyCorrect, titleIncorrect, bodyIncorrect, titleVoid, bodyVoid];
    if (!values.every((value): value is string => typeof value === "string" && value.length > 0)) {
      return null;
    }

    return {
      correct: { title: titleCorrect, body: bodyCorrect },
      incorrect: { title: titleIncorrect, body: bodyIncorrect },
      void: { title: titleVoid, body: bodyVoid },
    };
  } catch {
    return null;
  }
}
