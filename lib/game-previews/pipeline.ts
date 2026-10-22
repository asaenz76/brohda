import type { GamePreviewConfig, GamePreviewInput, GamePreviewReason, GamePreviewWriteOutcome } from "./types";
import type { GenerationRunInput } from "./repository";
import { addUsage, emptyUsage, FACT_SOURCE_TYPES, type NumberRefresh, type AdvisoryKind, type AngleSelection, type CandidateFact, type EditorialAngle, type FactCheck, type GameIdentity, type GamePreviewProviders, type PreviewDraft, type ProviderUsage, type ParseRecovery, type ReachedSource, type ResearchLead, type SourceConflict, type StatusConfirmation } from "./providers/types";
import { angleBasis, chooseAngle, completeAngleFacts, dedupeAngles, orderAnglePrimary, overallScore, sanitizeAngles, validateEditorial } from "./editorial";
import { claimAppearsInText, excerptIssues, domainMatches, domainOf, draftHints, hasPageDate, isCreditablePage, isCurrentPlayerStatus, isEligiblePrimarySource, isSyndicationHost, isTrustedFactSource, isTrustedSource, reconcileSeasonScope, staleNumberCandidates, statusEvidenceIssues, statusMayBeSuperseded, validateDraft, verificationReasons } from "./validation";

/**
 * Preview generation, one Game at a time: research → candidate facts → candidate editorial angles, scored → the strongest story → a draft that tells only that story → deterministic provenance validation → deterministic editorial
 * validation → (independent model read) → saved with its provenance. Orchestration only: every external action (the providers, the database) is injected, so the whole flow, including its failure modes, is unit-tested without a network.
 * It runs only in the background (the scheduled job or an admin action) — never when a Member opens a Post.
 *
 * What it guarantees: web research happened first and the writer saw only the facts of the chosen story; a draft with a figure, source, freshness or editorial problem is rejected and the writer is told why (up to the configured number of
 * attempts); nothing unsupported or story-less is saved; a failed run leaves the Post exactly as it was; every run, successful or not, is recorded with its usage AND with what it found and decided, so the editorial quality can be reviewed.
 */
export type GenerationOutcome =
  | { status: "SUCCEEDED"; previewId: string; write: "created" | "refreshed"; hook: string; preview: string; usage: ProviderUsage; attempts: number; details: RunDetails; runId?: string }
  | { status: "FAILED" | "REJECTED"; error: string; problems: string[]; usage: ProviderUsage; attempts: number; details: RunDetails; runId?: string };

export interface AttemptLog {
  attempt: number;
  hook: string;
  preview: string;
  provenanceProblems: string[];
  editorialProblems: string[];
  verifierProblems: string[];
  /** Editorial-taste findings (deterministic and from the reviewer): recorded, never a reason to reject. */
  advisory: string[];
}

export interface AdvisoryNote {
  attempt: number;
  source: "deterministic" | "reviewer";
  kind: AdvisoryKind | "editorial_rule";
  note: string;
}

/** What a run found and decided — the record the owner reviews. */
export interface RunDetails {
  sources: { reached: number; accepted: number; rejected: number; list: ReachedSource[] };
  /** Every fact the research returned; `excluded` says why one was not allowed to reach the angle or the writer. */
  facts: Array<{ id: string; kind: string; seasonScope: string; category: string; claim: string; excerpt: string | null; sourceType: string; pageContext: string | null; pageSeason: string | null; subjectTeam: string | null; sourceUrl: string; publishedAt: string | null; excluded?: string }>;
  /** Facts added to the chosen story because its summary carried a figure they hold. */
  angleFactsAdded: string[];
  /** Stories whose credited primary source was re-chosen among their own facts (the first-listed fact was not an eligible, current-season source). */
  primaryReordered: string[];
  /** Candidate angles set aside because a stronger angle was the same story (same facts or same kind). */
  angleDuplicatesDropped: Array<{ id: string; keptId: string; reason: string }>;
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
  /** Editorial-taste notes recorded for product analysis (bland story, weak hook, game-note feel, repetitive structure, low conversation, wording). */
  advisoryNotes: AdvisoryNote[];
  /** What blocked drafts, by kind: deterministic safety checks vs the reviewer's categories. */
  blockingCounts: { deterministic: number; reviewer: number; reviewerByCategory: Record<string, number> };
  /** "none": nothing advisory; "kept_rewrite": the advisory rewrite was factually valid and saved; "kept_original": the rewrite was not valid (or no attempt was left) and the earlier valid draft was saved. */
  advisoryRewrite: "none" | "kept_rewrite" | "kept_original";
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
  /** Facts taken out of a story because they did not verify (disputed, unsupported, stale or ambiguous), with why; the story was kept when its central facts stood. */
  factsRemoved: Array<{ angleId: string; factId: string; reason: string }>;
  /** Every story that was prepared, in order: kept, or collapsed and why. The next-best supported story is tried from the research already gathered, before the Game is returned as needs_review. */
  storyAttempts: Array<{ angleId: string; outcome: "used" | "collapsed"; reason?: string }>;
  /** Before READY: the central story, its primary claim(s), the public primary source and the material secondary (if any). */
  centralStory: { angleId: string; summary: string; primaryClaims: string[]; primarySource: string | null; secondarySource: string | null } | null;
  /** Publication dates read from the page itself for the credited sources research left undated. */
  sourceDates: Array<{ url: string; found: string | null }>;
  /** Stories whose central claim first appeared in a lower-trust or republishing source: the search of the trusted domains for the page that carries the same claim, and what it found. */
  creditLookups: Array<{ angleId: string; factId: string; found: string | null; note?: string }>;
  /** Current-state numbers the deterministic freshness check flagged (a relevant Game was completed after their evidence) and what happened to each: confirmed, updated, removed. */
  /** Per story: whether one search was held back for the trusted public-credit lookup (only when the story is supported but lacks an eligible trusted public primary), and whether that search was needed. */
  creditReserve: Array<{ angleId: string; held: boolean }>;
  staleCandidates: Array<{ angleId: string; factId: string; reason: string; outcome?: "confirmed" | "updated" | "removed"; note?: string }>;
  /** Numbers that were replaced by their current value: the old and new claim and the source of the new one. */
  numberRefreshes: Array<{ factId: string; from: string; to: string; source: string }>;
  /** CURRENT PLAYER STATUS gate: every status claim a story rested on, whether its own source qualified (official/trusted AND dated), and what the newest-status search did: qualified (no search needed), confirmed, updated (a newer qualifying report replaced it), removed (unsupported: the designation is not published). */
  /** Structured model answers that were unparseable and needed the one format retry (never a search): the stage, the model, the first parse error, and whether the retry recovered it. */
  parseRecoveries: ParseRecovery[];
  /** The scheduler invocation that asked for this run (null: an Admin run). */
  invocation: { id: string; kind: "INITIAL" | "REFRESH" } | null;
  statusChecks: Array<{ angleId: string; factId: string; claim: string; source: string; publishedAt: string | null; qualifies: boolean; issues: string[]; outcome: "qualified" | "confirmed" | "updated" | "removed" | "left_to_verification"; note?: string; newSource?: string; newPublishedAt?: string | null }>;
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
  recordRun(run: GenerationRunInput): Promise<string | void>;
  now(): Date;
  /** The hooks of recent Previews, for variety. Optional. */
  recentHooks?(): Promise<string[]>;
  /** The publication date a page itself shows (structured page metadata), or null. Optional: used only for the publicly credited sources whose date research did not capture. Never guesses. */
  fetchPublishedDate?(url: string): Promise<string | null>;
}

