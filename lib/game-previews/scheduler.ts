import type { GenerationOutcome } from "./pipeline";
import type { AutomationCandidate } from "./repository";
import type { AutomationAlert } from "./alerts";
import type { GamePreviewConfig, GamePreviewReason } from "./types";

/**
 * The scheduled automation, orchestration only. It decides WHEN the generation pipeline runs and for WHICH Game; it never decides what is publishable: every run goes through the exact pipeline an Admin run uses (research, fact support, currentness, status, reviewer,
 * attribution, persistence), and the only thing it does with the result is record it. Nothing here publishes anything: "READY" means the normal pipeline saved a Preview.
 *
 * Pure and injectable (no database, no network): the wiring is in automation.ts, and every rule below is unit-tested with fakes.
 */

/** How a finished run is treated. NEEDS_REVIEW (a safe editorial rejection) is a normal outcome, never an incident; TECHNICAL_FAILURE is recorded separately. */
export type RunClass = "READY" | "NEEDS_REVIEW" | "SKIPPED" | "TECHNICAL_FAILURE" | "PROVIDER_CREDIT" | "PROVIDER_AUTH";

const CREDIT = /credit balance is too low|insufficient[_ ]quota|billing|payment required|anthropic_api_402/i;
const AUTH = /anthropic_api_(401|403)\b|authentication_error|permission_error|invalid x-api-key/i;
/** The database or the pipeline said "not this Game, not now": nothing is wrong. */
const BENIGN_NOT_SAVED = /^not_saved: (game_started|frozen|already_exists|not_stale|too_soon|no_existing_preview|fixture_not_found)\b/;

export function classifyOutcome(outcome: GenerationOutcome): { kind: RunClass; detail: string } {
  if (outcome.status === "SUCCEEDED") return { kind: "READY", detail: "" };
  const error = outcome.error ?? "";
  if (CREDIT.test(error)) return { kind: "PROVIDER_CREDIT", detail: error };
  if (AUTH.test(error)) return { kind: "PROVIDER_AUTH", detail: error };
  if (outcome.status === "REJECTED") return { kind: "NEEDS_REVIEW", detail: error };
  if (error === "no_verified_facts") return { kind: "NEEDS_REVIEW", detail: error }; // research found nothing verifiable: an editorial result, not a fault
  if (error === "game_not_eligible" || BENIGN_NOT_SAVED.test(error)) return { kind: "SKIPPED", detail: error };
  return { kind: "TECHNICAL_FAILURE", detail: error };
}

/** The same classification for an exception thrown outside the pipeline's own error handling. */
export function classifyError(error: unknown): { kind: RunClass; detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (CREDIT.test(message)) return { kind: "PROVIDER_CREDIT", detail: message };
  if (AUTH.test(message)) return { kind: "PROVIDER_AUTH", detail: message };
  return { kind: "TECHNICAL_FAILURE", detail: message };
}

export type GenerateResult = { kind: "done"; outcome: GenerationOutcome } | { kind: "busy" } | { kind: "ineligible" };

export interface SchedulerDeps {
  getConfig(): Promise<GamePreviewConfig>;
  /** True when a provider with credentials is configured. */
  isConfigured(config: GamePreviewConfig): boolean;
  listCandidates(): Promise<AutomationCandidate[]>;
  /** Runs ONE Game through the pipeline under the per-Game lease, re-checking eligibility inside it. */
  generate(candidate: AutomationCandidate, config: GamePreviewConfig, invocation: { id: string; kind: "INITIAL" | "REFRESH" }): Promise<GenerateResult>;
  /** Withdraws (never deletes) a status-bearing Preview whose status could not be re-established. Returns whether it was hidden. */
  hide(fixtureId: string, reason: string): Promise<boolean>;
  alert(alert: AutomationAlert): void;
  newId(): string;
  /** Milliseconds, monotonic enough for a time budget. */
  clock(): number;
  /** The platform function limit leaves room for roughly this long; a Game is started only when its expected run time still fits. */
  budgetMs: number;
  /** Expected run time of one Game before any has finished in this invocation. */
  estimateMs: number;
  /** After this many technical failures in a row the invocation stops (repeated provider/system failure). */
  maxConsecutiveTechnicalFailures: number;
}

export interface AutomationGameResult {
  fixtureId: string;
  kind: "INITIAL" | "REFRESH";
  result: RunClass | "BUSY" | "NO_LONGER_ELIGIBLE";
  runId?: string;
  searchCalls: number;
  modelCalls: number;
  error?: string;
  hidden?: boolean;
}

