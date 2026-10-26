// Brohda 2.1 M3 — turns a pipeline outcome into the single payload of `save_game_story_run_result`. Pure and unit-tested. The database re-validates everything that matters (≥1 claim, every claim SUPPORTED,
// score arithmetic and threshold, length) so a bug here can never create an accepted-but-unverified revision.
import { STORY_PROMPT_VERSION, STORY_RESEARCH_VERSION, type ClaimResult, type EvidenceItem, type RunOutcome } from "./types";

const claimRow = (r: ClaimResult, position: number) => ({
  id: r.claim.id,
  position,
  text: r.claim.text,
  type: r.claim.type,
  subject_team: r.claim.subjectTeam,
  availability_status: r.claim.availabilityStatus,
  quote_text: r.claim.quote?.text ?? null,
  verdict: r.verdict,
  deterministic_ok: r.deterministicOk,
  model_verdict: r.modelVerdict,
  note: r.note.slice(0, 500),
  evidence_ids: r.claim.evidenceIds,
});

const evidenceRow = (e: EvidenceItem, position: number) => ({
  id: e.id,
  position,
  source_kind: e.kind,
  authority: e.authority,
  canonical_id: e.canonicalId,
  url: e.url,
  publisher: e.publisher,
  title: e.title,
  published_at: e.publishedAt,
  retrieved_at: e.retrievedAt,
  evidence_type: e.evidenceType,
  fact_key: e.factKey,
  fact_value: e.factValue,
  subject_team: e.subjectTeam,
  fact_text: e.factText,
  excerpt: e.excerpt,
  as_of: e.asOf,
  status: e.status,
  status_reason: e.statusReason,
});

export function buildSavePayload(outcome: RunOutcome, elapsedMs: number): Record<string, unknown> {
  const c = outcome.candidate;
  const candidates = outcome.candidatesConsidered.map((x) => ({ angle: x.angle.type, summary: x.angle.summary.slice(0, 200), hook: x.draft.hook, code: x.rejectionCode, detail: x.rejectionDetail?.slice(0, 300), total: x.total, dims: x.dims, caps: x.capsApplied, rationale: x.modelRationale }));
  return {
    decision: outcome.decision,
    rejection_code: outcome.rejectionCode,
    rejection_detail: outcome.rejectionDetail,
    candidate_hook: c?.draft.hook ?? null,
    candidate_body: c?.draft.body ?? null,
    dims: c?.dims ?? null,
    counters: { queries: outcome.queriesUsed, model_calls: outcome.usage.modelCalls, search_calls: outcome.usage.searchCalls, input_tokens: outcome.usage.inputTokens, output_tokens: outcome.usage.outputTokens },
    elapsed_ms: elapsedMs,
    prompt_version: STORY_PROMPT_VERSION,
    research_version: STORY_RESEARCH_VERSION,
    details: { ...outcome.details, candidates },
    evidence: outcome.evidence.map(evidenceRow),
    claims: (c?.claims ?? []).map(claimRow),
    revision: outcome.decision === "ACCEPTED" && c ? { hook: c.draft.hook, body: c.draft.body } : null,
  };
}

export { claimRow as reverificationClaimRow };
