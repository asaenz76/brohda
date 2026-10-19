import type { GamePreviewConfig, GamePreviewInput, GamePreviewReason, GamePreviewWriteOutcome } from "./types";
import type { GenerationRunInput } from "./repository";
import { addUsage, emptyUsage, type AngleSelection, type CandidateFact, type EditorialAngle, type FactCheck, type GameIdentity, type GamePreviewProviders, type ProviderUsage, type ReachedSource, type ResearchLead, type SourceConflict } from "./providers/types";
import { angleBasis, chooseAngle, completeAngleFacts, overallScore, validateAngles, validateEditorial } from "./editorial";
import { domainOf, isTrustedSource, reconcileFactKind, reconcileSeasonScope, splitUsableFacts, validateDraft, verificationReasons } from "./validation";

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
  facts: Array<{ id: string; kind: string; seasonScope: string; category: string; claim: string; excerpt: string | null; sourceType: string; pageContext: string | null; pageSeason: string | null; subjectTeam: string | null; sourceUrl: string; publishedAt: string | null; excluded?: string }>;
  /** Facts added to the chosen story because its summary carried a figure they hold. */
  angleFactsAdded: string[];
  /** Authoritative sources that disagreed during research (the disputed figure is not used when the story can be told without it). */
  sourceConflicts: SourceConflict[];
  /** What research noticed around the Game, as hints for the angle stage. */
  researchLeads: ResearchLead[];
  /** The independent re-check of the chosen story's facts, per round (a failed fact removes that story; the next-best story is checked). */
  factVerification: Array<{ round: number; angleId: string; checks: FactCheck[] }>;
  /** Pilot measurement: where the searches went, and how the selected story's facts were settled (from stored evidence vs an extra search vs not at all). */
  measurement: {
    researchSearches: number;
    verificationSearches: number;
    factsDiscovered: number;
    factsSelected: number;
    confirmedFromStoredEvidence: number;
    confirmedAfterTargetedSearch: number;
    needingExtraSearch: number;
    disputed: number;
    unsupported: number;
    retrievalFailed: number;
    /** How many of the story's facts were exceptions (untrusted source, flagged ambiguous/surprising/disputed, no passage, season unplaceable) and so needed extra verification. */
    exceptionFacts: number;
    exceptionVerification: boolean;
    sourceDisagreement: boolean;
    primarySource: string | null;
    /** The source(s) credited publicly under the Preview. */
    publicSources: string[];
  };
  /** Why each exception fact needed extra verification. */
  exceptionReasons: Record<string, string[]>;
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

/**
 * The search ceiling is for the WHOLE generation (research + fact check). When facts are independently verified, a third of the ceiling (rounded down: 2 of 6) is held back from research so the check can actually search for the exact claims;
 * whatever research does not use rolls over to it. Without the reserve a research pass that uses every search leaves the check to judge from excerpts alone, and it (correctly) cannot confirm what it cannot see.
 */
export function verificationReserve(ceiling: number, verifying: boolean): number {
  return verifying ? Math.floor(Math.max(0, ceiling) / 3) : 0;
}

