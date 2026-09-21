/**
 * The protected operational path for changing Milestone 5's Simulated
 * Execution policy (docs/architecture/simulated-execution.md) — both the
 * original simulation policy (amount range, quote expiry, data freshness,
 * slippage, recalculation tolerance, simulated fees — migration
 * 20260101000149) and the quote/confirmation rate-limit policy added in
 * the Milestone 5 final remediation (migration 20260101000152). Both live
 * in the same `platform_settings` singleton; this script is how an
 * operator edits either without a code change or deployment — same shape
 * as scripts/set-prediction-policy.ts, for the same reason (no dedicated
 * settings-page UI exists yet for a policy surface this narrow).
 *
 * Usage:
 *   pnpm set-execution-policy --show
 *   pnpm set-execution-policy --simulation-enabled=true
 *   pnpm set-execution-policy --min-amount-cents=100 --max-amount-cents=100000
 *   pnpm set-execution-policy --quote-expiry-seconds=30 --data-freshness-max-seconds=10
 *   pnpm set-execution-policy --max-slippage-bps=500 --recalculation-tolerance-bps=200
 *   pnpm set-execution-policy --simulated-provider-fee-bps=100 --simulated-brohda-fee-bps=0
 *   pnpm set-execution-policy --quote-rate-limit-enabled=true --quote-rate-limit-window-seconds=60 --quote-rate-limit-max-attempts=30
 *   pnpm set-execution-policy --confirmation-rate-limit-enabled=true --confirmation-rate-limit-window-seconds=60 --confirmation-rate-limit-max-attempts=10
 *
 * (pass only the flags you want to change)
 */
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { assertProductionWriteConfirmed } from "./lib/production-guard";

// Same reason as create-super-admin.ts/set-capability-policy.ts:
// lib/supabase/admin.ts is guarded by the `server-only` package, which
// throws outside Next's react-server condition — which is exactly this
// plain-tsx context.
function createAdminClient() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function getBoolArg(flag: string): boolean | undefined {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!arg) return undefined;
  const value = arg.split("=")[1];
  if (value === "true") return true;
  if (value === "false") return false;
  console.error(`${flag} must be =true or =false`);
  process.exit(1);
}

