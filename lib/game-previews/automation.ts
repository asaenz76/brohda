import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { competitionPhase } from "./identity";
import { fetchPublishedDate } from "./source-dates";
import { trustedVenueTimezone } from "@/lib/sports-data/timezone";
import { generateGamePreview, type GenerationOutcome, type PipelineDeps } from "./pipeline";
import { createGamePreviewProviders } from "./providers";
import { getGamePreviewConfig, listGamePreviewCandidates, listRecentHooks, recordGenerationRun, saveGamePreview } from "./repository";
import type { GamePreviewReason } from "./types";
import type { GameIdentity } from "./providers/types";

/** The canonical identity of a Game that is still eligible for a Preview (published Post, not started), or null. */
async function loadGame(fixtureId: string): Promise<GameIdentity | null> {
  const { data: f } = await createAdminClient().from("fixtures").select("id, sport, competition_name, home_team_name, away_team_name, scheduled_start_utc, internal_status, season, round, venue_city, venue_timezone").eq("id", fixtureId).maybeSingle();
  if (!f || f.internal_status !== "NOT_STARTED" || new Date(f.scheduled_start_utc).getTime() <= Date.now()) return null;
  return { fixtureId: f.id, sport: f.sport, competition: f.competition_name, homeTeam: f.home_team_name, awayTeam: f.away_team_name, kickoffUtc: f.scheduled_start_utc, season: f.season ?? null, phase: competitionPhase(f.round), timezone: trustedVenueTimezone(f.venue_city, f.venue_timezone), asOf: new Date().toISOString() };
}

export type RunResult = { configured: true; outcome: GenerationOutcome } | { configured: false; error: string };

/** One explicit run for one Game (the admin's Generate / Regenerate): allowed whether or not automatic generation is on, but it still needs a provider with credentials and a configured model. */
export async function runGamePreviewGenerationFor(fixtureId: string, reason: GamePreviewReason, trigger: "AUTOMATIC" | "ADMIN", actorId: string | null = null): Promise<RunResult> {
  const config = await getGamePreviewConfig();
  const providers = createGamePreviewProviders(config);
  if (!providers) return { configured: false, error: "No credentials are configured for the selected provider." };
  const deps: PipelineDeps = { config, providers, loadGame, save: saveGamePreview, recordRun: recordGenerationRun, now: () => new Date(), recentHooks: () => listRecentHooks(), fetchPublishedDate: (url) => fetchPublishedDate(url) };
  // The actor is the authenticated Admin passed by the server action, never anything from a client payload; an automatic run has none.
  return { configured: true, outcome: await generateGamePreview(deps, { fixtureId, reason, trigger, actorId: trigger === "ADMIN" ? actorId : null }) };
}

export interface AutomationReport {
  enabled: boolean;
  configured: boolean;
  attempted: number;
  succeeded: number;
  failed: number;
}

/**
 * The scheduled step: OFF unless `generation_enabled` is on in the stored configuration. When on and a provider is configured, it takes the soonest Games that need a Preview (missing or stale, inside the lead time), at most
 * `max_games_per_run` per tick, one after another. Refresh rules and the freeze at kickoff are enforced by the database, so a Game that already has a fresh Preview, or has started, is never rewritten.
 */
export async function runGamePreviewAutomation(): Promise<AutomationReport> {
  const config = await getGamePreviewConfig();
  if (!config.generationEnabled) return { enabled: false, configured: false, attempted: 0, succeeded: 0, failed: 0 };
  const providers = createGamePreviewProviders(config);
  if (!providers || !config.model.trim()) return { enabled: true, configured: false, attempted: 0, succeeded: 0, failed: 0 };
  const deps: PipelineDeps = { config, providers, loadGame, save: saveGamePreview, recordRun: recordGenerationRun, now: () => new Date(), recentHooks: () => listRecentHooks(), fetchPublishedDate: (url) => fetchPublishedDate(url) };
  const candidates = (await listGamePreviewCandidates()).slice(0, config.maxGamesPerRun);
  let succeeded = 0;
  let failed = 0;
  for (const c of candidates) {
    const outcome = await generateGamePreview(deps, { fixtureId: c.fixtureId, reason: c.reason, trigger: "AUTOMATIC" });
    if (outcome.status === "SUCCEEDED") succeeded += 1;
    else failed += 1;
  }
  return { enabled: true, configured: true, attempted: candidates.length, succeeded, failed };
}
