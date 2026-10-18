import type { GamePreviewConfig, GamePreviewInput, GamePreviewReason, GamePreviewWriteOutcome } from "./types";
import type { GenerationRunInput } from "./repository";
import { addUsage, emptyUsage, type AngleSelection, type CandidateFact, type EditorialAngle, type GameIdentity, type GamePreviewProviders, type ProviderUsage, type ReachedSource } from "./providers/types";
import { angleBasis, chooseAngle, completeAngleFacts, overallScore, validateAngles, validateEditorial } from "./editorial";
import { reconcileFactKind, reconcileSeasonScope, splitUsableFacts, validateDraft } from "./validation";

/**
 * Preview generation, one Game at a time: research → candidate facts → candidate editorial angles, scored → the strongest story → a draft that tells only that story → deterministic provenance validation → deterministic editorial
 * validation → (independent model read) → saved with its provenance. Orchestration only: every external action (the providers, the database) is injected, so the whole flow, including its failure modes, is unit-tested without a network.
 * It runs only in the background (the scheduled job or an admin action) — never when a Member opens a Post.
 *
 * What it guarantees: web research happened first and the writer saw only the facts of the chosen story; a draft with a figure, source, freshness or editorial problem is rejected and the writer is told why (up to the configured number of
 * attempts); nothing unsupported or story-less is saved; a failed run leaves the Post exactly as it was; every run, successful or not, is recorded with its usage AND with what it found and decided, so the editorial quality can be reviewed.
 */
export type GenerationOutcome =
  | { status: "SUCCEEDED"; previewId: string; write: "created" | "refreshed"; hook: string; preview: string; usage: ProviderUsage; attempts: number; details: RunDetails }
  | { status: "FAILED" | "REJECTED"; error: string; problems: string[]; usage: ProviderUsage; attempts: number; details: RunDetails };

export interface AttemptLog {
  attempt: number;
  hook: string;
  preview: string;
  provenanceProblems: string[];
  editorialProblems: string[];
  verifierProblems: string[];
}