function getIntArg(flag: string): number | undefined {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!arg) return undefined;
  const value = Number.parseInt(arg.split("=")[1], 10);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${flag} must be a non-negative integer`);
    process.exit(1);
  }
  return value;
}

// Rate-limit windows/attempt counts have a stricter DB check constraint
// (> 0, not just >= 0) — a window of 0 or a max-attempts of 0 is not a
// meaningful "disabled" state (use the dedicated --*-enabled=false flag
// for that), it would just mean every request fails or none ever expire.
function getPositiveIntArg(flag: string): number | undefined {
  const value = getIntArg(flag);
  if (value !== undefined && value === 0) {
    console.error(`${flag} must be a positive integer (use the --*-enabled=false flag to disable this class instead of 0)`);
    process.exit(1);
  }
  return value;
}

const COLUMNS =
  "execution_simulation_enabled, execution_min_amount_cents, execution_max_amount_cents, execution_quote_expiry_seconds, execution_data_freshness_max_seconds, execution_max_slippage_bps, execution_recalculation_tolerance_bps, execution_simulated_provider_fee_bps, execution_simulated_brohda_fee_bps, execution_quote_rate_limit_enabled, execution_quote_rate_limit_window_seconds, execution_quote_rate_limit_max_attempts, execution_confirmation_rate_limit_enabled, execution_confirmation_rate_limit_window_seconds, execution_confirmation_rate_limit_max_attempts";

async function main() {
  const admin = createAdminClient();

  if (process.argv.includes("--show")) {
    const { data, error } = await admin.from("platform_settings").select(COLUMNS).eq("id", true).single();
    if (error) {
      console.error("Failed to read execution policy:", error.message);
      process.exit(1);
    }
    console.log(data);
    return;
  }

  const update: Record<string, boolean | number> = {};

  const simulationEnabled = getBoolArg("--simulation-enabled");
  if (simulationEnabled !== undefined) update.execution_simulation_enabled = simulationEnabled;
  const minAmountCents = getIntArg("--min-amount-cents");
  if (minAmountCents !== undefined) update.execution_min_amount_cents = minAmountCents;
  const maxAmountCents = getIntArg("--max-amount-cents");
  if (maxAmountCents !== undefined) update.execution_max_amount_cents = maxAmountCents;
  const quoteExpirySeconds = getIntArg("--quote-expiry-seconds");
  if (quoteExpirySeconds !== undefined) update.execution_quote_expiry_seconds = quoteExpirySeconds;
  const dataFreshnessMaxSeconds = getIntArg("--data-freshness-max-seconds");
  if (dataFreshnessMaxSeconds !== undefined) update.execution_data_freshness_max_seconds = dataFreshnessMaxSeconds;
  const maxSlippageBps = getIntArg("--max-slippage-bps");
  if (maxSlippageBps !== undefined) update.execution_max_slippage_bps = maxSlippageBps;
  const recalculationToleranceBps = getIntArg("--recalculation-tolerance-bps");
  if (recalculationToleranceBps !== undefined) update.execution_recalculation_tolerance_bps = recalculationToleranceBps;
  const simulatedProviderFeeBps = getIntArg("--simulated-provider-fee-bps");
  if (simulatedProviderFeeBps !== undefined) update.execution_simulated_provider_fee_bps = simulatedProviderFeeBps;
  const simulatedBrohdaFeeBps = getIntArg("--simulated-brohda-fee-bps");
  if (simulatedBrohdaFeeBps !== undefined) update.execution_simulated_brohda_fee_bps = simulatedBrohdaFeeBps;

  const quoteRateLimitEnabled = getBoolArg("--quote-rate-limit-enabled");
  if (quoteRateLimitEnabled !== undefined) update.execution_quote_rate_limit_enabled = quoteRateLimitEnabled;
  const quoteRateLimitWindowSeconds = getPositiveIntArg("--quote-rate-limit-window-seconds");
  if (quoteRateLimitWindowSeconds !== undefined) update.execution_quote_rate_limit_window_seconds = quoteRateLimitWindowSeconds;
  const quoteRateLimitMaxAttempts = getPositiveIntArg("--quote-rate-limit-max-attempts");
  if (quoteRateLimitMaxAttempts !== undefined) update.execution_quote_rate_limit_max_attempts = quoteRateLimitMaxAttempts;

  const confirmationRateLimitEnabled = getBoolArg("--confirmation-rate-limit-enabled");
  if (confirmationRateLimitEnabled !== undefined) update.execution_confirmation_rate_limit_enabled = confirmationRateLimitEnabled;
  const confirmationRateLimitWindowSeconds = getPositiveIntArg("--confirmation-rate-limit-window-seconds");
  if (confirmationRateLimitWindowSeconds !== undefined) update.execution_confirmation_rate_limit_window_seconds = confirmationRateLimitWindowSeconds;
  const confirmationRateLimitMaxAttempts = getPositiveIntArg("--confirmation-rate-limit-max-attempts");
  if (confirmationRateLimitMaxAttempts !== undefined) update.execution_confirmation_rate_limit_max_attempts = confirmationRateLimitMaxAttempts;

  if (Object.keys(update).length === 0) {
    console.error(
      "Usage:\n  pnpm set-execution-policy --show\n  pnpm set-execution-policy --simulation-enabled=true|false\n  pnpm set-execution-policy --min-amount-cents=N --max-amount-cents=N\n  pnpm set-execution-policy --quote-expiry-seconds=N --data-freshness-max-seconds=N\n  pnpm set-execution-policy --max-slippage-bps=N --recalculation-tolerance-bps=N\n  pnpm set-execution-policy --simulated-provider-fee-bps=N --simulated-brohda-fee-bps=N\n  pnpm set-execution-policy --quote-rate-limit-enabled=true|false --quote-rate-limit-window-seconds=N --quote-rate-limit-max-attempts=N\n  pnpm set-execution-policy --confirmation-rate-limit-enabled=true|false --confirmation-rate-limit-window-seconds=N --confirmation-rate-limit-max-attempts=N\n(pass only the flags you want to change)",
    );
    process.exit(1);
  }

  assertProductionWriteConfirmed(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", "set-execution-policy");

  const { error } = await admin.from("platform_settings").update(update).eq("id", true);
  if (error) {
    console.error("Failed to write execution policy:", error.message);
    process.exit(1);
  }

  console.log("Updated:", update);
}

main();