export interface AutomationReport {
  invocationId: string | null;
  /** generation_enabled; also read by Job Health as "feature disabled". */
  enabled: boolean;
  policyEnabled: boolean;
  configured: boolean;
  /** Games inside the lead window, eligible ones, and the ones taken this invocation (at most max_games_per_run). */
  considered: number;
  eligible: number;
  selected: number;
  attempted: number;
  /** READY: the normal pipeline saved a Preview. */
  succeeded: number;
  needsReview: number;
  /** TECHNICAL failures only (a needs_review is not a failure). Job Health reads this field. */
  failed: number;
  skipped: number;
  refreshed: number;
  hidden: number;
  /** Eligible refreshes that were not reached this invocation (cap, time budget or a stop). */
  refreshBacklog: number;
  halted: string | null;
  skippedByReason: Record<string, number>;
  usage: { searchCalls: number; modelCalls: number; inputTokens: number; outputTokens: number; parseRecoveries: number };
  statusBlocks: number;
  staleCurrentBlocks: number;
  games: AutomationGameResult[];
  failures: Array<{ step: string; error: string }>;
}

export const emptyAutomationReport = (over: Partial<AutomationReport> = {}): AutomationReport => ({
  invocationId: null,
  enabled: false,
  policyEnabled: false,
  configured: false,
  considered: 0,
  eligible: 0,
  selected: 0,
  attempted: 0,
  succeeded: 0,
  needsReview: 0,
  failed: 0,
  skipped: 0,
  refreshed: 0,
  hidden: 0,
  refreshBacklog: 0,
  halted: null,
  skippedByReason: {},
  usage: { searchCalls: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, parseRecoveries: 0 },
  statusBlocks: 0,
  staleCurrentBlocks: 0,
  games: [],
  failures: [],
  ...over,
});

/** Reviewer and deterministic blocks the owner wants to see even though the Preview was (correctly) not published. */
function countBlocks(outcome: GenerationOutcome): { status: number; stale: number } {
  const details = outcome.details as unknown as { blockingCounts?: { reviewerByCategory?: Record<string, number> }; attemptsLog?: Array<{ provenanceProblems?: string[] }> };
  const byCategory = details.blockingCounts?.reviewerByCategory ?? {};
  const deterministic = (details.attemptsLog ?? []).flatMap((a) => a.provenanceProblems ?? []).filter((p) => p.startsWith("[status_source_ineligible]")).length;
  return { status: (byCategory.status_source_ineligible ?? 0) + deterministic, stale: byCategory.stale_current ?? 0 };
}

const short = (text: string, n = 300) => text.replace(/\s+/g, " ").slice(0, n);

