// Brohda 2.1 M3 — editorial scoring. The model proposes five dimension values; BROHDA validates their ranges, applies deterministic caps from the evidence itself, and computes the total.
// The model never returns an authoritative total and nothing here trusts it to certify its own correctness (the database recomputes the total as a generated column and re-checks the threshold).
//
//   Relevance to the upcoming matchup   30      Strength of verified evidence   25      Debate potential   20      Originality and specificity   15      Freshness   10
import { maxSimilarityToRecent } from "./rules";
import { CURRENT_CLAIM_TYPES, DIMENSION_MAX, type ClaimResult, type EvidenceItem, type ScoreDimensions } from "./types";

export const DIMENSION_KEYS = ["relevance", "evidence", "debate", "originality", "freshness"] as const;

export type DimensionValidation = { ok: true; dims: ScoreDimensions } | { ok: false; detail: string };

/** Each component must be a whole number within its own maximum. Out-of-range, fractional or missing values invalidate the score — they are never silently clamped. */
export function validateDimensions(input: Partial<Record<keyof ScoreDimensions, unknown>>): DimensionValidation {
  const out: Partial<ScoreDimensions> = {};
  for (const key of DIMENSION_KEYS) {
    const v = input[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > DIMENSION_MAX[key]) return { ok: false, detail: `The ${key} score must be a whole number from 0 to ${DIMENSION_MAX[key]}; got ${JSON.stringify(v)}.` };
    out[key] = v;
  }
  return { ok: true, dims: out as ScoreDimensions };
}

export const totalOf = (d: ScoreDimensions): number => d.relevance + d.evidence + d.debate + d.originality + d.freshness;

export interface CapContext {
  claims: readonly ClaimResult[];
  evidenceById: ReadonlyMap<string, EvidenceItem>;
  hook: string;
  recentHooks: readonly string[];
  now: Date;
  modelFlaggedGeneric: boolean;
}

export function applyCaps(dims: ScoreDimensions, ctx: CapContext): { dims: ScoreDimensions; caps: string[] } {
  const out = { ...dims };
  const caps: string[] = [];
  const cap = (key: keyof ScoreDimensions, limit: number, why: string) => {
    if (out[key] > limit) {
      caps.push(`${key} ${out[key]}→${limit} (${why})`);
      out[key] = limit;
    }
  };

  const cited = new Map<string, EvidenceItem>();
  for (const c of ctx.claims) for (const id of c.claim.evidenceIds) {
    const e = ctx.evidenceById.get(id);
    if (e) cited.set(id, e);
  }
  const items = [...cited.values()];
  if (items.length) {
    const avg = items.reduce((s, e) => s + e.authority, 0) / items.length;
    cap("evidence", Math.floor((DIMENSION_MAX.evidence * avg) / 100), `average source authority ${Math.round(avg)}`);
    if (items.length === 1 && items[0].kind !== "STRUCTURED_DATA") cap("evidence", 18, "the story rests on a single non-structured source");
  } else cap("evidence", 0, "no cited evidence");

  // Freshness is judged against the oldest evidence a CURRENT-type claim depends on. Historical context is not penalised for being old.
  const currentAges = ctx.claims
    .filter((c) => CURRENT_CLAIM_TYPES.includes(c.claim.type))
    .map((c) => {
      const ages = c.claim.evidenceIds
        .map((id) => ctx.evidenceById.get(id))
        .filter((e): e is EvidenceItem => !!e && e.evidenceType !== "STRUCTURED")
        .map((e) => (ctx.now.getTime() - Date.parse(e.publishedAt ?? e.asOf ?? "")) / 3_600_000)
        .filter((a) => Number.isFinite(a));
      return ages.length ? Math.min(...ages) : null;
    })
    .filter((a): a is number => a !== null);
  if (currentAges.length) {
    const oldest = Math.max(...currentAges);
    cap("freshness", oldest <= 24 ? 10 : oldest <= 72 ? 8 : oldest <= 168 ? 5 : 2, `current-claim evidence is ${Math.round(oldest)}h old`);
  }

  const sim = maxSimilarityToRecent(ctx.hook, ctx.recentHooks);
  if (sim > 0.6) cap("originality", 5, `hook is ${Math.round(sim * 100)}% similar to a recent story`);
  else if (sim > 0.4) cap("originality", 9, `hook is ${Math.round(sim * 100)}% similar to a recent story`);

  if (ctx.modelFlaggedGeneric) {
    cap("debate", 5, "flagged generic");
    cap("relevance", 10, "flagged generic");
  }
  return { dims: out, caps };
}