export interface PipelineDeps {
  config: GamePreviewConfig;
  providers: GamePreviewProviders;
  loadGame(fixtureId: string): Promise<GameIdentity | null>;
  save(input: GamePreviewInput): Promise<{ outcome: GamePreviewWriteOutcome; previewId?: string }>;
  recordRun(run: GenerationRunInput): Promise<void>;
  now(): Date;
  /** The hooks of recent Previews, for variety. Optional. */
  recentHooks?(): Promise<string[]>;
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
    sourceConflicts: [],
    researchLeads: [],
    factVerification: [],
    measurement: { researchSearches: 0, verificationSearches: 0, factsDiscovered: 0, factsSelected: 0, confirmedFromStoredEvidence: 0, confirmedAfterTargetedSearch: 0, needingExtraSearch: 0, disputed: 0, unsupported: 0, retrievalFailed: 0, exceptionFacts: 0, exceptionVerification: false, sourceDisagreement: false, primarySource: null, publicSources: [] },
    exceptionReasons: {},
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
  let leads: ResearchLead[] = [];
  try {
    const research = await providers.research.research(game, { ...stage, maxSearchCalls: config.maxSearchCallsPerGame - verificationReserve(config.maxSearchCallsPerGame, Boolean(providers.factVerifier)), webSearchToolVersion: config.webSearchToolVersion, preferredDomains: config.preferredDomains, blockedDomains: config.blockedDomains });
    usage = addUsage(usage, research.usage);
    facts = research.facts;
    leads = research.leads ?? [];
    details.sourceConflicts = research.conflicts ?? [];
    details.sources = { reached: research.sources.length, accepted: research.sources.filter((s) => s.status === "accepted").length, rejected: research.sources.filter((s) => s.status === "rejected").length, list: research.sources.slice(0, 40) };
  } catch (error) {
    return fail(`research_failed: ${(error as Error).message}`);
  }
  facts = reconcileFactKind(reconcileSeasonScope(facts, game)); // an earlier season is never current form, whatever the research called it
  factsFound = facts.length;
  details.measurement.researchSearches = usage.searchCalls;
  details.measurement.factsDiscovered = facts.length;
  // A fact about the current state needs a dated, recent source; one without it is recorded but never offered to the angle or the writer.
  const { usable, excluded } = splitUsableFacts(facts, config, deps.now());
  const excludedReason = new Map(excluded.map((e) => [e.fact.id, e.reason]));
  details.facts = facts.map((f) => ({ id: f.id, kind: f.kind, seasonScope: f.seasonScope, category: f.category, claim: f.claim, excerpt: f.excerpt, sourceType: f.sourceType, pageContext: f.pageContext, pageSeason: f.pageSeason, subjectTeam: f.subjectTeam, sourceUrl: f.sourceUrl, publishedAt: f.publishedAt, ...(excludedReason.has(f.id) ? { excluded: excludedReason.get(f.id) } : {}) }));
  if (usage.searchCalls === 0) return fail("research_did_not_search"); // a model that did not actually search is not research
  if (facts.length === 0) return fail("no_verified_facts"); // weak research never becomes a manufactured story
  if (usable.length === 0) return fail("no_usable_facts", excluded.map((e) => `Fact ${e.fact.id} was set aside: ${e.reason}.`), "REJECTED");
  facts = usable;
  const usableIds = new Set(usable.map((f) => f.id));
  leads = leads.map((l) => ({ ...l, factIds: l.factIds.filter((id) => usableIds.has(id)) })).filter((l) => l.factIds.length > 0);
  details.researchLeads = leads;

  // 2. Editorial angles: 3-5 candidate stories from the facts, scored; the strongest wins, a records-only fallback never beats a good-enough story, and the story must be anchored in a TRUSTED primary source (the first fact of the angle).
  const teams = [game.homeTeam, game.awayTeam];
  const isTrusted = (f: CandidateFact) => isTrustedSource(f.sourceUrl, teams, config.preferredDomains);
  const primaryOf = (angle: EditorialAngle) => facts.find((f) => f.id === angle.factIds[0]);
  const hasTrustedPrimary = (angle: EditorialAngle) => {
    const f = primaryOf(angle);
    return Boolean(f && isTrusted(f));
  };
  let chosen: EditorialAngle;
  let selectionResult: AngleSelection;
  try {
    const selection = await providers.angles.selectAngle(game, facts, stage, leads);
    selectionResult = selection;
    usage = addUsage(usage, selection.usage);
    details.angles = selection.angles;
    details.angleBasis = Object.fromEntries(selection.angles.map((a) => [a.id, angleBasis(a, facts)]));
    details.selectedAngleId = selection.selectedId;
    details.rejectedAngles = selection.rejected;
    const structural = validateAngles(selection, facts);
    if (structural.length > 0) return fail("angle_selection_invalid", structural, "REJECTED");
    const trustedAngles = selection.angles.filter(hasTrustedPrimary);
    if (trustedAngles.length === 0) return fail("no_trusted_primary_source", ["No candidate story rests on a primary source from the trusted group (the approved league, ESPN, FOX Sports, established reporting or team sites)."], "REJECTED");
    const selectedStands = trustedAngles.some((a) => a.id === selection.selectedId);
    const pick = chooseAngle({ ...selection, angles: trustedAngles, selectedId: selectedStands ? selection.selectedId : [...trustedAngles].sort((x, y) => overallScore(y.scores) - overallScore(x.scores))[0].id, selectionReason: selectedStands ? selection.selectionReason : "The first choice's primary source is not in the trusted group; the strongest story with a trusted primary source was chosen." }, config.minStoryScore, facts);
    const completed = completeAngleFacts(pick.angle, facts);
    chosen = completed.angle;
    details.angleFactsAdded = completed.added;
    details.chosenAngleId = pick.angle.id;
    details.angleOverridden = pick.overridden || !selectedStands;
    details.selectionReason = pick.reason;
  } catch (error) {
    return fail(`angle_selection_failed: ${(error as Error).message}`);
  }