export interface GenerateRequest {
  fixtureId: string;
  reason: GamePreviewReason;
  trigger: "AUTOMATIC" | "ADMIN";
  /** The authenticated Admin who asked for this run (server context only). Always null for an AUTOMATIC run: automation never pretends to be a person. */
  actorId?: string | null;
  /** The scheduler invocation that asked for this run (scheduled runs only): recorded in the run details so a run can be tied to its invocation. */
  invocation?: { id: string; kind: "INITIAL" | "REFRESH" };
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
    angleDuplicatesDropped: [],
    primaryReordered: [],
    sourceConflicts: [],
    researchLeads: [],
    factVerification: [],
    measurement: { researchSearches: 0, verificationSearches: 0, factsDiscovered: 0, factsSelected: 0, confirmedFromStoredEvidence: 0, confirmedAfterTargetedSearch: 0, needingExtraSearch: 0, disputed: 0, unsupported: 0, retrievalFailed: 0, exceptionFacts: 0, exceptionVerification: false, sourceDisagreement: false, primarySource: null, publicSources: [] },
    exceptionReasons: {},
    advisoryNotes: [],
    blockingCounts: { deterministic: 0, reviewer: 0, reviewerByCategory: {} },
    advisoryRewrite: "none",
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
    factsRemoved: [],
    storyAttempts: [],
    centralStory: null,
    sourceDates: [],
    creditLookups: [],
    staleCandidates: [],
    numberRefreshes: [],
    creditReserve: [],
    statusChecks: [],
    parseRecoveries: [],
    invocation: request.invocation ?? null,
  };

  /** A stage that failed after its one format retry still records what happened. */
  const noteParseFailure = (error: unknown) => {
    const recovery = (error as { recovery?: ParseRecovery }).recovery;
    if (recovery) details.parseRecoveries.push(recovery);
  };
  const finish = async (outcome: GenerationOutcome, previewId: string | null): Promise<GenerationOutcome> => {
    const runId = await deps
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
        actorId: request.trigger === "ADMIN" ? (request.actorId ?? null) : null,
        effort: config.effort,
        toolVersion: config.webSearchToolVersion,
        details: outcome.details as unknown as Record<string, unknown>,
      })
      .catch(() => undefined); // observability must never turn a finished run into a failure
    return typeof runId === "string" ? { ...outcome, runId } : outcome;
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
    details.parseRecoveries.push(...(research.parseRecoveries ?? []));
    facts = research.facts;
    leads = research.leads ?? [];
    // Contract: verify the supplied Game against an official source. A conflict is needs_review with the specific conflict; the system never silently switches Games.
    if (research.gameCheck && !research.gameCheck.confirmed) {
      details.sources = { reached: research.sources.length, accepted: 0, rejected: research.sources.length, list: research.sources.slice(0, 40) };
      return fail("needs_review: game_mismatch", [research.gameCheck.conflict ?? "The research could not confirm the supplied Game against an official source."], "REJECTED");
    }
    details.sourceConflicts = research.conflicts ?? [];
    details.sources = { reached: research.sources.length, accepted: research.sources.filter((s) => s.status === "accepted").length, rejected: research.sources.filter((s) => s.status === "rejected").length, list: research.sources.slice(0, 40) };
  } catch (error) {
    noteParseFailure(error);
    return fail(`research_failed: ${(error as Error).message}`);
  }
  facts = reconcileSeasonScope(facts, game); // a report published before the season began (by the SUPPLIED season identifier) is last season's news
  factsFound = facts.length;
  details.measurement.researchSearches = usage.searchCalls;
  details.measurement.factsDiscovered = facts.length;
  details.facts = facts.map((f) => ({ id: f.id, kind: f.kind, seasonScope: f.seasonScope, category: f.category, claim: f.claim, excerpt: f.excerpt, sourceType: f.sourceType, pageContext: f.pageContext, pageSeason: f.pageSeason, subjectTeam: f.subjectTeam, sourceUrl: f.sourceUrl, publishedAt: f.publishedAt }));
  if (usage.searchCalls === 0) return fail("research_did_not_search"); // a model that did not actually search is not research
  if (facts.length === 0) return fail("no_verified_facts"); // weak research never becomes a manufactured story
  // A current-state fact that is undated or older than the freshness window is not discarded here: it is an EXCEPTION the story must resolve (below). Only its own story is lost if it cannot be.
  const freshness = { now: deps.now(), currentFactMaxAgeHours: config.currentFactMaxAgeHours };
  const factIdSet = new Set(facts.map((f) => f.id));
  leads = leads.map((l) => ({ ...l, factIds: l.factIds.filter((id) => factIdSet.has(id)) })).filter((l) => l.factIds.length > 0);
  details.researchLeads = leads;

  // 2. Editorial angles: 3-5 candidate stories from the facts, scored; the strongest wins, a records-only fallback never beats a good-enough story, and the story must be anchored in a TRUSTED primary source (the first fact of the angle).
  const teams = [game.homeTeam, game.awayTeam];
  const isTrusted = (f: CandidateFact) => isTrustedFactSource(f, teams, config.preferredDomains);
  // Eligible as the story's PRIMARY (publicly credited) source: trusted AND not a betting/odds/picks page. A betting page may only support a fact that is independently verified.
  const isEligiblePrimary = (f: CandidateFact) => isEligiblePrimarySource(f, teams, config.preferredDomains);
  const primaryOf = (angle: EditorialAngle) => facts.find((f) => f.id === angle.factIds[0]);
  let chosen!: EditorialAngle;
  const basisRankOf = (a: EditorialAngle) => (angleBasis(a, facts) === "HISTORY_ONLY" ? 1 : 0);
  /** The stories still to try, best first. The first is the chosen story; the rest are the next-best supported stories from the research already gathered. */
  const queue: EditorialAngle[] = [];
  try {
    const proposed = await providers.angles.selectAngle(game, facts, stage, leads);
    usage = addUsage(usage, proposed.usage);
    const cleaned = sanitizeAngles(proposed, facts);
    if (cleaned.problems.length > 0) {
      details.angles = proposed.angles;
      return fail("angle_selection_invalid", cleaned.problems, "REJECTED");
    }
    const { selection, dropped } = dedupeAngles(cleaned.selection);
    details.angleDuplicatesDropped = dropped;
    details.angles = selection.angles;
    details.angleBasis = Object.fromEntries(selection.angles.map((a) => [a.id, angleBasis(a, facts)]));
    details.selectedAngleId = selection.selectedId;
    details.rejectedAngles = selection.rejected;
    // Each story's public primary source is chosen among its CENTRAL facts (trusted AND readable: evidence may come from anywhere, the credit may not). A story whose central claim has no such source YET is kept: its trusted source may still be found (credit lookup, below).
    const reordered: string[] = [];
    const ordered: EditorialAngle[] = [];
    const credited = new Set<string>();
    for (const a of selection.angles) {
      const o = orderAnglePrimary(a, facts, isEligiblePrimary);
      if (o) {
        credited.add(a.id);
        if (o !== a) reordered.push(a.id);
      }
      ordered.push(o ?? a);
    }
    details.primaryReordered = reordered;
    const pick0 = chooseAngle({ ...selection, angles: ordered }, config.minStoryScore, facts);
    // Prefer a story that is already creditable when it is about as strong as an uncredited one: the lookup costs searches.
    let pick = pick0;
    if (!credited.has(pick0.angle.id)) {
      const alt = ordered.filter((a) => credited.has(a.id) && overallScore(a.scores) >= overallScore(pick0.angle.scores) - 0.5 && basisRankOf(a) <= basisRankOf(pick0.angle)).sort((x, y) => overallScore(y.scores) - overallScore(x.scores))[0];
      if (alt) pick = { ...pick0, angle: alt, overridden: true, reason: `${pick0.reason} A comparably strong story with a trusted, readable source for its central claim was preferred.` };
    }
    details.chosenAngleId = pick.angle.id;
    details.angleOverridden = pick.overridden;
    details.selectionReason = pick.reason;
    // Next-best stories: the other stories that clear the minimum score, creditable and current-season ones first.
    const rest = ordered.filter((a) => a.id !== pick.angle.id && overallScore(a.scores) >= config.minStoryScore).sort((x, y) => Number(credited.has(y.id)) - Number(credited.has(x.id)) || basisRankOf(x) - basisRankOf(y) || overallScore(y.scores) - overallScore(x.scores));
    queue.push(pick.angle, ...rest);
  } catch (error) {
    return fail(`angle_selection_failed: ${(error as Error).message}`);
  }

  // 2b. Prepare a story: sanity-check its evidence, then keep what stands. One trusted source that clearly says what is claimed is enough: nothing is re-researched. Only the EXCEPTIONS (a source outside the trusted group, trusted sources that disagree, a page ambiguous about
  // season/date/team, an unusually surprising claim, no passage, a figure the page cannot place in the season, a stale or undated current-state fact) are verified: evidence first, then one targeted search.
  // A fact that does not verify is REMOVED from the story first. The story is kept when its central facts stand and a trusted, readable source still credits them; otherwise that story collapses and the next-best supported story is tried.
  const confirmed = new Set<string>();
  const dead = new Map<string, string>();
  const freshNumbers = new Set<string>();
  /** Current-player-status facts whose source has been shown to qualify (official/trusted AND dated), directly or through the newest-status search. */
  const statusSettled = new Set<string>();
  let lastCollapse: { code: string; problems: string[] } = { code: "no_trusted_primary_source", problems: [] };
  let hardFailure: GenerationOutcome | null = null;
  /** A story with no creditable central source: one search of the trusted domains for each central claim. A trusted, readable page that states it becomes the central fact (same claim, trusted source); nothing found means the story cannot be credited. */
  const findTrustedCredit = async (angle: EditorialAngle, preferOriginal = false): Promise<EditorialAngle | null> => {
    const finder = providers.factVerifier?.findTrustedSources;
    const left = config.maxSearchCallsPerGame - usage.searchCalls;
    if (!finder || left <= 0 || config.preferredDomains.length === 0) {
      if (preferOriginal) return null; // an optional upgrade (a syndicated copy to its original page): no note, no cost
      details.creditLookups.push({ angleId: angle.id, factId: "*", found: null, note: !finder ? "skipped: no lookup available" : left <= 0 ? "skipped: no searches left under the ceiling" : "skipped: no trusted domains configured" });
      return null;
    }
    const central = (angle.centralFactIds ?? [angle.factIds[0]]).map((id) => facts.find((f) => f.id === id)).filter((f): f is CandidateFact => f !== undefined && (preferOriginal ? isSyndicationHost(f.sourceUrl) : !isEligiblePrimary(f)));
    if (central.length === 0) return null;
    let result;
    try {
      result = await finder.call(providers.factVerifier, game, central, { ...stage, maxSearchCalls: left, webSearchToolVersion: config.webSearchToolVersion, blockedDomains: config.blockedDomains, trustedDomains: config.preferredDomains });
    } catch (error) {
      noteParseFailure(error);
      details.creditLookups.push({ angleId: angle.id, factId: "*", found: null, note: `lookup failed: ${(error as Error).message.slice(0, 300)}` });
      return null; // a failed lookup only means this story cannot be credited; the next-best story is tried
    }
    usage = addUsage(usage, result.usage);
    details.parseRecoveries.push(...(result.parseRecoveries ?? []));
    let factIds = [...angle.factIds];
    let centralIds = [...(angle.centralFactIds ?? [angle.factIds[0]])];
    let any = false;
    for (const { factId, hit } of result.found) {
      const orig = facts.find((f) => f.id === factId);
      details.creditLookups.push({ angleId: angle.id, factId, found: hit?.url ?? null });
      if (!orig || !hit || !isTrustedSource(hit.url, teams, config.preferredDomains) || !isCreditablePage(hit.url, hit.title) || domainMatches(domainOf(hit.url), config.blockedDomains)) continue;
      if (orig.kind === "current" && hit.publishedAt && freshness.now.getTime() - new Date(hit.publishedAt).getTime() > config.currentFactMaxAgeHours * 3_600_000) continue; // an old page does not credit a current-state claim
      // The lookup ENRICHES provenance, it never replaces the evidence that supported the claim: the claim text is the original's, the trusted page is added with its own passage, and the original page and passage stay attached (and the original fact stays in the story) so the writer and the reviewer see both.
      const credited: CandidateFact = {
        ...orig,
        id: `${orig.id}t`,
        sourceUrl: hit.url,
        sourceProvider: hit.provider,
        sourceTitle: hit.title,
        publishedAt: hit.publishedAt,
        dateSource: hit.publishedAt ? "page" : undefined, // the lookup reports the date the PAGE shows
        excerpt: hit.excerpt,
        sourceType: "article",
        pageContext: null,
        pageSeason: null,
        ambiguous: false,
        surprising: false,
        disputed: false,
        originalPublisher: null,
        originalUrl: null,
        alsoSupportedBy: [{ url: orig.sourceUrl, provider: orig.sourceProvider, title: orig.sourceTitle, excerpt: orig.excerpt, publishedAt: orig.publishedAt }, ...(orig.alsoSupportedBy ?? [])],
      };
      facts = [...facts, credited];
      confirmed.add(credited.id); // the claim itself was verified; this page only carries it under a trusted name
      factIds = factIds.flatMap((id) => (id === orig.id ? [credited.id, orig.id] : [id]));
      centralIds = centralIds.map((id) => (id === orig.id ? credited.id : id));
      details.facts.push({ id: credited.id, kind: credited.kind, seasonScope: credited.seasonScope, category: credited.category, claim: credited.claim, excerpt: credited.excerpt, sourceType: credited.sourceType, pageContext: null, pageSeason: null, subjectTeam: credited.subjectTeam, sourceUrl: credited.sourceUrl, publishedAt: credited.publishedAt, relevance: credited.relevance } as RunDetails["facts"][number]);
      any = true;
    }
    return any ? { ...angle, factIds, centralFactIds: centralIds } : null;
  };
  const prepareNextStory = async (): Promise<EditorialAngle | "failed" | null> => {
    while (queue.length > 0) {
      const candidate = queue.shift()!;
      const collapse = (code: string, reason: string) => {
        details.storyAttempts.push({ angleId: candidate.id, outcome: "collapsed", reason });
        lastCollapse = { code, problems: [...(lastCollapse.code === code ? lastCollapse.problems : []), `${candidate.id}: ${reason}`] };
      };
      const alive = (a: EditorialAngle): EditorialAngle => {
        const factIds = a.factIds.filter((id) => !dead.has(id) && facts.some((f) => f.id === id));
        for (const id of a.factIds) if (!factIds.includes(id) && !details.factsRemoved.some((r) => r.angleId === a.id && r.factId === id)) details.factsRemoved.push({ angleId: a.id, factId: id, reason: dead.get(id) ?? "removed" });
        return { ...a, factIds, centralFactIds: (a.centralFactIds ?? [a.factIds[0]]).filter((id) => factIds.includes(id)) };
      };
      let angle = alive(candidate);
      // CREDIT RESERVE. A story that is supported but has no eligible trusted public primary source needs a trusted-credit lookup; hold ONE search for it so research, freshness and verification cannot spend the whole ceiling first. No reserve when the story already has an eligible
      // public primary (the full ceiling stays available), and factual safety wins: verification may always use the last search, in which case the story is returned as needs_review if no lookup is possible afterwards.
      const needsCredit = orderAnglePrimary(angle, facts, isEligiblePrimary) === null && Boolean(providers.factVerifier?.findTrustedSources) && config.preferredDomains.length > 0;
      const reserve = needsCredit ? 1 : 0;
      details.creditReserve.push({ angleId: candidate.id, held: needsCredit });
      const stageBudget = () => {
        const remaining = Math.max(0, config.maxSearchCallsPerGame - usage.searchCalls);
        return Math.max(remaining - reserve, Math.min(remaining, 1));
      };
      // FRESHNESS. A current-state number is a STALE_CANDIDATE when a relevant Game was completed after its evidence. It is refreshed (confirmed, updated to the current value) or removed; a story whose central fact cannot be refreshed collapses, and the next-best story is tried.
      const stale = staleNumberCandidates(facts.filter((f) => angle.factIds.includes(f.id) && !freshNumbers.has(f.id)), game);
      if (stale.length > 0) {
        const staleFacts = stale.map((x) => facts.find((f) => f.id === x.factId)!).filter(Boolean);
        for (const x of stale) details.staleCandidates.push({ angleId: candidate.id, factId: x.factId, reason: x.reason });
        const note = (id: string, outcome: "confirmed" | "updated" | "removed", why: string) => {
          const entry = [...details.staleCandidates].reverse().find((c) => c.factId === id && c.angleId === candidate.id);
          if (entry) Object.assign(entry, { outcome, note: why });
        };
        const refresher = providers.factVerifier?.refreshNumbers;
        const left = config.maxSearchCallsPerGame - usage.searchCalls;
        let results: NumberRefresh[] = [];
        if (refresher && left > 0) {
          try {
            const res = await refresher.call(providers.factVerifier, game, staleFacts, { ...stage, maxSearchCalls: stageBudget(), webSearchToolVersion: config.webSearchToolVersion, blockedDomains: config.blockedDomains });
            usage = addUsage(usage, res.usage);
            details.parseRecoveries.push(...(res.parseRecoveries ?? []));
            results = res.results;
          } catch (error) {
            noteParseFailure(error);
            for (const f of staleFacts) note(f.id, "removed", `refresh failed: ${(error as Error).message.slice(0, 200)}`);
          }
        }
        const latestCompleted = new Date(Math.max(...(game.lastCompleted ?? []).map((c) => new Date(c.completedUtc).getTime()))).toISOString();
        for (const f of staleFacts) {
          const r = results.find((x) => x.factId === f.id);
          if (r?.status === "confirmed") {
            facts = facts.map((x) => (x.id === f.id ? { ...x, asOf: latestCompleted } : x));
            freshNumbers.add(f.id);
            note(f.id, "confirmed", r.note);
          } else if (r?.status === "updated" && r.fact) {
            const replacement: CandidateFact = { ...f, claim: r.fact.claim, excerpt: r.fact.excerpt, sourceUrl: r.fact.sourceUrl, sourceTitle: r.fact.sourceTitle, sourceProvider: r.fact.sourceProvider, publishedAt: r.fact.publishedAt, asOf: r.fact.asOf, asOfLabel: r.fact.asOfLabel, retrievedAt: game.asOf, originalPublisher: null, originalUrl: null, ambiguous: false, surprising: false, disputed: false };
            if (staleNumberCandidates([replacement], game).length > 0) {
              dead.set(f.id, "the refreshed value still predates the latest completed Game");
              note(f.id, "removed", "the refreshed value still predates the latest completed Game");
            } else {
              facts = facts.map((x) => (x.id === f.id ? replacement : x));
              freshNumbers.add(f.id);
              details.numberRefreshes.push({ factId: f.id, from: f.claim, to: replacement.claim, source: replacement.sourceUrl });
              note(f.id, "updated", r.note);
            }
          } else {
            dead.set(f.id, `a current-state number that may be stale (a Game was completed after its evidence) could not be refreshed${r?.note ? `: ${r.note}` : ""}`);
            if (!details.staleCandidates.some((c) => c.factId === f.id && c.angleId === candidate.id && c.outcome)) note(f.id, "removed", r?.note || (refresher ? (left > 0 ? "no current value found" : "no searches left under the ceiling") : "no refresh available"));
          }
        }
        for (const entry of details.facts) if (dead.has(entry.id)) entry.excluded = `stale (${dead.get(entry.id)})`;
        facts = facts.filter((f) => !dead.has(f.id));
        angle = alive(candidate);
      }
      // CURRENT PLAYER STATUS. "Out", "questionable", "expected to return", "starting" ... are true NOW or not, and change by the day: a status claim needs a CURRENT, DATED, TRUSTED source (an official league/team report or a dated report from a trusted outlet).
      // An undated list, a betting page, a live profile page, an untrusted or syndicated copy cannot establish it alone: it is a LEAD. The newest qualifying report is searched for; what it states replaces the claim (confirmed or updated), and a designation no qualifying source
      // states is REMOVED (the story is kept when it stands without it, otherwise the next story is tried). A qualifying but older (more than a day) report is also checked for a newer status when a search is left.
      const statusFacts = facts.filter((f) => angle.factIds.includes(f.id) && !statusSettled.has(f.id) && isCurrentPlayerStatus(f));
      if (statusFacts.length > 0) {
        const log = (f: CandidateFact, issues: string[], outcome: RunDetails["statusChecks"][number]["outcome"], extra: { note?: string; newSource?: string; newPublishedAt?: string | null } = {}) =>
          details.statusChecks.push({ angleId: candidate.id, factId: f.id, claim: f.claim, source: f.sourceUrl, publishedAt: f.publishedAt, qualifies: issues.length === 0, issues, outcome, ...extra });
        const open: Array<{ fact: CandidateFact; issues: string[] }> = [];
        for (const f of statusFacts) {
          const issues = statusEvidenceIssues(f, teams, config.preferredDomains);
          if (issues.length === 0 && !statusMayBeSuperseded(f, freshness.now, config.currentFactMaxAgeHours)) {
            statusSettled.add(f.id);
            log(f, [], "qualified");
          } else open.push({ fact: f, issues });
        }
        let results: StatusConfirmation[] = [];
        const confirmer = providers.factVerifier?.confirmPlayerStatus;
        if (open.length > 0 && confirmer && config.maxSearchCallsPerGame - usage.searchCalls > 0) {
          try {
            const res = await confirmer.call(providers.factVerifier, game, open.map((x) => x.fact), { ...stage, maxSearchCalls: stageBudget(), webSearchToolVersion: config.webSearchToolVersion, blockedDomains: config.blockedDomains });
            usage = addUsage(usage, res.usage);
            details.parseRecoveries.push(...(res.parseRecoveries ?? []));
            results = res.results;
          } catch (error) {
            noteParseFailure(error);
            for (const x of open) log(x.fact, x.issues, "left_to_verification", { note: `status search failed: ${(error as Error).message.slice(0, 200)}` });
          }
        }
        for (const { fact: f, issues } of open) {
          const r = results.find((x) => x.factId === f.id);
          if ((r?.status === "confirmed" || r?.status === "updated") && r.fact) {
            const next: CandidateFact = {
              ...f,
              claim: r.fact.claim,
              excerpt: r.fact.excerpt,
              sourceUrl: r.fact.sourceUrl,
              sourceTitle: r.fact.sourceTitle,
              sourceProvider: r.fact.sourceProvider,
              publishedAt: r.fact.publishedAt,
              dateSource: "page",
              sourceType: r.fact.sourceType && (FACT_SOURCE_TYPES as readonly string[]).includes(r.fact.sourceType) ? r.fact.sourceType : "article",
              pageContext: null,
              pageSeason: null,
              retrievedAt: game.asOf,
              originalPublisher: null,
              originalUrl: null,
              alsoSupportedBy: undefined,
              ambiguous: false,
              surprising: false,
              disputed: false,
              statusKind: "CURRENT_PLAYER_STATUS",
            };
            const nextIssues = [...statusEvidenceIssues(next, teams, config.preferredDomains), ...(domainMatches(domainOf(next.sourceUrl), config.blockedDomains) ? ["the source is on the blocked list"] : [])];
            if (nextIssues.length === 0) {
              // Never trade a qualifying dated report for an OLDER one: the newest credible status wins.
              const older = issues.length === 0 && hasPageDate(f) && new Date(next.publishedAt as string).getTime() < new Date(f.publishedAt as string).getTime();
              if (older) {
                statusSettled.add(f.id);
                log(f, [], "confirmed", { note: "no newer qualifying report found" });
              } else {
                facts = facts.map((x) => (x.id === f.id ? next : x));
                for (const entry of details.facts) if (entry.id === f.id) Object.assign(entry, { claim: next.claim, excerpt: next.excerpt, sourceUrl: next.sourceUrl, publishedAt: next.publishedAt, sourceType: next.sourceType });
                confirmed.add(f.id);
                statusSettled.add(f.id);
                log(f, issues, r.status, { note: r.note, newSource: next.sourceUrl, newPublishedAt: next.publishedAt });
              }
              continue;
            }
            if (issues.length === 0) {
              log(f, [], "left_to_verification", { note: `the newer report does not qualify (${nextIssues[0]})` });
              continue;
            }
            issues.push(`the confirming source does not qualify (${nextIssues[0]})`);
          }
          if (issues.length > 0) {
            dead.set(f.id, `current player status not supported: ${issues[0]}${r?.note ? `; ${r.note}` : ""}`);
            log(f, issues, "removed", { note: r?.note });
          } else {
            log(f, [], "left_to_verification", { note: r?.note || "no newer report found; the report is dated and trusted" });
          }
        }
        for (const entry of details.facts) if (dead.has(entry.id) && !entry.excluded) entry.excluded = `not a supported current status (${dead.get(entry.id)})`;
        facts = facts.filter((f) => !dead.has(f.id));
        angle = alive(candidate);
      }
      const exceptions = facts
        .filter((f) => angle.factIds.includes(f.id) && !confirmed.has(f.id))
        .map((f) => ({ fact: f, reasons: verificationReasons(f, isTrusted(f), freshness) }))
        .filter((x) => x.reasons.length > 0);
      if (exceptions.length > 0) {
        for (const x of exceptions) details.exceptionReasons[x.fact.id] = x.reasons;
        if (!providers.factVerifier) {
          for (const x of exceptions) dead.set(x.fact.id, `needs verification (${x.reasons.join("; ")}) and no verifier is configured`);
        } else {
          let result;
          try {
            result = await providers.factVerifier.verifyFacts(game, exceptions.map((x) => x.fact), { ...stage, maxSearchCalls: stageBudget(), webSearchToolVersion: config.webSearchToolVersion, blockedDomains: config.blockedDomains });
          } catch (error) {
            noteParseFailure(error);
            hardFailure = await fail(`fact_verification_failed: ${(error as Error).message}`);
            return "failed";
          }
          usage = addUsage(usage, result.usage);
          details.parseRecoveries.push(...(result.parseRecoveries ?? []));
          details.factVerification.push({ round: details.factVerification.length + 1, angleId: candidate.id, checks: result.checks });
          const byId = new Map(result.checks.map((c) => [c.factId, c]));
          // A stored passage that was cut off is replaced by the complete passage the targeted search found, so the writer and the reviewer see the support itself.
          for (const c of result.checks) {
            if (c.status === "confirmed" && c.passage && c.passage.trim()) {
              const full = c.passage.trim();
              facts = facts.map((f) => (f.id === c.factId && excerptIssues(f.excerpt).length > 0 ? { ...f, excerpt: full } : f));
            }
          }
          for (const { fact } of exceptions) {
            const check = byId.get(fact.id);
            if (check?.status === "confirmed") confirmed.add(fact.id);
            else dead.set(fact.id, `${check?.status ?? "unsupported"}${check?.note ? `: ${check.note}` : ""}`);
          }
        }
        for (const entry of details.facts) if (dead.has(entry.id)) entry.excluded = `failed verification (${dead.get(entry.id)})`;
        facts = facts.filter((f) => !dead.has(f.id));
        angle = alive(candidate);
      }
      // Does the central story still stand without the removed facts?
      const wantedCentral = candidate.centralFactIds && candidate.centralFactIds.length > 0 ? candidate.centralFactIds : [candidate.factIds[0]];
      if (!wantedCentral.every((id) => angle.factIds.includes(id))) {
        const lost = wantedCentral.filter((id) => !angle.factIds.includes(id));
        collapse(lost.some((id) => dead.get(id)?.startsWith("current player status not supported")) ? "current_status_not_supported" : "story_not_verified", `a central fact did not verify (${lost.map((id) => `${id}: ${dead.get(id) ?? "removed"}`).join("; ")})`);
        continue;
      }
      let ordered = orderAnglePrimary(angle, facts, isEligiblePrimary);
      if (!ordered) {
        // The central claim first appeared in a lower-trust or republishing source. Search the trusted domains for the page that carries the same claim and credit that, before giving the story up.
        const withTrusted = await findTrustedCredit(angle);
        if (withTrusted) {
          angle = withTrusted;
          ordered = orderAnglePrimary(angle, facts, isEligiblePrimary);
        }
      }
      if (!ordered) {
        collapse("no_trusted_primary_source", "no trusted, readable source supports the central claim (the trusted domains were searched where the search budget allowed)");
        continue;
      }
      // A syndicated copy (a trusted publisher's story hosted on Yahoo) is acceptable evidence and credit identity is the original publisher, but the original publisher's own page is preferred for the public link when the approved lookup can find it.
      if (isSyndicationHost(ordered.factIds[0] ? (facts.find((f) => f.id === ordered!.factIds[0])?.sourceUrl ?? "") : "")) {
        const upgraded = await findTrustedCredit({ ...ordered, centralFactIds: [ordered.factIds[0]] }, true);
        if (upgraded) ordered = orderAnglePrimary({ ...upgraded, centralFactIds: upgraded.factIds.slice(0, 1) }, facts, isEligiblePrimary) ?? ordered;
      }
      // A fact added only because it holds a figure must not smuggle in a current-status claim that never passed the status gate.
      const completed = completeAngleFacts(ordered, facts.filter((f) => !isCurrentPlayerStatus(f) || statusSettled.has(f.id) || ordered!.factIds.includes(f.id)));
      details.angleFactsAdded = completed.added;
      details.storyAttempts.push({ angleId: candidate.id, outcome: "used" });
      if (candidate.id !== details.chosenAngleId) {
        details.chosenAngleId = candidate.id;
        details.angleOverridden = true;
        details.selectionReason = `A story before it collapsed (${details.storyAttempts.filter((a) => a.outcome === "collapsed").map((a) => `${a.angleId}: ${a.reason}`).join("; ")}); the next-best supported story was used.`;
      }
      return completed.angle;
    }
    return null;
  };
  const startStory = async (): Promise<"ok" | "failed" | "none"> => {
    const next = await prepareNextStory();
    if (next === "failed") return "failed";
    if (!next) return "none";
    chosen = next;
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
    return "ok";
  };
  const noStory = () => (lastCollapse.code === "story_not_verified" ? fail("story_not_verified", lastCollapse.problems, "REJECTED") : fail(lastCollapse.code, lastCollapse.problems, "REJECTED"));
  {
    const started = await startStory();
    if (started === "failed") return hardFailure!; // fail() already recorded the run
    if (started === "none") return noStory();
  }

  // 3-5. Draft → deterministic safety checks → independent read, with BLOCKING problems fed back for a rewrite. ADVISORY (editorial taste) findings never reject: if a draft is factually valid but has advisory notes, ONE rewrite may use them; the rewrite is
  // saved if it is also valid, otherwise the earlier valid draft is saved. No endless editorial loop.
  const recentHooks = deps.recentHooks ? await deps.recentHooks().catch(() => []) : [];
  let feedback: string[] = [];
  let feedbackKind: "blocking" | "advisory" = "blocking";
  let lastProblems: string[] = [];
  let advisoryRewriteTried = false;
  let fallback: { draft: PreviewDraft; attempt: number } | null = null;
  let writerDeclined: string | null = null;

  const saveDraft = async (draft: PreviewDraft, attemptNo: number, rewrite: RunDetails["advisoryRewrite"]): Promise<GenerationOutcome> => {
    // Save with provenance: the sources of exactly the cited facts, the claim → fact → source map, and the generation metadata (including what was decided).
    details.rewrites = attemptNo - 1;
    details.advisoryRewrite = rewrite;
    const citedIds = new Set(draft.claims.flatMap((c) => c.factIds));
    const primaryFact = primaryOf(chosen);
    // No published Game Preview without a visible, eligible primary source: the primary fact must be cited and its source credible and not a betting page.
    if (!primaryFact || !citedIds.has(primaryFact.id) || !isEligiblePrimary(primaryFact)) return fail("no_public_source", ["The Preview does not rest on an eligible trusted primary source (trusted, and not a betting page), so it has nothing to credit."], "REJECTED");
    const citedFacts = [primaryFact, ...facts.filter((f) => citedIds.has(f.id) && f.id !== primaryFact.id)];
    const byUrl = new Map<string, { fact: CandidateFact; supports: string[] }>();
    for (const f of citedFacts) {
      const entry = byUrl.get(f.sourceUrl) ?? { fact: f, supports: [] };
      entry.supports.push(...draft.claims.filter((c) => c.factIds.includes(f.id)).map((c) => c.text));
      byUrl.set(f.sourceUrl, entry);
    }
    const cited = citedFacts;
    // Public credit: the primary source (it supports the central claim, by construction), and ONE secondary only when it materially supports the story: a trusted, readable source from a different publisher that supports at least one claim the primary does not.
    const claimsCoveredByPrimary = (c: (typeof draft.claims)[number]) => c.factIds.some((id) => facts.find((f) => f.id === id)?.sourceUrl === primaryFact.sourceUrl);
    // Material = backs a claim that is STATED in the public title or caption (a claim kept only in the research metadata does not count) and that the primary does not already back.
    const publicText = `${draft.hook} ${draft.preview}`;
    const secondaryFact = citedFacts.find((f) => f.id !== primaryFact.id && isEligiblePrimary(f) && domainOf(f.sourceUrl) !== domainOf(primaryFact.sourceUrl) && draft.claims.some((c) => c.factIds.includes(f.id) && claimAppearsInText(c.text, publicText) && !claimsCoveredByPrimary(c)));
    const publicSources = [primaryFact, ...(secondaryFact ? [secondaryFact] : [])];
    const publicSourceUrls = [...new Set(publicSources.map((f) => f.sourceUrl))];
    // A publication date research did not capture is read from the page itself (structured page metadata only; never inferred). Null stays null.
    const dates = new Map<string, string | null>();
    for (const f of publicSources) {
      if (f.publishedAt || dates.has(f.sourceUrl)) continue;
      let found: string | null = null;
      try {
        found = deps.fetchPublishedDate ? await deps.fetchPublishedDate(f.sourceUrl) : null;
      } catch {
        found = null;
      }
      dates.set(f.sourceUrl, found);
      details.sourceDates.push({ url: f.sourceUrl, found });
    }
    const dateOf = (f: CandidateFact) => f.publishedAt ?? dates.get(f.sourceUrl) ?? null;
    const sources = [...byUrl.values()].map(({ fact: f, supports }) => ({
      url: f.sourceUrl,
      provider: f.sourceProvider,
      title: f.sourceTitle,
      publishedAt: dateOf(f),
      retrievedAt: f.retrievedAt,
      supports: supports.join(" ").slice(0, 500) || null,
      excerpt: f.excerpt,
    }));
    details.measurement.publicSources = publicSourceUrls;
    details.centralStory = { angleId: chosen.id, summary: chosen.summary, primaryClaims: (chosen.centralFactIds ?? [primaryFact.id]).map((id) => facts.find((f) => f.id === id)?.claim).filter((c): c is string => Boolean(c)), primarySource: primaryFact.sourceUrl, secondarySource: secondaryFact?.sourceUrl ?? null };
    const factById = new Map(facts.map((f) => [f.id, f]));
    // Current player status the Preview states, and when it was last established: the scheduler refreshes a status-bearing Preview as that ages. "As of" is the time the newest-status search confirmed it, or else the date of its dated source.
    const citedStatusFacts = citedFacts.filter((f) => isCurrentPlayerStatus(f));
    const verifiedNewest = new Set(details.statusChecks.filter((c) => c.outcome === "confirmed" || c.outcome === "updated").map((c) => c.factId));
    const statusDates = citedStatusFacts.map((f) => (verifiedNewest.has(f.id) ? deps.now().toISOString() : f.publishedAt)).filter((d): d is string => Boolean(d));
    const statusMeta = { hasStatusClaim: citedStatusFacts.length > 0, asOf: statusDates.length === citedStatusFacts.length && statusDates.length > 0 ? statusDates.sort()[0] : null, claims: citedStatusFacts.map((f) => ({ factId: f.id, claim: f.claim.slice(0, 300), sourceUrl: f.sourceUrl, publishedAt: f.publishedAt, verifiedNewest: verifiedNewest.has(f.id) })) };
    const saved = await deps.save({
      fixtureId: request.fixtureId,
      hook: draft.hook,
      body: draft.preview,
      generatedBy: `${providers.writer.name}:${config.model}`,
      reason: request.reason,
      sources,
      claims: draft.claims.map((c) => ({ text: c.text, fact_ids: c.factIds, source_urls: c.factIds.map((id) => factById.get(id)?.sourceUrl).filter((u): u is string => Boolean(u)), evidence: (c.evidence?.trim() || c.factIds.map((id) => factById.get(id)?.excerpt ?? factById.get(id)?.claim ?? "").filter(Boolean).join(" | ")).slice(0, 500) })),
      meta: {
        provider: config.provider,
        model: config.model,
        effort: config.effort,
        webSearchToolVersion: config.webSearchToolVersion,
        promptVersion: draft.promptVersion,
        research: providers.research.name,
        verifiedByModel: Boolean(providers.verifier),
        attempts: attemptNo,
        trigger: request.trigger,
        angle: { id: chosen.id, type: chosen.type, basis: angleBasis(chosen, facts), summary: chosen.summary, score: Number(overallScore(chosen.scores).toFixed(2)), overridden: details.angleOverridden },
        candidateAngles: details.angles.map((a) => ({ id: a.id, type: a.type, summary: a.summary, score: Number(overallScore(a.scores).toFixed(2)) })),
        facts: cited.map((f) => ({ id: f.id, kind: f.kind, seasonScope: f.seasonScope, category: f.category, claim: f.claim, sourceUrl: f.sourceUrl })),
        primarySourceUrl: primaryFact.sourceUrl,
        publicSourceUrls,
        centralStory: details.centralStory,
        status: statusMeta,
        verification: { exceptionFacts: details.measurement.exceptionFacts, exceptionVerification: details.measurement.exceptionVerification, sourceDisagreement: details.measurement.sourceDisagreement },
        researchedAt: game.asOf,
        season: game.season,
        phase: game.phase,
        advisoryRewrite: rewrite,
        advisoryNotes: details.advisoryNotes.filter((n) => n.attempt === attemptNo).map(({ source, kind, note }) => ({ source, kind, note })),
        usage,
      },
    });
    if ((saved.outcome === "created" || saved.outcome === "refreshed") && saved.previewId) {
      return finish({ status: "SUCCEEDED", previewId: saved.previewId, write: saved.outcome, hook: draft.hook, preview: draft.preview, usage, attempts: attemptNo, details }, saved.previewId);
    }
    return fail(`not_saved: ${saved.outcome}`); // e.g. the Game started while it was being written, or the refresh rules said no
  };

  for (attempts = 1; attempts <= config.maxAttempts; attempts++) {
    let draft: PreviewDraft;
    try {
      draft = await providers.writer.write(game, chosen, facts, { ...stage, maxChars: config.maxChars, maxCitedFacts: config.maxCitedFacts, recentHooks, feedback, feedbackKind });
    } catch (error) {
      return fail(`writer_failed: ${(error as Error).message}`);
    }
    usage = addUsage(usage, draft.usage);
    // The writer may decide no supported story can be written: needs_review with the specific problem, never a manufactured story.
    if (draft.status === "needs_review") {
      // This story collapsed at the writer: try the next-best supported story from the research already gathered (this attempt is spent; the budget is unchanged).
      const reason = draft.reason?.trim() || "The writer could not produce a supported story from the facts.";
      writerDeclined = `${chosen.id}: ${reason}`;
      details.storyAttempts.push({ angleId: chosen.id, outcome: "collapsed", reason: `the writer declined (${reason})` });
      feedback = [];
      feedbackKind = "blocking";
      fallback = null;
      advisoryRewriteTried = false;
      const next = await startStory();
      if (next === "failed") return hardFailure!;
      if (next === "none") return fail("needs_review: no_supported_story", [writerDeclined], "REJECTED");
      lastProblems = [];
      continue;
    }

    const provenance = validateDraft({ draft: { hook: draft.hook, preview: draft.preview, claims: draft.claims }, facts, config });
    const editorial = validateEditorial({ draft, angle: chosen, config });
    const hints = draftHints({ hook: draft.hook, preview: draft.preview, claims: draft.claims }, facts);
    hints.conflicts = details.sourceConflicts.map((c) => ({ topic: c.topic, kind: c.kind ?? "TRUE_CONFLICT", note: c.note }));
    // Status evidence of every cited fact, so the reviewer can see publisher, type, date, trust and whether the source can establish a current status; a status claim whose own source cannot is also a deterministic problem.
    const citedFactIds = new Set(draft.claims.flatMap((c) => c.factIds));
    hints.statusEvidence = facts
      .filter((f) => citedFactIds.has(f.id))
      .map((f) => {
        const issues = statusEvidenceIssues(f, teams, config.preferredDomains);
        return { factId: f.id, statusClaim: isCurrentPlayerStatus(f), publisher: f.sourceProvider, sourceType: f.sourceType, publishedAt: f.publishedAt, trusted: isTrusted(f), qualifies: issues.length === 0, issues };
      });
    for (const e of hints.statusEvidence) if (e.statusClaim && !e.qualifies) { provenance.ok = false; provenance.problems.push(`[status_source_ineligible] Fact ${e.factId} states a player's current status but its source (${e.publisher}) cannot establish one: ${e.issues.join("; ")}. Remove the status or state only what a dated, trusted source supports.`); }
    const reviewerBlocking: string[] = [];
    const reviewerAdvisory: Array<{ kind: AdvisoryKind; note: string }> = [];
    if (provenance.ok && editorial.blocking.length === 0 && providers.verifier) {
      try {
        const verdict = await providers.verifier.verify(game, chosen, draft, facts, stage, hints);
        usage = addUsage(usage, verdict.usage);
        for (const b of verdict.blocking) {
          reviewerBlocking.push(`[${b.category}] ${b.problem}`);
          details.blockingCounts.reviewerByCategory[b.category] = (details.blockingCounts.reviewerByCategory[b.category] ?? 0) + 1;
        }
        reviewerAdvisory.push(...verdict.advisory);
      } catch (error) {
        return fail(`verifier_failed: ${(error as Error).message}`);
      }
    }
    // Without an independent reader nothing can judge whether a number is derived or wrong, so a DIGIT no cited fact contains is treated as blocking (the safe default); with a reader, hints are the reader's to adjudicate.
    if (!providers.verifier) for (const n of hints.figures.filter((f) => /^\d/.test(f))) provenance.problems.push(`The figure "${n}" appears in the title or caption but in none of the cited facts.`);
    const advisoryText = [...editorial.advisory, ...reviewerAdvisory.map((a) => a.note)];
    for (const note of editorial.advisory) details.advisoryNotes.push({ attempt: attempts, source: "deterministic", kind: "editorial_rule", note });
    for (const a of reviewerAdvisory) details.advisoryNotes.push({ attempt: attempts, source: "reviewer", kind: a.kind, note: a.note });
    details.attemptsLog.push({ attempt: attempts, hook: draft.hook, preview: draft.preview, provenanceProblems: provenance.problems, editorialProblems: editorial.blocking, verifierProblems: reviewerBlocking, advisory: advisoryText });
    const blocking = [...provenance.problems, ...editorial.blocking, ...reviewerBlocking];
    details.blockingCounts.deterministic += provenance.problems.length + editorial.blocking.length;
    details.blockingCounts.reviewer += reviewerBlocking.length;

    if (blocking.length > 0) {
      lastProblems = blocking;
      // A rewrite that was meant only to polish a valid draft went wrong: keep the valid one.
      if (fallback) return saveDraft(fallback.draft, fallback.attempt, "kept_original");
      feedback = blocking;
      feedbackKind = "blocking";
      details.rewrites = attempts;
      continue;
    }

    // Factually valid. Advisory notes allow ONE polish rewrite (if an attempt is left); otherwise this draft is saved as it is.
    if (advisoryText.length > 0 && !advisoryRewriteTried && attempts < config.maxAttempts) {
      advisoryRewriteTried = true;
      fallback = { draft, attempt: attempts };
      feedback = advisoryText;
      feedbackKind = "advisory";
      continue;
    }
    return saveDraft(draft, attempts, fallback ? "kept_rewrite" : "none");
  }
  attempts = config.maxAttempts;
  if (fallback) return saveDraft(fallback.draft, fallback.attempt, "kept_original");
  if (writerDeclined && lastProblems.length === 0) return fail("needs_review: no_supported_story", [writerDeclined], "REJECTED");
  return fail("draft_rejected", lastProblems, "REJECTED");
}
