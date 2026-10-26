// Brohda 2.1 M3 — the orchestrator. Pure with respect to I/O: every provider and clock is injected, so each failure mode is unit-testable with fakes and no network.
//
//   Game → structured facts (deterministic) + web research → normalise/quarantine/dedupe/resolve contradictions → candidate angles → for each angle (bounded):
//   draft → copy rules → atomic claims → deterministic verification → model verification → model scoring → Brohda caps + arithmetic → threshold → accept/reject.
//
// Order is deliberate: cheap deterministic gates first, so no model call is spent on a candidate that is already disqualified. A candidate with ANY unsupported claim is rejected whatever its score.
import { verifyClaimsDeterministic, findUnclaimedFacts } from "./claims";
import { mergeStructured, normalizeEvidence, type NormalizeStats } from "./evidence";
import { checkCopyRules } from "./rules";
import { applyCaps, totalOf, validateDimensions } from "./scoring";
import {
  addUsage, emptyUsage,
  type Angle, type CandidateAssessment, type ClaimResult, type DraftClaim, type EvidenceItem, type GameContext, type ModelClaimVerdict, type ProviderUsage, type RejectionCode, type ResearchContext,
  type RunOutcome, type StoryAngleProvider, type StoryConfig, type StoryDraftProvider, type StoryResearchProvider, type StoryScorerProvider, type StoryVerifierProvider,
} from "./types";

export interface PipelineDeps {
  research: StoryResearchProvider | null;
  angles: StoryAngleProvider;
  drafter: StoryDraftProvider;
  verifier: StoryVerifierProvider;
  scorer: StoryScorerProvider;
  newId: () => string;
  now: () => Date;
}

export interface PipelineInput {
  game: GameContext;
  structured: EvidenceItem[];
  recentHooks: string[];
  config: StoryConfig;
}

/** Fewer usable facts than this cannot carry a verified story: the run ends as NO STORY without spending a drafting call. */
export const MIN_USABLE_EVIDENCE = 2;

const codeForVerdict = (v: ModelClaimVerdict["verdict"]): RejectionCode => (v === "CONTRADICTED" ? "CONTRADICTED_CLAIM" : "UNSUPPORTED_CLAIM");

/** Claim ids are always Brohda's: a model-supplied id could collide or reference another run. */
export function sanitizeClaims(claims: readonly DraftClaim[], newId: () => string): DraftClaim[] {
  return claims
    .filter((c) => c && typeof c.text === "string" && c.text.trim())
    .map((c) => ({
      id: newId(),
      text: c.text.trim().slice(0, 400),
      type: c.type,
      subjectTeam: c.subjectTeam ?? null,
      evidenceIds: [...new Set((c.evidenceIds ?? []).filter((x) => typeof x === "string"))],
      availabilityStatus: c.availabilityStatus ?? null,
      quote: c.quote && c.quote.text ? { text: c.quote.text.trim().slice(0, 400), speaker: (c.quote.speaker ?? "").trim().slice(0, 100) } : null,
    }));
}

const mergeModelVerdicts = (results: ClaimResult[], verdicts: readonly ModelClaimVerdict[]): ClaimResult[] => {
  const byId = new Map(verdicts.map((v) => [v.claimId, v]));
  return results.map((r) => {
    if (!r.deterministicOk) return r;
    const v = byId.get(r.claim.id);
    if (!v) return { ...r, verdict: "UNSUPPORTED", modelVerdict: "MISSING", note: "The independent verifier returned no verdict for this claim.", code: "UNSUPPORTED_CLAIM" };
    if (v.verdict === "SUPPORTED") return { ...r, modelVerdict: "SUPPORTED", note: v.note || r.note };
    return { ...r, verdict: v.verdict === "CONTRADICTED" ? "CONTRADICTED" : "UNSUPPORTED", modelVerdict: v.verdict, note: v.note || `The independent verifier judged the claim ${v.verdict.toLowerCase()}.`, code: codeForVerdict(v.verdict) };
  });
};

export interface AssessInput {
  game: GameContext;
  hook: string;
  body: string;
  angle: Angle;
  claims: DraftClaim[];
  evidence: EvidenceItem[];
  recentHooks: string[];
  config: StoryConfig;
  /** When false, the candidate is verified but not scored (re-verification of an Admin edit). */
  score: boolean;
}

