import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// A shared, short-TTL cache of the RAW provider odds response — used inside
// api-nfl-provider.ts's odds fetch so two odds-backed calls for the same
// fixture within the window share one live provider response instead of
// two. Provider-scoped (not NFL-specific in shape) so a future sport's
// provider can reuse this same cache for its own raw odds responses.
const RAW_ODDS_CACHE_TTL_MS = 5 * 60 * 1000;

interface RawOddsCacheRow {
  raw_response: unknown;
  fetched_at: string;
}

export async function getCachedRawOdds<T>(provider: string, externalFixtureId: string): Promise<T | null> {
  const adminClient = createAdminClient();
  const { data } = await adminClient
    .from("fixture_odds_raw_cache")
    .select("raw_response, fetched_at")
    .eq("provider", provider)
    .eq("external_fixture_id", externalFixtureId)
    .maybeSingle<RawOddsCacheRow>();

  if (!data) return null;
  const ageMs = Date.now() - new Date(data.fetched_at).getTime();
  if (ageMs > RAW_ODDS_CACHE_TTL_MS) return null;
  return data.raw_response as T;
}

export async function setCachedRawOdds(provider: string, externalFixtureId: string, raw: unknown): Promise<void> {
  const adminClient = createAdminClient();
  await adminClient
    .from("fixture_odds_raw_cache")
    .upsert({ provider, external_fixture_id: externalFixtureId, raw_response: raw, fetched_at: new Date().toISOString() });
}
