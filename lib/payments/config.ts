import type { ProviderAvailability } from "./types";

// Provider-NEUTRAL runtime rules. Everything specific to a provider's credentials and environment lives in that provider's adapter (it reports a normalized
// TEST / LIVE / UNAVAILABLE); this file only holds the rule that applies to all of them.
type Env = Record<string, string | undefined>;

/** True on the production deployment (Vercel production). Local runs, CI and previews are not production. */
export function isProductionDeployment(env: Env = process.env): boolean {
  return env.VERCEL_ENV === "production";
}

/**
 * Whether Sponsors are offered online payment right now, given what the active adapter reports. TEST-mode checkout is never shown to Sponsors on the production
 * deployment unless that was explicitly authorized there (PAYMENTS_ALLOW_TEST_IN_PRODUCTION=true) — whichever provider it is. LIVE needs the adapter's own explicit enablement
 * (already folded into its availability).
 */
export function checkoutOffered(availability: ProviderAvailability, env: Env = process.env): boolean {
  if (availability.state === "unavailable") return false;
  if (availability.state === "test" && isProductionDeployment(env) && env.PAYMENTS_ALLOW_TEST_IN_PRODUCTION !== "true") return false;
  return true;
}