  // 2b. Sanity-check the story's evidence. One trusted source that clearly says what is claimed is enough: nothing is re-researched. Only the EXCEPTIONS — a source outside the trusted group, trusted sources that disagree, a page ambiguous about season/date/team,
  // an unusually surprising claim, no passage showing the source says it, a figure the page cannot place in the current season — are verified (evidence first, then one targeted search). A fact that does not verify takes its story with it; the next story with a
  // trusted primary source is checked; if none stands the run is rejected. Without a verifier an exception cannot be resolved, so it rejects the story.
  const confirmed = new Set<string>();
  const dead = new Map<string, string>();
  for (let round = 1; round <= 2; round++) {
    const exceptions = facts
      .filter((f) => chosen.factIds.includes(f.id) && !confirmed.has(f.id))
      .map((f) => ({ fact: f, reasons: verificationReasons(f, isTrusted(f)) }))
      .filter((x) => x.reasons.length > 0);
    if (exceptions.length === 0) break;
    for (const x of exceptions) details.exceptionReasons[x.fact.id] = x.reasons;
    if (!providers.factVerifier) return fail("story_not_verified", exceptions.map((x) => `Fact ${x.fact.id} needs verification (${x.reasons.join("; ")}) and no verifier is configured.`), "REJECTED");
    let result;
    try {
      result = await providers.factVerifier.verifyFacts(game, exceptions.map((x) => x.fact), { ...stage, maxSearchCalls: Math.max(0, config.maxSearchCallsPerGame - usage.searchCalls), webSearchToolVersion: config.webSearchToolVersion, blockedDomains: config.blockedDomains });
    } catch (error) {
      return fail(`fact_verification_failed: ${(error as Error).message}`);
    }
    usage = addUsage(usage, result.usage);
    details.factVerification.push({ round, angleId: chosen.id, checks: result.checks });
    const byId = new Map(result.checks.map((c) => [c.factId, c]));
    for (const { fact } of exceptions) {
      const check = byId.get(fact.id);
      if (check?.status === "confirmed") confirmed.add(fact.id);
      else dead.set(fact.id, `${check?.status ?? "unsupported"}${check?.note ? `: ${check.note}` : ""}`);
    }
    const failed = chosen.factIds.filter((id) => dead.has(id));
    if (failed.length === 0) break;
    for (const entry of details.facts) if (dead.has(entry.id)) entry.excluded = `failed verification (${dead.get(entry.id)})`;
    facts = facts.filter((f) => !dead.has(f.id));
    // "Remove it or choose another story": a story that lost a fact is no longer the story that was scored, so it is set aside whole.
    const standing = selectionResult.angles.filter((a) => a.factIds.every((id) => !dead.has(id)) && hasTrustedPrimary(a));
    if (standing.length === 0) return fail("story_not_verified", failed.map((id) => `Fact ${id} did not verify: ${dead.get(id)}`), "REJECTED");
    const best = [...standing].sort((x, y) => overallScore(y.scores) - overallScore(x.scores))[0];
    const pick = chooseAngle({ angles: standing, selectedId: best.id, selectionReason: "The first choice had a fact that did not verify; the strongest story whose facts stand was chosen." }, config.minStoryScore, facts);
    chosen = completeAngleFacts(pick.angle, facts).angle;
    details.chosenAngleId = pick.angle.id;
    details.angleOverridden = true;
    details.selectionReason = pick.reason;
  }
  {
    const unresolved = facts.filter((f) => chosen.factIds.includes(f.id) && !confirmed.has(f.id) && verificationReasons(f, isTrusted(f)).length > 0);
    if (unresolved.length > 0) return fail("story_not_verified", unresolved.map((f) => `Fact ${f.id} was not verified.`), "REJECTED");
    const all = details.factVerification.flatMap((v) => v.checks);
    const m = details.measurement;
    m.factsSelected = chosen.factIds.length;
    m.exceptionFacts = Object.keys(details.exceptionReasons).length;
    m.exceptionVerification = all.length > 0;
    m.sourceDisagreement = details.sourceConflicts.length > 0 || facts.some((f) => chosen.factIds.includes(f.id) && f.disputed) || all.some((c) => c.status === "disputed");
    m.confirmedFromStoredEvidence = all.filter((c) => c.status === "confirmed" && c.basis === "stored_evidence").length;
    m.confirmedAfterTargetedSearch = all.filter((c) => c.status === "confirmed" && c.basis === "targeted_search").length;
    m.needingExtraSearch = all.filter((c) => c.basis === "targeted_search" || c.basis === "none").length;
    m.disputed = all.filter((c) => c.status === "disputed").length;
    m.unsupported = all.filter((c) => c.status === "unsupported").length;
    m.retrievalFailed = all.filter((c) => c.retrievalFailed).length;
    m.verificationSearches = usage.searchCalls - m.researchSearches;
    m.primarySource = primaryOf(chosen)?.sourceUrl ?? null;
  }

