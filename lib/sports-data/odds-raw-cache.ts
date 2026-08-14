import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Phase 3 spec §14/§15: a shared, short-TTL cache of the RAW provider
// odds response — used inside callOddsEndpoint (api-football-provider.ts)
// and callNflOddsEndpoint (api-nfl-provider.ts) so two odds-backed actions
// for the same fixture within the window (confirmed to happen: the pool
// wizard's goals-line prefill and its markets-driven recommendation fetch
// both fire for the same football fixture) share one live provider
// response instead of two. This is deliberately NOT a re-derivation of
// fixture_odds_cache's already-normalized markets — that cache (and its
// NormalizedFixtureMarkets shape) stays exactly as it was; this sits one
// layer lower, caching the raw item both NormalizedFixtureOdds and
// NormalizedFixtureMarkets are independently derived from, so no
// normalization or grading logic changes at all. Also gives API-NFL's
// odds path a cache for the first time — it previously had none.
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
