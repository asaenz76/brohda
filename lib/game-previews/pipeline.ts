import type { GamePreviewConfig, GamePreviewInput, GamePreviewReason, GamePreviewWriteOutcome } from "./types";
import type { GenerationRunInput } from "./repository";
import { addUsage, emptyUsage, type CandidateFact, type GameIdentity, type GamePreviewProviders, type ProviderUsage } from "./providers/types";
import { validateDraft } from "./validation";

/**
 * Preview generation, one Game at a time: research → candidate facts → angle and draft → validation → (model verification) → saved with its provenance. It is orchestration only: every external action (the providers, the database)
 * is injected, so the whole flow, including its failure modes, is unit-tested without a network. It runs only in the background (the scheduled job or an admin action) — never when a Member opens a Post.
 *
 * What it guarantees: web research happened first and the writer saw only its facts; a draft with a figure, a source or a freshness problem is rejected and the writer is told why (up to the configured number of attempts); nothing
 * unsupported is saved; a failed run leaves the Post exactly as it was (still working, with or without an older Preview); every run, successful or not, is recorded with its usage.
 */
export type GenerationOutcome =
  | { status: "SUCCEEDED"; previewId: string; write: "created" | "refreshed"; hook: string; preview: string; usage: ProviderUsage; attempts: number }
  | { status: "FAILED" | "REJECTED"; error: string; problems: string[]; usage: ProviderUsage; attempts: number };

export interface PipelineDeps {
  config: GamePreviewConfig;
  providers: GamePreviewProviders;
  loadGame(fixtureId: string): Promise<GameIdentity | null>;
  save(input: GamePreviewInput): Promise<{ outcome: GamePreviewWriteOutcome; previewId?: string }>;
  recordRun(run: GenerationRunInput): Promise<void>;
  now(): Date;
}

export interface GenerateRequest {
  fixtureId: string;
  reason: GamePreviewReason;
  trigger: "AUTOMATIC" | "ADMIN";
}

export async function generateGamePreview(deps: PipelineDeps, request: GenerateRequest): Promise<GenerationOutcome> {
  const { config, providers } = deps;
  const startedAt = deps.now().toISOString();
  let usage = emptyUsage();
  let attempts = 0;
  let factsFound = 0;

  const finish = async (outcome: GenerationOutcome, previewId: string | null): Promise<GenerationOutcome> => {
    await deps
      .recordRun({
        fixtureId: request.fixtureId,
        trigger: request.trigger,
        reason: request.reason,
        status: outcome.status,
        provider: config.provider,
        model: config.model,
        attempts,
        searchCalls: usage.searchCalls,
        modelCalls: usage.modelCalls,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        factsFound,
        error: outcome.status === "SUCCEEDED" ? null : outcome.error,
        previewId,
        startedAt,
      })
      .catch(() => undefined); // observability must never turn a finished run into a failure
    return outcome;
  };
  const fail = (error: string, problems: string[] = [], status: "FAILED" | "REJECTED" = "FAILED") => finish({ status, error, problems, usage, attempts }, null);

  // Preconditions: nothing external is called until the configuration allows it.
  if (!config.model.trim()) return fail("model_not_configured");
  if (!config.webSearchEnabled) return fail("web_search_disabled"); // web research is mandatory: with search off there is no generation
  const game = await deps.loadGame(request.fixtureId);
  if (!game) return fail("game_not_eligible");

  // 1. Research: sourced facts about this exact matchup. A failure here ends the run before any writing.
  let facts: CandidateFact[];
  try {
    const research = await providers.research.research(game, { model: config.model, maxSearchCalls: config.maxSearchCallsPerGame, preferredDomains: config.preferredDomains, blockedDomains: config.blockedDomains });
    usage = addUsage(usage, research.usage);
    facts = research.facts;
  } catch (error) {
    return fail(`research_failed: ${(error as Error).message}`);
  }
  factsFound = facts.length;
  if (facts.length === 0) return fail("no_verified_facts");
  if (usage.searchCalls === 0) return fail("research_did_not_search"); // a model that did not actually search is not research

  // 2-4. Angle + draft → validate → verify, with the rejection reasons fed back to the writer.
  let feedback: string[] = [];
  let lastProblems: string[] = [];
  for (attempts = 1; attempts <= config.maxAttempts; attempts++) {
    let draft;
    try {
      draft = await providers.writer.write(game, facts, { model: config.model, maxChars: config.maxChars, hookMaxChars: config.hookMaxChars, feedback });
    } catch (error) {
      return fail(`writer_failed: ${(error as Error).message}`);
    }
    usage = addUsage(usage, draft.usage);

    const checked = validateDraft({ draft: { hook: draft.hook, preview: draft.preview, claims: draft.claims }, facts, game, config, now: deps.now() });
    let problems = checked.problems;
    if (checked.ok && providers.verifier) {
      try {
        const verdict = await providers.verifier.verify(game, draft, facts, { model: config.model });
        usage = addUsage(usage, verdict.usage);
        if (!verdict.supported) problems = verdict.problems.length ? verdict.problems : ["The fact-check found a statement the cited facts do not support."];
      } catch (error) {
        return fail(`verifier_failed: ${(error as Error).message}`);
      }
    }
    if (problems.length > 0) {
      lastProblems = problems;
      feedback = problems;
      continue;
    }

    // 5. Save with provenance: the sources of exactly the facts the draft cites, the claim → fact → source map, and the generation metadata.
    const citedIds = new Set(draft.claims.flatMap((c) => c.factIds));
    const cited = facts.filter((f) => citedIds.has(f.id));
    const sources = cited.map((f) => ({
      url: f.sourceUrl,
      provider: f.sourceProvider,
      title: f.sourceTitle,
      publishedAt: f.publishedAt,
      retrievedAt: f.retrievedAt,
      supports: draft.claims.filter((c) => c.factIds.includes(f.id)).map((c) => c.text).join(" ").slice(0, 500) || null,
      excerpt: f.excerpt,
    }));
    const factById = new Map(facts.map((f) => [f.id, f]));
    const saved = await deps.save({
      fixtureId: request.fixtureId,
      hook: draft.hook,
      body: draft.preview,
      generatedBy: `${providers.writer.name}:${config.model}`,
      reason: request.reason,
      sources,
      claims: draft.claims.map((c) => ({ text: c.text, fact_ids: c.factIds, source_urls: c.factIds.map((id) => factById.get(id)?.sourceUrl).filter((u): u is string => Boolean(u)) })),
      meta: {
        provider: config.provider,
        model: config.model,
        promptVersion: draft.promptVersion,
        research: providers.research.name,
        verifiedByModel: Boolean(providers.verifier),
        attempts,
        trigger: request.trigger,
        facts: cited.map((f) => ({ id: f.id, kind: f.kind, claim: f.claim, sourceUrl: f.sourceUrl })),
        usage,
      },
    });
    if ((saved.outcome === "created" || saved.outcome === "refreshed") && saved.previewId) {
      return finish({ status: "SUCCEEDED", previewId: saved.previewId, write: saved.outcome, hook: draft.hook, preview: draft.preview, usage, attempts }, saved.previewId);
    }
    return fail(`not_saved: ${saved.outcome}`); // e.g. the Game started while it was being written, or the refresh rules said no
  }
  attempts = config.maxAttempts;
  return fail("draft_rejected", lastProblems, "REJECTED");
}