export async function runScheduledAutomation(deps: SchedulerDeps): Promise<AutomationReport> {
  const config = await deps.getConfig();
  // KILL SWITCH: off means zero work of any kind: no candidate query, no provider, no search, no write.
  if (!config.generationEnabled) return emptyAutomationReport();
  if (!deps.isConfigured(config) || !config.model.trim()) return emptyAutomationReport({ enabled: true, policyEnabled: true });

  const invocationId = deps.newId();
  const startedMs = deps.clock();
  const all = await deps.listCandidates();
  const eligible = all.filter((c) => c.skipReason === null);
  const skippedByReason: Record<string, number> = {};
  for (const c of all) if (c.skipReason) skippedByReason[c.skipReason] = (skippedByReason[c.skipReason] ?? 0) + 1;
  // Deterministic order: a status-bearing Preview that may have gone stale first (its correctness ages), then new Games; each group earliest Game first.
  const ordered = [...eligible].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "REFRESH" ? -1 : 1) || a.scheduledStartUtc.localeCompare(b.scheduledStartUtc) || a.fixtureId.localeCompare(b.fixtureId));
  const selected = ordered.slice(0, Math.max(0, config.maxGamesPerRun));
  const report = emptyAutomationReport({ invocationId, enabled: true, policyEnabled: true, configured: true, considered: all.length, eligible: eligible.length, selected: selected.length, skippedByReason });

  let consecutiveTechnical = 0;
  let longestMs = 0;
  for (const candidate of selected) {
    // Never start a Game the remaining platform time cannot finish.
    const remaining = deps.budgetMs - (deps.clock() - startedMs);
    const expected = Math.max(deps.estimateMs, Math.round(longestMs * 1.25));
    if (remaining < expected) {
      report.halted = report.halted ?? "time_budget";
      break;
    }
    const gameStart = deps.clock();
    const invocation = { id: invocationId, kind: candidate.kind };
    const entry: AutomationGameResult = { fixtureId: candidate.fixtureId, kind: candidate.kind, result: "TECHNICAL_FAILURE", searchCalls: 0, modelCalls: 0 };
    let klass: { kind: RunClass; detail: string };
    try {
      const generated = await deps.generate(candidate, config, invocation);
      if (generated.kind === "busy" || generated.kind === "ineligible") {
        // Someone else (an Admin, another invocation) is generating this Game, or it is no longer a candidate: nothing to do, nothing wrong.
        entry.result = generated.kind === "busy" ? "BUSY" : "NO_LONGER_ELIGIBLE";
        report.skipped += 1;
        report.games.push(entry);
        continue;
      }
      const outcome = generated.outcome;
      klass = classifyOutcome(outcome);
      entry.runId = outcome.runId;
      entry.searchCalls = outcome.usage.searchCalls;
      entry.modelCalls = outcome.usage.modelCalls;
      const details = outcome.details as unknown as { parseRecoveries?: unknown[] };
      report.usage.searchCalls += outcome.usage.searchCalls;
      report.usage.modelCalls += outcome.usage.modelCalls;
      report.usage.inputTokens += outcome.usage.inputTokens;
      report.usage.outputTokens += outcome.usage.outputTokens;
      report.usage.parseRecoveries += details.parseRecoveries?.length ?? 0;
      const blocks = countBlocks(outcome);
      report.statusBlocks += blocks.status;
      report.staleCurrentBlocks += blocks.stale;
      if (blocks.status > 0) deps.alert({ kind: "status_source_blocked", message: "a draft was blocked for a current-status claim without qualifying evidence", context: { fixtureId: candidate.fixtureId, invocationId, blocks: blocks.status } });
      if (blocks.stale > 0) deps.alert({ kind: "stale_current_blocked", message: "a draft was blocked for presenting stale current information", context: { fixtureId: candidate.fixtureId, invocationId, blocks: blocks.stale } });
      if (outcome.status !== "SUCCEEDED" && /format retry did not recover|format retry failed/i.test(outcome.error)) deps.alert({ kind: "json_not_recovered", message: "a structured model answer stayed unparseable after the one format retry", context: { fixtureId: candidate.fixtureId, invocationId } });
    } catch (error) {
      // An exception outside the pipeline's own handling: a technical failure of this Game, never a published Preview.
      klass = classifyError(error);
    }
    report.attempted += 1;
    entry.result = klass.kind;
    if (klass.detail && klass.kind !== "READY") entry.error = short(klass.detail);
    longestMs = Math.max(longestMs, deps.clock() - gameStart);

    if (klass.kind === "READY") {
      report.succeeded += 1;
      if (candidate.kind === "REFRESH") report.refreshed += 1;
      consecutiveTechnical = 0;
    } else if (klass.kind === "NEEDS_REVIEW") {
      report.needsReview += 1;
      consecutiveTechnical = 0;
    } else if (klass.kind === "SKIPPED") {
      report.skipped += 1;
      consecutiveTechnical = 0;
    } else {
      report.failed += 1;
      consecutiveTechnical += 1;
      report.failures.push({ step: `game:${candidate.fixtureId}`, error: `${klass.kind}: ${short(klass.detail, 200)}` });
      deps.alert({ kind: klass.kind === "PROVIDER_CREDIT" ? "provider_credit_exhausted" : klass.kind === "PROVIDER_AUTH" ? "provider_auth_failed" : "technical_failure", message: klass.kind === "PROVIDER_CREDIT" ? "the AI provider reports the credit balance is exhausted; generation stopped for this invocation" : `a scheduled generation failed (${klass.kind})`, context: { fixtureId: candidate.fixtureId, invocationId, error: short(klass.detail, 200) } });
    }

    // A status-bearing Preview whose refresh could not re-establish its status must not keep presenting that status as current: hide it (withdrawn, never deleted), and say why.
    if (candidate.kind === "REFRESH" && klass.kind !== "READY" && klass.kind !== "SKIPPED") {
      const reason = `Automatic status refresh could not re-establish the current player status (${klass.kind}${klass.detail ? `: ${short(klass.detail, 160)}` : ""}); hidden until it can be regenerated.`;
      try {
        if (await deps.hide(candidate.fixtureId, reason)) {
          entry.hidden = true;
          report.hidden += 1;
          report.failures.push({ step: `hidden:${candidate.fixtureId}`, error: "a status-bearing Preview was hidden because its status could not be refreshed" });
          deps.alert({ kind: "refresh_hid_preview", message: "a status-bearing Preview was hidden because its refresh could not verify the current status", context: { fixtureId: candidate.fixtureId, invocationId } });
        }
      } catch (error) {
        report.failures.push({ step: `hide:${candidate.fixtureId}`, error: short(error instanceof Error ? error.message : String(error), 200) });
        deps.alert({ kind: "technical_failure", message: "hiding a stale status-bearing Preview failed", context: { fixtureId: candidate.fixtureId, invocationId } });
      }
    }
    report.games.push(entry);

    // Stop spending provider calls: a credit or authentication failure ends the invocation at once, and so do repeated technical failures. No remaining Game is attempted.
    if (klass.kind === "PROVIDER_CREDIT" || klass.kind === "PROVIDER_AUTH") {
      report.halted = klass.kind === "PROVIDER_CREDIT" ? "provider_credit" : "provider_auth";
      break;
    }
    if (consecutiveTechnical >= deps.maxConsecutiveTechnicalFailures) {
      report.halted = "repeated_technical_failure";
      deps.alert({ kind: "repeated_technical_failure", message: `${consecutiveTechnical} technical failures in a row; generation stopped for this invocation`, context: { invocationId } });
      break;
    }
  }
  report.refreshBacklog = ordered.filter((c) => c.kind === "REFRESH").length - report.games.filter((g) => g.kind === "REFRESH").length;
  return report;
}

/** The pipeline reason a scheduled candidate is written with. */
export const reasonFor = (candidate: Pick<AutomationCandidate, "kind">): GamePreviewReason => (candidate.kind === "INITIAL" ? "MISSING" : "MATERIAL_NEW_INFORMATION");
