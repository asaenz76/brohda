import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "./check";

// Milestone 5 (Simulated Execution). Deliberately NOT reusing
// checkEntryRateLimit/Prediction's own rate-limit class — quote/
// confirmation traffic has a different risk profile, and Milestone 4's
// architecture gate document explicitly calls for financial-execution
// rate limiting to fail CLOSED rather than inherit this codebase's
// existing fail-open default (docs/architecture/execution-architecture-gate.md
// §24). Quote requests are read-only and low-risk, so they keep the
// existing fail-open behavior (checkRateLimit); confirmation is the one
// action that creates a persisted record, and rehearses the fail-closed
// posture Milestone 6's real order submission will require — this
// deliberate split is documented explicitly here (and in
// docs/architecture/simulated-execution.md) precisely so it is never
// mistaken for an accidental fail-open precedent being set for real money.
//
// The fail-open/fail-closed split above, and server-side-only enforcement,
// are architectural/security invariants and stay code-level. The window
// length, max-attempt count, and whether each class is enforced at all are
// mutable operational policy (Milestone 5 final remediation) — they live in
// `platform_settings` (migration 20260101000152), edited via
// `pnpm set-execution-rate-limit-policy`, never as hard-coded constants here.

interface RateLimitClassPolicy {
  enabled: boolean;
  windowSeconds: number;
  maxAttempts: number;
}

export interface ExecutionRateLimitPolicy {
  quote: RateLimitClassPolicy;
  confirmation: RateLimitClassPolicy;
}

/**
 * NOT the live policy source. This is the emergency fallback used only when
 * `platform_settings` itself cannot be read at all (a platform-wide outage
 * far bigger than this one feature) or a field comes back malformed. It
 * intentionally reproduces Milestone 5's original hard-coded values so a
 * config-read problem can never silently loosen enforcement — in
 * particular, the confirmation class stays enabled with its original
 * window/attempts here, so missing configuration never turns into an
 * accidental fail-open for confirmations. The values operators actually
 * control live in `platform_settings`.
 */
export const FALLBACK_EXECUTION_RATE_LIMIT_POLICY: ExecutionRateLimitPolicy = {
  quote: { enabled: true, windowSeconds: 60, maxAttempts: 30 },
  confirmation: { enabled: true, windowSeconds: 60, maxAttempts: 10 },
};

function sanitizeClassPolicy(raw: { enabled: unknown; windowSeconds: unknown; maxAttempts: unknown }, fallback: RateLimitClassPolicy): RateLimitClassPolicy {
  const { windowSeconds, maxAttempts } = raw;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    windowSeconds: typeof windowSeconds === "number" && Number.isFinite(windowSeconds) && windowSeconds > 0 ? windowSeconds : fallback.windowSeconds,
    maxAttempts: typeof maxAttempts === "number" && Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : fallback.maxAttempts,
  };
}

/**
 * Reads Milestone 5's rate-limit policy from `platform_settings`
 * (migration 20260101000152). Exported (rather than kept private) so
 * integration tests can assert on the exact resolved policy, not just its
 * downstream allow/deny effect.
 */
export async function getExecutionRateLimitPolicy(): Promise<ExecutionRateLimitPolicy> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("platform_settings")
    .select(
      "execution_quote_rate_limit_enabled, execution_quote_rate_limit_window_seconds, execution_quote_rate_limit_max_attempts, execution_confirmation_rate_limit_enabled, execution_confirmation_rate_limit_window_seconds, execution_confirmation_rate_limit_max_attempts",
    )
    .eq("id", true)
    .single();

  if (!data) return FALLBACK_EXECUTION_RATE_LIMIT_POLICY;

  return {
    quote: sanitizeClassPolicy(
      {
        enabled: data.execution_quote_rate_limit_enabled,
        windowSeconds: data.execution_quote_rate_limit_window_seconds,
        maxAttempts: data.execution_quote_rate_limit_max_attempts,
      },
      FALLBACK_EXECUTION_RATE_LIMIT_POLICY.quote,
    ),
    confirmation: sanitizeClassPolicy(
      {
        enabled: data.execution_confirmation_rate_limit_enabled,
        windowSeconds: data.execution_confirmation_rate_limit_window_seconds,
        maxAttempts: data.execution_confirmation_rate_limit_max_attempts,
      },
      FALLBACK_EXECUTION_RATE_LIMIT_POLICY.confirmation,
    ),
  };
}

/** Fail-open (existing convention) — quote requests are read-only, no persisted state, no financial exposure. */
export async function checkExecutionQuoteRateLimit(userId: string): Promise<boolean> {
  const policy = await getExecutionRateLimitPolicy();
  if (!policy.quote.enabled) return true;
  return checkRateLimit(`execution-quote:${userId}`, policy.quote.windowSeconds, policy.quote.maxAttempts);
}

/**
 * Fail-CLOSED — a deliberate divergence from `checkRateLimit`'s own
 * fail-open default, justified by this action's persisted-record nature
 * and its role as the direct rehearsal for Milestone 6's real order
 * submission, which the architecture gate document already requires to
 * fail closed. This posture is independent of configuration: even if the
 * policy read above falls back to defaults, this function still enforces
 * a real limit and still fails closed on a backend error.
 */
export async function checkExecutionConfirmationRateLimit(userId: string): Promise<boolean> {
  const policy = await getExecutionRateLimitPolicy();
  if (!policy.confirmation.enabled) return true;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("check_and_increment_rate_limit", {
    p_identifier: `execution-confirm:${userId}`,
    p_window_seconds: policy.confirmation.windowSeconds,
    p_max_attempts: policy.confirmation.maxAttempts,
  });

  if (error) {
    console.error("[execution] confirmation rate limit check failed — failing closed:", error.message);
    return false;
  }

  return data === true;
}