/** Everything that decides a candidate, in order. Returns the assessment; the first failing gate sets the rejection code. */
export async function assessCandidate(deps: Pick<PipelineDeps, "verifier" | "scorer" | "now">, input: AssessInput, ctx: ResearchContext, usage: { value: ProviderUsage }): Promise<CandidateAssessment> {
  const { game, hook, body, angle, claims, evidence, config } = input;
  const base: CandidateAssessment = { draft: { hook, body, claims }, angle, claims: [], dims: null, total: null, capsApplied: [], rejectionCode: null, rejectionDetail: null, modelRationale: null };
  const reject = (a: CandidateAssessment, code: RejectionCode, detail: string): CandidateAssessment => ({ ...a, rejectionCode: a.rejectionCode ?? code, rejectionDetail: a.rejectionDetail ?? detail });
  let a = base;

  // 1. copy rules (length, wrong Game, betting, extra propositions, links, filler, safety)
  for (const v of checkCopyRules(hook, body, config, game)) a = reject(a, v.code, v.detail);

  // 2. atomic claims exist; deterministic verification; coverage of every figure/name in the copy
  if (claims.length === 0) a = reject(a, "UNSUPPORTED_CLAIM", "The story lists no factual claims, so none of it can be verified.");
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));
  let results = verifyClaimsDeterministic(claims, evidence, { game, config, now: deps.now() });
  const firstBad = results.find((r) => !r.deterministicOk);
  if (firstBad) a = reject(a, firstBad.code ?? "UNSUPPORTED_CLAIM", firstBad.note);
  const unclaimed = findUnclaimedFacts(hook, body, claims, game);
  if (unclaimed.length) a = reject(a, "UNCLAIMED_FACT", `The copy states ${unclaimed.slice(0, 5).join(", ")} but no claim covers it.`);
  a = { ...a, claims: results };
  if (a.rejectionCode) return a; // disqualified: no model call is spent on it

  // 3. independent model verification (can only make a verdict stricter)
  const verified = await deps.verifier.verifyClaims(game, claims, evidence, ctx);
  usage.value = addUsage(usage.value, verified.usage);
  results = mergeModelVerdicts(results, verified.verdicts);
  a = { ...a, claims: results };
  const modelBad = results.find((r) => r.verdict !== "SUPPORTED");
  if (modelBad) return reject(a, modelBad.code ?? "UNSUPPORTED_CLAIM", modelBad.note);
  if (!input.score) return a;

  // 4. scoring: the model proposes, Brohda validates, caps and adds up
  const scored = await deps.scorer.score(game, { hook, body, claims }, evidence, ctx);
  usage.value = addUsage(usage.value, scored.usage);
  a = { ...a, modelRationale: scored.score.rationale?.slice(0, 600) ?? null };
  if (scored.score.safetyFlags.length) return reject(a, scored.score.safetyFlags.some((f) => /gambl|bet/i.test(f)) ? "GAMBLING_COPY" : "UNSAFE_CONTENT", `The scorer flagged: ${scored.score.safetyFlags.join(", ")}.`);
  const valid = validateDimensions(scored.score.dims);
  if (!valid.ok) return reject(a, "INVALID_SCORE", valid.detail);
  const capped = applyCaps(valid.dims, { claims: results, evidenceById, hook, recentHooks: input.recentHooks, now: deps.now(), modelFlaggedGeneric: scored.score.generic });
  const total = totalOf(capped.dims);
  a = { ...a, dims: capped.dims, total, capsApplied: capped.caps };
  if (scored.score.generic) return reject(a, "GENERIC_FILLER", "The scorer judged the copy generic: it says nothing specific about this matchup.");
  if (total < config.minScore) return reject(a, "LOW_SCORE", `Score ${total} is below the minimum ${config.minScore}.`);
  return a;
}

/** A failed run still costs money: whatever a provider call fails after earlier calls succeeded, the usage so far travels with the error (`partialUsage`) so the run records it. */
export async function runStoryPipeline(deps: PipelineDeps, input: PipelineInput): Promise<RunOutcome> {
  const usage = { value: emptyUsage() };
  try {
    return await runStoryPipelineInner(deps, input, usage);
  } catch (error) {
    if (error && typeof error === "object") (error as { partialUsage?: ProviderUsage }).partialUsage = usage.value;
    throw error;
  }
}

