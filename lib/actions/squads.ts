"use server";

import { requireAdminOrAbove } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";

const SQUAD_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SquadPlayer {
  externalPlayerId: string;
  name: string;
  position: string | null;
}

/**
 * Backs the "Player to score" template's player picker
 * (app/(admin)/admin/pools/new/player-picker.tsx) — plain read-only async
 * call, not a useActionState mutation, mirroring getPoolLiveStatsAction's
 * shape. Admin-only since it's only ever used in the pool-creation wizard.
 */
export async function getTeamSquadAction(externalTeamId: string): Promise<SquadPlayer[]> {
  await requireAdminOrAbove();
  const admin = createAdminClient();

  const { data: cached } = await admin
    .from("team_players")
    .select("external_player_id, name, position, synced_at")
    .eq("team_external_id", externalTeamId)
    .order("name");

  const freshEnough =
    cached && cached.length > 0 && Date.now() - new Date(cached[0].synced_at).getTime() < SQUAD_CACHE_TTL_MS;

  if (freshEnough) {
    return cached!.map((p) => ({ externalPlayerId: p.external_player_id, name: p.name, position: p.position }));
  }

  const squad = await apiFootballProvider.getTeamSquad(externalTeamId);
  if (squad.length === 0) {
    // Provider disabled/unreachable — fall back to whatever's cached
    // (even if stale) rather than showing an empty picker.
    return (cached ?? []).map((p) => ({ externalPlayerId: p.external_player_id, name: p.name, position: p.position }));
  }

  await admin.from("team_players").upsert(
    squad.map((p) => ({
      team_external_id: externalTeamId,
      external_player_id: p.externalPlayerId,
      name: p.name,
      position: p.position,
      jersey_number: p.jerseyNumber,
      synced_at: new Date().toISOString(),
    })),
    { onConflict: "team_external_id,external_player_id" },
  );

  return squad
    .map((p) => ({ externalPlayerId: p.externalPlayerId, name: p.name, position: p.position }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
