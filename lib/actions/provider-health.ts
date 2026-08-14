"use server";

import { requireSuperAdmin } from "@/lib/auth/session";
import { getSportsProvider } from "@/lib/sports-data/provider-registry";
import { API_FOOTBALL_PROVIDER, API_NFL_PROVIDER } from "@/lib/sports-data/provider-names";

// A cheap, known single-item lookup per provider — never the season/
// fixture-list queries background jobs already use, since this is purely
// a connectivity check (spec §24: "one request maximum... a cheaper
// supported endpoint... if one exists" rather than an expensive query).
const TEST_LEAGUE_ID: Record<string, string> = {
  [API_FOOTBALL_PROVIDER]: "39", // Premier League — a real, stable SUPPORTED_COMPETITIONS entry
  [API_NFL_PROVIDER]: "1", // NFL's one supported league
};

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

  const testId = TEST_LEAGUE_ID[provider];
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
