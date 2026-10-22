import "server-only";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { competitionPhase } from "./identity";
import { fetchPublishedDate } from "./source-dates";
import { latestCompletedGames } from "./completed-games";
import { trustedVenueTimezone } from "@/lib/sports-data/timezone";
import { generateGamePreview, type GenerationOutcome, type PipelineDeps } from "./pipeline";
import { createGamePreviewProviders } from "./providers";
import { getGamePreviewConfig, hideGamePreviewForAutomation, listAutomationCandidates, listRecentHooks, recordGenerationRun, saveGamePreview } from "./repository";
import { withGameGenerationLock } from "./generation-lock";
import { raiseAutomationAlert } from "./alerts";
import { reasonFor, runScheduledAutomation, type AutomationReport, type SchedulerDeps } from "./scheduler";
import type { GamePreviewConfig, GamePreviewReason } from "./types";
import type { GameIdentity } from "./providers/types";

export type { AutomationReport } from "./scheduler";

/** The canonical identity of a Game that is still eligible for a Preview (published Post, not started), or null. */
async function loadGame(fixtureId: string): Promise<GameIdentity | null> {
  const { data: f } = await createAdminClient().from("fixtures").select("id, sport, competition_name, home_team_name, away_team_name, scheduled_start_utc, internal_status, season, round, venue_city, venue_timezone, provider, competition_external_id, home_team_external_id, away_team_external_id").eq("id", fixtureId).maybeSingle();
  if (!f || f.internal_status !== "NOT_STARTED" || new Date(f.scheduled_start_utc).getTime() <= Date.now()) return null;
  // The latest COMPLETED Game of each team before this one: a current-state number is current only if its evidence includes them. If the schedule data cannot be read the answer is UNKNOWN (undefined), which the freshness check treats as "cannot be shown", never as "an opener".
  let lastCompleted: GameIdentity["lastCompleted"];
  try {
    lastCompleted = await latestCompletedGames(f);
  } catch {
    lastCompleted = undefined;
  }
  return { fixtureId: f.id, sport: f.sport, competition: f.competition_name, homeTeam: f.home_team_name, awayTeam: f.away_team_name, kickoffUtc: f.scheduled_start_utc, season: f.season ?? null, phase: competitionPhase(f.round), timezone: trustedVenueTimezone(f.venue_city, f.venue_timezone), lastCompleted, asOf: new Date().toISOString() };
}

const pipelineDeps = (config: GamePreviewConfig, providers: NonNullable<ReturnType<typeof createGamePreviewProviders>>): PipelineDeps => ({
  config,
  providers,
  loadGame,
  save: saveGamePreview,
  recordRun: recordGenerationRun,
  now: () => new Date(),
  recentHooks: () => listRecentHooks(),
  fetchPublishedDate: (url) => fetchPublishedDate(url),
});

export type RunResult = { configured: true; outcome: GenerationOutcome } | { configured: true; busy: true } | { configured: false; error: string };

/**
 * One explicit run for one Game (the Admin's Generate / Regenerate): allowed whether or not automatic generation is on, but it still needs a provider with credentials and a configured model. It takes the Game's generation lease, so it can never run at the same time as
 * a scheduled run (or another Admin run) on the same Game: the second asks to try again once the first has finished.
 */
export async function runGamePreviewGenerationFor(fixtureId: string, reason: GamePreviewReason, trigger: "AUTOMATIC" | "ADMIN", actorId: string | null = null): Promise<RunResult> {
  const config = await getGamePreviewConfig();
  const providers = createGamePreviewProviders(config);
  if (!providers) return { configured: false, error: "No credentials are configured for the selected provider." };
  const deps = pipelineDeps(config, providers);
  // The actor is the authenticated Admin passed by the server action, never anything from a client payload; an automatic run has none.
  const run = await withGameGenerationLock(fixtureId, () => generateGamePreview(deps, { fixtureId, reason, trigger, actorId: trigger === "ADMIN" ? actorId : null }));
  return run.acquired ? { configured: true, outcome: run.value } : { configured: true, busy: true };
}

/** Platform: the cron route may run for at most 300 s. A Game takes about 100 s (up to ~140 s measured), so a Game is started only when its expected time still fits in this budget. */
const BUDGET_SECONDS = Number(process.env.GAME_PREVIEW_RUN_BUDGET_SECONDS) > 0 ? Number(process.env.GAME_PREVIEW_RUN_BUDGET_SECONDS) : 270;
const ESTIMATE_SECONDS = 140;
const MAX_CONSECUTIVE_TECHNICAL_FAILURES = 2;

/**
 * The scheduled step, run by its own cron route (`/api/cron/game-previews`, one entry in the external scheduler, daily at the initial rollout). OFF unless `generation_enabled` is on in the stored configuration: then it does nothing at all. When on, it takes the Games the stored
 * rules allow (see `game_preview_automation_candidates`), at most `max_games_per_run`, one after another, each through the same pipeline an Admin run uses and each under that Game's generation lease. See scheduler.ts for the orchestration rules.
 */
export async function runGamePreviewAutomation(): Promise<AutomationReport> {
  const deps: SchedulerDeps = {
    getConfig: getGamePreviewConfig,
    isConfigured: (config) => Boolean(createGamePreviewProviders(config)),
    listCandidates: () => listAutomationCandidates(),
    generate: async (candidate, config, invocation) => {
      const providers = createGamePreviewProviders(config);
      if (!providers) throw new Error("No credentials are configured for the selected provider.");
      const pd = pipelineDeps(config, providers);
      const run = await withGameGenerationLock(candidate.fixtureId, async () => {
        // Re-check inside the lease: an Admin may have generated, withdrawn or edited this Game since the candidates were read.
        const fresh = (await listAutomationCandidates(candidate.fixtureId)).find((c) => c.fixtureId === candidate.fixtureId);
        if (!fresh || fresh.skipReason !== null || fresh.kind !== candidate.kind) return null;
        return generateGamePreview(pd, { fixtureId: candidate.fixtureId, reason: reasonFor(fresh), trigger: "AUTOMATIC", actorId: null, invocation });
      });
      if (!run.acquired) return { kind: "busy" as const };
      return run.value ? { kind: "done" as const, outcome: run.value } : { kind: "ineligible" as const };
    },
    hide: hideGamePreviewForAutomation,
    alert: raiseAutomationAlert,
    newId: () => randomUUID(),
    clock: () => Date.now(),
    budgetMs: BUDGET_SECONDS * 1000,
    estimateMs: ESTIMATE_SECONDS * 1000,
    maxConsecutiveTechnicalFailures: MAX_CONSECUTIVE_TECHNICAL_FAILURES,
  };
  try {
    return await runScheduledAutomation(deps);
  } catch (error) {
    raiseAutomationAlert({ kind: "scheduler_exception", message: "the scheduled Game Preview job threw", context: { error: (error instanceof Error ? error.message : String(error)).slice(0, 300) } });
    throw error;
  }
}