  // 3-5. Draft → provenance validation → editorial validation → verification, with every rejection reason fed back to the writer.
  const recentHooks = deps.recentHooks ? await deps.recentHooks().catch(() => []) : [];
  let feedback: string[] = [];
  let lastProblems: string[] = [];
  for (attempts = 1; attempts <= config.maxAttempts; attempts++) {
    let draft;
    try {
      draft = await providers.writer.write(game, chosen, facts, { ...stage, maxChars: config.maxChars, hookMaxChars: config.hookMaxChars, maxCitedFacts: config.maxCitedFacts, recentHooks, feedback });
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
    const primaryFact = primaryOf(chosen);
    // No published Game Preview without a visible, trusted primary source: the primary fact must be cited and its source credible.
    if (!primaryFact || !citedIds.has(primaryFact.id) || !isTrusted(primaryFact)) return fail("no_public_source", ["The Preview does not rest on a trusted primary source, so it has nothing to credit."], "REJECTED");
    const citedFacts = [primaryFact, ...facts.filter((f) => citedIds.has(f.id) && f.id !== primaryFact.id)];
    const byUrl = new Map<string, { fact: CandidateFact; supports: string[] }>();
    for (const f of citedFacts) {
      const entry = byUrl.get(f.sourceUrl) ?? { fact: f, supports: [] };
      entry.supports.push(...draft.claims.filter((c) => c.factIds.includes(f.id)).map((c) => c.text));
      byUrl.set(f.sourceUrl, entry);
    }
    const cited = citedFacts;
    const sources = [...byUrl.values()].map(({ fact: f, supports }) => ({
      url: f.sourceUrl,
      provider: f.sourceProvider,
      title: f.sourceTitle,
      publishedAt: f.publishedAt,
      retrievedAt: f.retrievedAt,
      supports: supports.join(" ").slice(0, 500) || null,
      excerpt: f.excerpt,
    }));
    // Public credit: the primary source, and a second only when the story materially depends on a trusted source from a different publisher.
    const publicSources = [primaryFact, ...citedFacts.filter((f) => f.id !== primaryFact.id && isTrusted(f) && domainOf(f.sourceUrl) !== domainOf(primaryFact.sourceUrl))].slice(0, 2);
    const publicSourceUrls = [...new Set(publicSources.map((f) => f.sourceUrl))];
    details.measurement.publicSources = publicSourceUrls;
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
        primarySourceUrl: primaryFact.sourceUrl,
        publicSourceUrls,
        verification: { exceptionFacts: details.measurement.exceptionFacts, exceptionVerification: details.measurement.exceptionVerification, sourceDisagreement: details.measurement.sourceDisagreement },
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