async function runStoryPipelineInner(deps: PipelineDeps, input: PipelineInput, usage: { value: ProviderUsage }): Promise<RunOutcome> {
  const { game, config } = input;
  const ctx: ResearchContext = { config, now: deps.now() };
  const details: Record<string, unknown> = { stages: {} };
  const stage = (name: string, started: number) => ((details.stages as Record<string, number>)[name] = Date.now() - started);
  const finish = (partial: Omit<RunOutcome, "usage" | "details" | "queriesUsed"> & { queriesUsed?: number }): RunOutcome => ({ queriesUsed: 0, ...partial, usage: usage.value, details });

  // ---- research -------------------------------------------------------------------------------------------------------------------------------------
  let raw: Awaited<ReturnType<StoryResearchProvider["research"]>> = { items: [], usage: emptyUsage(), queriesUsed: 0 };
  let t = Date.now();
  if (deps.research && config.webSearchEnabled && config.maxQueriesPerGame > 0) {
    raw = await deps.research.research(game, ctx);
    usage.value = addUsage(usage.value, raw.usage);
  } else details.researchSkipped = true;
  stage("research", t);

  // ---- normalise --------------------------------------------------------------------------------------------------------------------------------------
  t = Date.now();
  const web = normalizeEvidence(raw.items, game, config, deps.now(), deps.newId);
  const evidence = mergeStructured(input.structured, web.items);
  const stats: NormalizeStats = web.stats;
  details.evidence = { structured: input.structured.length, web: stats };
  stage("normalize", t);
  const usable = evidence.filter((e) => e.status === "USABLE");
  if (usable.length === 0) return finish({ decision: "NO_STORY", rejectionCode: "NO_EVIDENCE", rejectionDetail: "No usable evidence was found for this Game.", candidate: null, candidatesConsidered: [], evidence, queriesUsed: raw.queriesUsed });
  if (usable.length < MIN_USABLE_EVIDENCE) return finish({ decision: "NO_STORY", rejectionCode: "INSUFFICIENT_EVIDENCE", rejectionDetail: `Only ${usable.length} usable fact was found; a verified story needs at least ${MIN_USABLE_EVIDENCE}.`, candidate: null, candidatesConsidered: [], evidence, queriesUsed: raw.queriesUsed });

  // ---- angles -------------------------------------------------------------------------------------------------------------------------------------------
  t = Date.now();
  const proposed = await deps.angles.propose(game, usable, ctx);
  usage.value = addUsage(usage.value, proposed.usage);
  stage("angles", t);
  const usableIds = new Set(usable.map((e) => e.id));
  const angles = proposed.angles.filter((a) => a.summary?.trim() && a.evidenceIds?.length && a.evidenceIds.every((id) => usableIds.has(id))).slice(0, Math.max(config.maxAttempts, 1));
  details.angles = proposed.angles.map((a) => ({ type: a.type, summary: String(a.summary ?? "").slice(0, 200), evidence: a.evidenceIds?.length ?? 0, usable: angles.includes(a) }));
  if (angles.length === 0) return finish({ decision: "NO_STORY", rejectionCode: "NO_STORY", rejectionDetail: "No candidate angle rested on usable evidence. Not every Game has a story.", candidate: null, candidatesConsidered: [], evidence, queriesUsed: raw.queriesUsed });

  // ---- candidates (bounded) --------------------------------------------------------------------------------------------------------------------------
  const considered: CandidateAssessment[] = [];
  let feedback: string[] = [];
  for (const angle of angles) {
    t = Date.now();
    const drafted = await deps.drafter.draft(game, angle, usable, { ...ctx, feedback, recentHooks: input.recentHooks });
    usage.value = addUsage(usage.value, drafted.usage);
    const claims = sanitizeClaims(drafted.draft.claims, deps.newId);
    const assessed = await assessCandidate(deps, { game, hook: drafted.draft.hook.trim(), body: drafted.draft.body.trim(), angle, claims, evidence, recentHooks: input.recentHooks, config, score: true }, ctx, usage);
    stage(`candidate_${considered.length + 1}`, t);
    considered.push(assessed);
    if (!assessed.rejectionCode) break;
    feedback = [`Previous attempt rejected (${assessed.rejectionCode}): ${assessed.rejectionDetail ?? ""}`];
  }
  details.candidates = considered.map((c) => ({ angle: c.angle.type, code: c.rejectionCode, total: c.total, caps: c.capsApplied, rationale: c.modelRationale }));

  const accepted = considered.find((c) => !c.rejectionCode);
  if (accepted) return finish({ decision: "ACCEPTED", rejectionCode: null, rejectionDetail: null, candidate: accepted, candidatesConsidered: considered, evidence, queriesUsed: raw.queriesUsed });
  // the closest candidate: furthest through the pipeline, then highest score
  const closest = [...considered].sort((x, y) => (y.total ?? -1) - (x.total ?? -1) || y.claims.length - x.claims.length)[0];
  return finish({ decision: "REJECTED", rejectionCode: closest.rejectionCode, rejectionDetail: closest.rejectionDetail, candidate: closest, candidatesConsidered: considered, evidence, queriesUsed: raw.queriesUsed });
}

/**
 * Re-verification of words an Admin changed: the claims are extracted from the NEW text, then verified against the run's stored evidence exactly like a generated candidate (no scoring — an Admin's judgement
 * replaces the score, but not the facts). Returns the claim results; the caller records them and the database lifts `requires_verification` only if every claim is SUPPORTED.
 */
export async function reverifyEditedText(deps: PipelineDeps, input: { game: GameContext; hook: string; body: string; evidence: EvidenceItem[]; config: StoryConfig }): Promise<{ claims: ClaimResult[]; rejectionCode: RejectionCode | null; rejectionDetail: string | null; usage: ProviderUsage }> {
  const ctx: ResearchContext = { config: input.config, now: deps.now() };
  const usage = { value: emptyUsage() };
  const usable = input.evidence.filter((e) => e.status === "USABLE");
  const extracted = await deps.drafter.extractClaims(input.game, input.hook, input.body, usable, ctx);
  usage.value = addUsage(usage.value, extracted.usage);
  const claims = sanitizeClaims(extracted.claims, deps.newId);
  const angle: Angle = { type: "OTHER", summary: "Admin-edited copy", evidenceIds: [...new Set(claims.flatMap((c) => c.evidenceIds))] };
  const a = await assessCandidate(deps, { game: input.game, hook: input.hook, body: input.body, angle, claims, evidence: input.evidence, recentHooks: [], config: input.config, score: false }, ctx, usage);
  return { claims: a.claims, rejectionCode: a.rejectionCode, rejectionDetail: a.rejectionDetail, usage: usage.value };
}
