import "server-only";
import { buildSavePayload, reverificationClaimRow } from "./payload";
import { runStoryPipeline, reverifyEditedText, type PipelineDeps } from "./pipeline";
import { createPipelineDeps } from "./providers";
import { StoryProviderError } from "./providers/anthropic";
import {
  completeReverification, failRun, getStoryConfig, listCandidates, loadGameContext, loadRecentHooks, loadRevision, loadRunEvidence, loadTeamHistory, markRunResearching, saveRunResult, startRun, type StartOutcome,
} from "./repository";
import { buildStructuredEvidence } from "./structured-evidence";
import type { StoryConfig } from "./types";

// Brohda 2.1 M3 — the use cases: generate a story for one Game, run the scheduled batch, re-verify an Admin edit.
// Research or generation failing NEVER touches the Game, its Market, Picks, comments or Call BS: a run is closed as FAILED with a category and the Game simply has no new story.

export interface ServiceDeps {
  loadConfig: () => Promise<StoryConfig>;
  createDeps: (config: StoryConfig) => PipelineDeps;
  now: () => Date;
}
const defaultDeps: ServiceDeps = { loadConfig: getStoryConfig, createDeps: (c) => createPipelineDeps(c), now: () => new Date() };

export type GenerateResult =
  | { outcome: Exclude<StartOutcome, "started"> }
  | { outcome: "completed"; runId: string; decision: "ACCEPTED" | "REJECTED" | "NO_STORY"; rejectionCode: string | null; total: number | null; saved: string }
  | { outcome: "failed"; runId: string; category: string };

const log = (event: string, data: Record<string, unknown>) => console.info(`[game-stories] ${event}`, JSON.stringify(data));

export async function generateStoryForFixture(input: { fixtureId: string; trigger: "SCHEDULED" | "ADMIN" | "REGENERATE"; adminId?: string | null }, overrides: Partial<ServiceDeps> = {}): Promise<GenerateResult> {
  const deps = { ...defaultDeps, ...overrides };
  const config = await deps.loadConfig();
  if (!config.generationEnabled) return { outcome: "disabled" };
  const started = await startRun(input.fixtureId, input.trigger, input.adminId ?? null);
  if (started.outcome !== "started" || !started.runId) return { outcome: started.outcome as Exclude<StartOutcome, "started"> };
  const runId = started.runId;
  const t0 = Date.now();
  try {
    await markRunResearching(runId);
    const game = await loadGameContext(input.fixtureId);
    if (!game) throw new StoryProviderError("provider_error", "game_context_missing: the Game or its canonical Post no longer exists");
    const now = deps.now();
    const [history, recentHooks] = await Promise.all([loadTeamHistory(game, now), loadRecentHooks()]);
    const pipelineDeps = deps.createDeps(config);
    const structured = buildStructuredEvidence(game, history, now, pipelineDeps.newId);
    const outcome = await runStoryPipeline(pipelineDeps, { game, structured, recentHooks, config });
    const saved = await saveRunResult(runId, buildSavePayload(outcome, Date.now() - t0));
    log("run_completed", { runId, fixtureId: input.fixtureId, decision: outcome.decision, code: outcome.rejectionCode, total: outcome.candidate?.total ?? null, evidence: outcome.evidence.length, candidates: outcome.candidatesConsidered.length, modelCalls: outcome.usage.modelCalls, searchCalls: outcome.usage.searchCalls, ms: Date.now() - t0 });
    return { outcome: "completed", runId, decision: outcome.decision, rejectionCode: outcome.rejectionCode, total: outcome.candidate?.total ?? null, saved };
  } catch (error) {
    const category = error instanceof StoryProviderError ? error.category : "internal_error";
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await failRun(runId, category, detail, Date.now() - t0).catch(() => undefined);
    log("run_failed", { runId, fixtureId: input.fixtureId, category, ms: Date.now() - t0 });
    return { outcome: "failed", runId, category };
  }
}

export interface ScheduledReport {
  enabled: boolean;
  candidates: number;
  results: Array<{ fixtureId: string; outcome: string; decision?: string; code?: string | null }>;
  stoppedForTime: boolean;
}

/** The scheduled batch. A no-op when generation is off (no candidate query, no provider call, no write). Games are processed one at a time within the function's time budget. */
export async function runScheduledStories(options: { budgetMs?: number; perGameMs?: number } = {}, overrides: Partial<ServiceDeps> = {}): Promise<ScheduledReport> {
  const deps = { ...defaultDeps, ...overrides };
  const config = await deps.loadConfig();
  if (!config.generationEnabled) return { enabled: false, candidates: 0, results: [], stoppedForTime: false };
  // One Game is research (up to ~4 min) + angles + draft + verify + score: a Game is started only if a realistic worst case still fits the function's 300 s, otherwise the next tick takes it.
  const budget = options.budgetMs ?? 290_000;
  const perGame = options.perGameMs ?? 150_000;
  const candidates = await listCandidates(config.maxGamesPerRun);
  const started = Date.now();
  const report: ScheduledReport = { enabled: true, candidates: candidates.length, results: [], stoppedForTime: false };
  for (const c of candidates) {
    if (Date.now() - started + perGame > budget) {
      report.stoppedForTime = true;
      break;
    }
    const r = await generateStoryForFixture({ fixtureId: c.fixtureId, trigger: "SCHEDULED" }, overrides);
    report.results.push({ fixtureId: c.fixtureId, outcome: r.outcome, decision: r.outcome === "completed" ? r.decision : undefined, code: r.outcome === "completed" ? r.rejectionCode : r.outcome === "failed" ? r.category : null });
  }
  return report;
}

/** After an Admin edit: extract the claims of the NEW words, verify them against the run's stored evidence, and record the result. The database lifts `requires_verification` only if every claim is SUPPORTED. */
export async function reverifyRevision(revisionId: string, overrides: Partial<ServiceDeps> = {}): Promise<{ result: "verified" | "verification_failed"; detail: string | null }> {
  const deps = { ...defaultDeps, ...overrides };
  const rev = await loadRevision(revisionId);
  if (!rev || !rev.run_id) throw new Error("revision_not_found");
  const config = await deps.loadConfig();
  const game = await loadGameContext(rev.fixture_id);
  if (!game) throw new Error("game_not_found");
  const evidence = await loadRunEvidence(rev.run_id);
  const out = await reverifyEditedText(deps.createDeps(config), { game, hook: rev.hook, body: rev.body, evidence, config });
  const { data, error } = await completeReverification(revisionId, out.claims.map((c, i) => reverificationClaimRow(c, i)));
  if (error) throw error;
  return { result: data as "verified" | "verification_failed", detail: out.rejectionDetail };
}
