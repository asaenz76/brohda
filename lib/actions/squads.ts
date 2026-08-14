"use server";

import { requireAdminOrAbove } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSportsProvider } from "@/lib/sports-data/provider-registry";
import { supports } from "@/lib/sports-data/provider-capabilities";
import { API_FOOTBALL_PROVIDER } from "@/lib/sports-data/provider-names";
import { isFresh } from "@/lib/utils/freshness";

const SQUAD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SquadPlayer {
  externalPlayerId: string;
  name: string;
  position: string | null;
}

function fromCacheRows(rows: { external_player_id: string; name: string; position: string | null }[]): SquadPlayer[] {
  return rows.map((p) => ({ externalPlayerId: p.external_player_id, name: p.name, position: p.position }));
}

/**
 * Backs the "Player to score" template's player picker
 * (app/(admin)/admin/pools/new/player-picker.tsx) — plain read-only async
 * call, not a useActionState mutation. `provider` is the caller's
 * fixture.provider — PLAYER_TO_SCORE is a football-only template today
 * (provider-capabilities.ts's "squad_data" is only true for API-Football),
 * but this routes by identity via the provider registry rather than
 * assuming, so a future non-football squad feature fails explicitly
 * instead of silently querying the wrong provider's roster.
 *
 * Phase 3 fix: this used to call apiFootballProvider.getTeamSquad with no
 * try/catch at all — a real provider failure threw, uncaught, out of this
 * action, and PlayerPicker's own un-caught `.then()` meant the picker just
 * spun on "loading" forever with zero error surfaced anywhere in the UI.
 * Now this always resolves — a failure or an unsupported provider falls
 * back to whatever's cached (even if stale), same as a genuinely-empty
 * response — matching the same best-effort convention
 * getFixtureMarketsAction/getFixtureGoalsLinesAction already use. The
 * failure itself is still recorded in provider_request_log via
 * fetchWithRetry; this is a deliberate degraded-UX tradeoff, not a silent
 * one.
 */
export async function getTeamSquadAction(externalTeamId: string, provider: string = API_FOOTBALL_PROVIDER): Promise<SquadPlayer[]> {
  await requireAdminOrAbove();
  const admin = createAdminClient();

  const { data: cached } = await admin
    .from("team_players")
    .select("external_player_id, name, position, synced_at")
    .eq("provider", provider)
    .eq("team_external_id", externalTeamId)
    .order("name");

  const freshEnough = cached && cached.length > 0 && isFresh(cached[0].synced_at, SQUAD_CACHE_TTL_MS);
  if (freshEnough) {
    return fromCacheRows(cached!);
  }

  if (!supports(provider, "squad_data")) {
    return fromCacheRows(cached ?? []);
  }

  const sportsProvider = getSportsProvider(provider);
  if (!sportsProvider) {
    return fromCacheRows(cached ?? []);
  }

  let squad;
  try {
    squad = await sportsProvider.getTeamSquad(externalTeamId);
  } catch {
    return fromCacheRows(cached ?? []);
  }

  if (squad.length === 0) {
    // Provider disabled or genuinely has no squad data — same fallback.
    return fromCacheRows(cached ?? []);
  }

  await admin.from("team_players").upsert(
    squad.map((p) => ({
      provider,
      team_external_id: externalTeamId,
      external_player_id: p.externalPlayerId,
      name: p.name,
      position: p.position,
      jersey_number: p.jerseyNumber,
      synced_at: new Date().toISOString(),
    })),
    { onConflict: "provider,team_external_id,external_player_id" },
  );

  return squad
    .map((p) => ({ externalPlayerId: p.externalPlayerId, name: p.name, position: p.position }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
