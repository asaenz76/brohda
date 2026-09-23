import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Freshness } from "./types";

/**
 * Discovery freshness thresholds — CONFIGURABLE OPERATIONAL POLICY
 * (standing rule: "hard-code invariants, configure policy"), stored on the
 * existing `platform_settings` singleton (supabase/migrations/
 * 20260101000138_discovery_freshness_settings.sql), the same table/pattern
 * already used for `registration_enabled`/`paid_pools_enabled`/
 * `free_pools_enabled`. An operator can tune these without a deployment.
 *
 * `classifyFreshness` itself stays a pure function taking the policy as a
 * parameter — this is what keeps it trivially unit-testable with an
 * explicit, injected policy (never the ambient DB value) and keeps this
 * module's only I/O in one place (`getFreshnessPolicy`).
 */
export interface FreshnessPolicy {
  freshWithinMinutes: number;
  staleWithinMinutes: number;
}

/** Matches this column's default in the migration — used only if the settings row is ever unreadable, same fail-open convention as lib/settings/pool-capabilities.ts. */
const FALLBACK_FRESHNESS_POLICY: FreshnessPolicy = { freshWithinMinutes: 60, staleWithinMinutes: 24 * 60 };

/**
 * Uses the service-role admin client, not the cookie-bound RLS-scoped
 * client (lib/supabase/server.ts) — deliberately, and not merely for
 * convenience: `createClient()` reads Next's `cookies()`, which only
 * resolves inside an actual request context (a Server Component render,
 * Server Action, or Route Handler). Every other function in this domain's
 * repository layer (lib/prediction-markets/repository.ts,
 * lib/prediction-markets/discovery/repository.ts) already uses the admin
 * client uniformly for exactly this reason — a repository function should
 * be callable from a script, a future background job, or a test, not only
 * from inside a live HTTP request. `platform_settings` is public-readable
 * regardless (20260101000050_platform_settings.sql's own RLS policy), so
 * this isn't a privilege escalation — it's fixing an accidental,
 * unnecessary request-context dependency this function should never have
 * had.
 */
export async function getFreshnessPolicy(): Promise<FreshnessPolicy> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("platform_settings")
    .select("discovery_fresh_within_minutes, discovery_stale_within_minutes")
    .eq("id", true)
    .single();

  if (!data) return FALLBACK_FRESHNESS_POLICY;
  return {
    freshWithinMinutes: data.discovery_fresh_within_minutes ?? FALLBACK_FRESHNESS_POLICY.freshWithinMinutes,
    staleWithinMinutes: data.discovery_stale_within_minutes ?? FALLBACK_FRESHNESS_POLICY.staleWithinMinutes,
  };
}

/**
 * The single, centralized freshness classifier (roadmap STEP 9). Combines
 * two independent signals into one three-state model: how long ago Brohda
 * last synced this market, and whether usable price data exists at all.
 * Missing price always wins — an old sync with no price is UNAVAILABLE, not
 * merely STALE, since STALE still implies "we have a number to show you."
 */
export function classifyFreshness(lastSyncedAt: string, hasUsablePrice: boolean, policy: FreshnessPolicy): Freshness {
  if (!hasUsablePrice) return "UNAVAILABLE";
  const ageMinutes = (Date.now() - new Date(lastSyncedAt).getTime()) / 60_000;
  if (ageMinutes <= policy.freshWithinMinutes) return "FRESH";
  if (ageMinutes <= policy.staleWithinMinutes) return "STALE";
  return "UNAVAILABLE";
}
