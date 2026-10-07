"use server";

import { requireSuperAdmin } from "@/lib/auth/session";
import { getSportsProvider } from "@/lib/sports-data/provider-registry";
import { getSportConfigByProvider } from "@/lib/sports-data/sport-registry";

// A cheap, known single-item lookup per provider — never the season/
// fixture-list queries background jobs already use, since this is purely
// a connectivity check (one request maximum, a cheaper supported endpoint
// rather than an expensive query).
// The sport's own (first) allowlisted league, from the shared sport registry.
const testLeagueId = (provider: string): string | undefined => getSportConfigByProvider(provider)?.leagues[0]?.externalLeagueId;

export interface ProviderConnectionTestResult {
  success: boolean;
  message: string;
}

/**
 * Explicit, admin-triggered, one-request-maximum connectivity check
 * (Phase 3 spec §6/§24) — never auto-run on page load, never retried on
 * failure. The request itself goes through the normal fetchWithRetry path
 * like any other provider call, so it's logged to provider_request_log
 * and immediately reflected in the Provider Status panel above it.
 */
export async function testProviderConnectionAction(provider: string): Promise<ProviderConnectionTestResult> {
  await requireSuperAdmin();

  const sportsProvider = getSportsProvider(provider);
  if (!sportsProvider) return { success: false, message: `Unknown provider "${provider}".` };
  if (!sportsProvider.isEnabled()) return { success: false, message: "Provider is not enabled." };

  const testId = testLeagueId(provider);
  if (!testId) return { success: false, message: "No connectivity test configured for this provider." };

  try {
    const league = await sportsProvider.getLeagueById(testId);
    return league
      ? { success: true, message: `Connected — resolved "${league.name}".` }
      : { success: false, message: "Request succeeded but returned no data." };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : "Request failed." };
  }
}