/** What a run found and decided — the record the owner reviews. */
export interface RunDetails {
  sources: { reached: number; accepted: number; rejected: number; list: ReachedSource[] };
  /** Every fact the research returned; `excluded` says why one was not allowed to reach the angle or the writer. */
  facts: Array<{ id: string; kind: string; seasonScope: string; category: string; claim: string; excerpt: string | null; sourceUrl: string; publishedAt: string | null; excluded?: string }>;
  /** Facts added to the chosen story because its summary carried a figure they hold. */
  angleFactsAdded: string[];
  angles: AngleSelection["angles"];
  /** What each candidate angle rests on, computed from its facts: CURRENT_SEASON, CURRENT_WITH_HISTORY or HISTORY_ONLY. */
  angleBasis: Record<string, string>;
  selectedAngleId: string | null;
  chosenAngleId: string | null;
  angleOverridden: boolean;
  selectionReason: string | null;
  rejectedAngles: AngleSelection["rejected"];
  attemptsLog: AttemptLog[];
  rewrites: number;
  effort: string;
  webSearchToolVersion: string;
}

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
  const details: RunDetails = {
    sources: { reached: 0, accepted: 0, rejected: 0, list: [] },
    facts: [],
    angleFactsAdded: [],
    angles: [],
    angleBasis: {},
    selectedAngleId: null,
    chosenAngleId: null,
    angleOverridden: false,
    selectionReason: null,
    rejectedAngles: [],
    attemptsLog: [],
    rewrites: 0,
    effort: config.effort,
    webSearchToolVersion: config.webSearchToolVersion,
  };

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
        effort: config.effort,
        toolVersion: config.webSearchToolVersion,
        details: outcome.details as unknown as Record<string, unknown>,
      })
      .catch(() => undefined); // observability must never turn a finished run into a failure
    return outcome;
  };
  const fail = (error: string, problems: string[] = [], status: "FAILED" | "REJECTED" = "FAILED") => finish({ status, error, problems, usage, attempts, details }, null);
  const stage = { model: config.model, effort: config.effort };

  // Preconditions: nothing external is called until the configuration allows it.
  if (!config.model.trim()) return fail("model_not_configured");
  if (!config.webSearchEnabled) return fail("web_search_disabled"); // web research is mandatory: with search off there is no generation
  const game = await deps.loadGame(request.fixtureId);
  if (!game) return fail("game_not_eligible");

  // 1. Research: sourced facts about this exact matchup. A failure here ends the run before any writing.
  let facts: CandidateFact[];
  try {
    const research = await providers.research.research(game, { ...stage, maxSearchCalls: config.maxSearchCallsPerGame, webSearchToolVersion: config.webSearchToolVersion, preferredDomains: config.preferredDomains, blockedDomains: config.blockedDomains });
    usage = addUsage(usage, research.usage);
    facts = research.facts;
    details.sources = { reached: research.sources.length, accepted: research.sources.filter((s) => s.status === "accepted").length, rejected: research.sources.filter((s) => s.status === "rejected").length, list: research.sources.slice(0, 40) };
  } catch (error) {
    return fail(`research_failed: ${(error as Error).message}`);
  }
  facts = reconcileFactKind(reconcileSeasonScope(facts, game)); // an earlier season is never current form, whatever the research called it
  factsFound = facts.length;
  // A fact about the current state needs a dated, recent source; one without it is recorded but never offered to the angle or the writer.
  const { usable, excluded } = splitUsableFacts(facts, config, deps.now());
  const excludedReason = new Map(excluded.map((e) => [e.fact.id, e.reason]));
  details.facts = facts.map((f) => ({ id: f.id, kind: f.kind, seasonScope: f.seasonScope, category: f.category, claim: f.claim, excerpt: f.excerpt, sourceUrl: f.sourceUrl, publishedAt: f.publishedAt, ...(excludedReason.has(f.id) ? { excluded: excludedReason.get(f.id) } : {}) }));
  if (usage.searchCalls === 0) return fail("research_did_not_search"); // a model that did not actually search is not research
  if (facts.length === 0) return fail("no_verified_facts"); // weak research never becomes a manufactured story
  if (usable.length === 0) return fail("no_usable_facts", excluded.map((e) => `Fact ${e.fact.id} was set aside: ${e.reason}.`), "REJECTED");
  facts = usable;

  // 2. Editorial angles: 3-5 candidate stories from the verified facts, scored; the strongest wins, and a records-only fallback never beats a good-enough story.
  let chosen: EditorialAngle;
  try {
    const selection = await providers.angles.selectAngle(game, facts, stage);
    usage = addUsage(usage, selection.usage);
    details.angles = selection.angles;
    details.angleBasis = Object.fromEntries(selection.angles.map((a) => [a.id, angleBasis(a, facts)]));
    details.selectedAngleId = selection.selectedId;
    details.rejectedAngles = selection.rejected;
    const structural = validateAngles(selection, facts);
    if (structural.length > 0) return fail("angle_selection_invalid", structural, "REJECTED");
    const pick = chooseAngle(selection, config.minStoryScore, facts);
    const completed = completeAngleFacts(pick.angle, facts);
    chosen = completed.angle;
    details.angleFactsAdded = completed.added;
    details.chosenAngleId = pick.angle.id;
    details.angleOverridden = pick.overridden;
    details.selectionReason = pick.reason;
  } catch (error) {
    return fail(`angle_selection_failed: ${(error as Error).message}`);
  }

  // 3-5. Draft → provenance validation → editorial validation → verification, with every rejection reason fed back to the writer.
  let feedback: string[] = [];
  let lastProblems: string[] = [];
  for (attempts = 1; attempts <= config.maxAttempts; attempts++) {
    let draft;
    try {
      draft = await providers.writer.write(game, chosen, facts, { ...stage, maxChars: config.maxChars, hookMaxChars: config.hookMaxChars, maxCitedFacts: config.maxCitedFacts, feedback });
    } catch (error) {
      return fail(`writer_failed: ${(error as Error).message}`);
    }
    usage = addUsage(usage, draft.usage);

    const provenance = validateDraft({ draft: { hook: draft.hook, preview: draft.preview, claims: draft.claims }, facts, game, config, now: deps.now() });
    const editorial = validateEditorial({ draft, angle: chosen, config, facts, kickoffUtc: game.kickoffUtc });
    let verifierProblems: string[] = [];
    if (provenance.ok && editorial.length === 0 && providers.verifier) {
      try {
        const verdict = await providers.verifier.verify(game, chosen, draft, facts, stage);
        usage = addUsage(usage, verdict.usage);
        if (!verdict.supported || !verdict.editorialPasses) verifierProblems = verdict.problems.length ? verdict.problems : ["The independent read found a statement the facts do not support, or a draft that is not a story."];
      } catch (error) {
        return fail(`verifier_failed: ${(error as Error).message}`);
      }
    }
    details.attemptsLog.push({ attempt: attempts, hook: draft.hook, preview: draft.preview, provenanceProblems: provenance.problems, editorialProblems: editorial, verifierProblems });
    const problems = [...provenance.problems, ...editorial, ...verifierProblems];
    if (problems.length > 0) {
      lastProblems = problems;
      feedback = problems;
      details.rewrites = attempts;
      continue;
    }

    // Save with provenance: the sources of exactly the cited facts, the claim → fact → source map, and the generation metadata (including what was decided).
    details.rewrites = attempts - 1;
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
        effort: config.effort,
        webSearchToolVersion: config.webSearchToolVersion,
        promptVersion: draft.promptVersion,
        research: providers.research.name,
        verifiedByModel: Boolean(providers.verifier),
        attempts,
        trigger: request.trigger,
        angle: { id: chosen.id, type: chosen.type, basis: angleBasis(chosen, facts), summary: chosen.summary, score: Number(overallScore(chosen.scores).toFixed(2)), overridden: details.angleOverridden },
        candidateAngles: details.angles.map((a) => ({ id: a.id, type: a.type, summary: a.summary, score: Number(overallScore(a.scores).toFixed(2)) })),
        facts: cited.map((f) => ({ id: f.id, kind: f.kind, seasonScope: f.seasonScope, category: f.category, claim: f.claim, sourceUrl: f.sourceUrl })),
        usage,
      },
    });
    if ((saved.outcome === "created" || saved.outcome === "refreshed") && saved.previewId) {
      return finish({ status: "SUCCEEDED", previewId: saved.previewId, write: saved.outcome, hook: draft.hook, preview: draft.preview, usage, attempts, details }, saved.previewId);
    }
    return fail(`not_saved: ${saved.outcome}`); // e.g. the Game started while it was being written, or the refresh rules said no
  }
  attempts = config.maxAttempts;
  return fail("draft_rejected", lastProblems, "REJECTED");
}
