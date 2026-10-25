// Brohda 2.1 M3 — deterministic claim verification. This runs BEFORE any model is asked an opinion, and the model can only make a verdict stricter, never more lenient:
// a claim is SUPPORTED only if every deterministic check here passes AND the independent model verifier agrees (see pipeline.ts).
//
// Checks, per atomic claim:
//   evidence exists and is usable (not blocked/quarantined/superseded/conflicted)   · identity (the evidence is about the team the claim is about)
//   every figure in the claim appears in the cited evidence                          · freshness (current-type claims need evidence recent enough; availability needs dated, fresh, strong evidence)
//   availability status matches the evidence exactly (questionable is never "out")  · quotes appear verbatim in a strong source that names the speaker
//   high-risk claim types need a source above the policy's authority floor
// Story-level: every figure and proper noun in the copy must appear in some claim ("unclaimed fact" ⇒ reject), so a sentence can never smuggle in an unverified fact next to a sourced one.
import { minAuthorityForClaim } from "./source-policy";
import { evidenceNumbers, normalizeForCompare, numbersIn, stripTeamNames } from "./text";
import { CURRENT_CLAIM_TYPES, type ClaimResult, type ClaimVerdict, type DraftClaim, type EvidenceItem, type GameContext, type RejectionCode, type StoryConfig } from "./types";

export interface VerifyContext {
  game: GameContext;
  config: Pick<StoryConfig, "statusMaxAgeHours" | "currentFactMaxAgeHours">;
  now: Date;
}

const ageHours = (item: EvidenceItem, now: Date): number | null => {
  const stamp = item.evidenceType === "STRUCTURED" ? (item.asOf ? now.toISOString() : null) : (item.publishedAt ?? item.asOf);
  if (!stamp) return null;
  return (now.getTime() - Date.parse(stamp)) / 3_600_000;
};

const fail = (claim: DraftClaim, verdict: ClaimVerdict, code: RejectionCode, note: string): ClaimResult => ({ claim, verdict, deterministicOk: false, modelVerdict: null, note, code });

export function verifyClaimDeterministic(claim: DraftClaim, evidenceById: ReadonlyMap<string, EvidenceItem>, ctx: VerifyContext): ClaimResult {
  if (!claim.text.trim()) return fail(claim, "UNSUPPORTED", "UNSUPPORTED_CLAIM", "The claim has no text.");
  if (claim.evidenceIds.length === 0) return fail(claim, "UNSUPPORTED", "UNSUPPORTED_CLAIM", "The claim cites no evidence.");
  const cited: EvidenceItem[] = [];
  for (const id of claim.evidenceIds) {
    const item = evidenceById.get(id);
    if (!item) return fail(claim, "UNSUPPORTED", "UNSUPPORTED_CLAIM", `The claim cites evidence "${id}" that does not exist in this run.`);
    cited.push(item);
  }
  const conflicted = cited.find((e) => e.status === "CONFLICTED");
  if (conflicted) return fail(claim, "CONTRADICTED", "CONTRADICTED_CLAIM", `Credible sources disagree about "${conflicted.factKey ?? conflicted.factText.slice(0, 60)}".`);
  const superseded = cited.find((e) => e.status === "SUPERSEDED");
  if (superseded) return fail(claim, "STALE", "STALE_EVIDENCE", `The cited source was superseded by a newer report (${superseded.statusReason ?? "newer source"}).`);
  const unusable = cited.find((e) => e.status !== "USABLE");
  if (unusable) return fail(claim, "UNSUPPORTED", "UNSUPPORTED_CLAIM", `The cited evidence is not usable (${unusable.status}${unusable.statusReason ? `: ${unusable.statusReason}` : ""}).`);

  // Identity: evidence about the other team, or about neither, cannot support a claim about this team.
  if (claim.subjectTeam === "HOME" || claim.subjectTeam === "AWAY") {
    const mismatch = cited.find((e) => e.subjectTeam !== "BOTH" && e.subjectTeam !== claim.subjectTeam);
    if (mismatch) return fail(claim, "UNSUPPORTED", "IDENTITY_MISMATCH", `The claim is about the ${claim.subjectTeam.toLowerCase()} team but the cited evidence is about ${mismatch.subjectTeam === "NEITHER" ? "neither team" : `the ${mismatch.subjectTeam.toLowerCase()} team`}.`);
  }

  // Source strength for high-risk claim types.
  const floor = minAuthorityForClaim(claim.type);
  if (!cited.some((e) => e.authority >= floor)) return fail(claim, "UNSUPPORTED", "UNSUPPORTED_CLAIM", `A ${claim.type.toLowerCase()} claim needs a source of authority ${floor} or higher; the strongest cited is ${Math.max(...cited.map((e) => e.authority))}.`);

  // Figures: every number the claim states must be present in the cited evidence.
  const evidenceText = cited.map((e) => `${e.factText} ${e.excerpt ?? ""} ${e.factValue ?? ""}`).join(" ");
  const evidenceFigures = evidenceNumbers(evidenceText);
  const claimFigures = numbersIn(stripTeamNames(claim.text, [ctx.game.homeTeam, ctx.game.awayTeam]));
  const missing = [...claimFigures].filter((n) => !evidenceFigures.has(n));
  if (missing.length) return fail(claim, "UNSUPPORTED", "UNSUPPORTED_CLAIM", `The claim states ${missing.join(", ")}, which the cited evidence does not contain.`);

  // Freshness for claims about the present.
  if (CURRENT_CLAIM_TYPES.includes(claim.type)) {
    const limit = claim.type === "AVAILABILITY" ? ctx.config.statusMaxAgeHours : ctx.config.currentFactMaxAgeHours;
    const ages = cited.map((e) => ageHours(e, ctx.now));
    if (claim.type === "AVAILABILITY" && ages.some((a) => a === null)) return fail(claim, "STALE", "STALE_EVIDENCE", "An availability claim needs a dated source; the cited evidence has no publication date.");
    const dated = ages.filter((a): a is number => a !== null);
    if (dated.length && Math.min(...dated) > limit) return fail(claim, "STALE", "STALE_EVIDENCE", `The freshest cited evidence is ${Math.round(Math.min(...dated))} hours old; a ${claim.type.toLowerCase()} claim allows ${limit}.`);
  }

  // Availability: the status in the copy must be the status the evidence reports, exactly. "Questionable" is never "out"; unknown or absent status is ambiguous.
  if (claim.type === "AVAILABILITY") {
    if (!claim.availabilityStatus) return fail(claim, "AMBIGUOUS", "UNSUPPORTED_CLAIM", "An availability claim must state a status (out, doubtful, questionable, probable, available, returning).");
    const reported = cited.map((e) => e.factValue).filter((v): v is string => !!v);
    if (reported.length === 0) return fail(claim, "AMBIGUOUS", "UNSUPPORTED_CLAIM", "The cited evidence does not record a normalised availability status.");
    if (!reported.every((v) => v === claim.availabilityStatus)) return fail(claim, "AMBIGUOUS", "UNSUPPORTED_CLAIM", `The claim says ${claim.availabilityStatus} but the evidence reports ${[...new Set(reported)].join("/")}.`);
  }

  // Quotes: verbatim in a strong source that also names the speaker. No paraphrase-as-quote, no composite quotes.
  if (claim.type === "QUOTE" || claim.quote) {
    if (!claim.quote?.text.trim() || !claim.quote.speaker.trim()) return fail(claim, "UNSUPPORTED", "UNVERIFIED_QUOTE", "A quote claim must carry the quoted words and the speaker.");
    const q = normalizeForCompare(claim.quote.text);
    const speaker = normalizeForCompare(claim.quote.speaker).split(" ").filter((t) => t.length >= 3);
    const holder = cited.find((e) => e.evidenceType !== "STRUCTURED" && e.authority >= minAuthorityForClaim("QUOTE") && normalizeForCompare(`${e.excerpt ?? ""} ${e.factText}`).includes(q));
    if (!holder) return fail(claim, "UNSUPPORTED", "UNVERIFIED_QUOTE", "The quoted words do not appear verbatim in any cited source of sufficient authority.");
    const holderText = normalizeForCompare(`${holder.excerpt ?? ""} ${holder.factText} ${holder.title ?? ""}`);
    if (speaker.length && !speaker.some((t) => holderText.includes(t))) return fail(claim, "UNSUPPORTED", "UNVERIFIED_QUOTE", "The cited source does not name the person the quote is attributed to.");
  }

  return { claim, verdict: "SUPPORTED", deterministicOk: true, modelVerdict: null, note: "Passed the deterministic checks.", code: null };
}

export function verifyClaimsDeterministic(claims: readonly DraftClaim[], evidence: readonly EvidenceItem[], ctx: VerifyContext): ClaimResult[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  return claims.map((c) => verifyClaimDeterministic(c, byId, ctx));
}

/** Words that may appear capitalised mid-sentence without being a checkable fact. */
const ALLOWED_CAPITALISED = new Set(["brohda", "i", "nba", "nfl", "nhl", "mlb", "ot", "mvp"]);

/**
 * Facts in the copy that no claim covers: figures and mid-sentence capitalised words (names, places) absent from every claim's text. The writer must list every factual statement as a claim,
 * so this is what stops an unsourced fact riding along inside a sourced sentence. Team names of this Game are always allowed.
 */
export function findUnclaimedFacts(hook: string, body: string, claims: readonly DraftClaim[], game: Pick<GameContext, "homeTeam" | "awayTeam">): string[] {
  const claimText = claims.map((c) => `${c.text} ${c.quote?.text ?? ""}`).join(" ");
  const claimFigures = numbersIn(claimText, { includeAmbiguousWords: true });
  const claimNorm = normalizeForCompare(claimText);
  const teamTokens = new Set([game.homeTeam, game.awayTeam].flatMap((t) => normalizeForCompare(t).split(" ")));
  const unclaimed = new Set<string>();
  for (const part of [hook, body]) {
    const text = stripTeamNames(part, [game.homeTeam, game.awayTeam]);
    for (const n of numbersIn(text)) if (!claimFigures.has(n)) unclaimed.add(n);
    // capitalised words that are not the first word of a sentence
    const sentences = text.split(/(?<=[.!?])\s+|\n+/);
    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/);
      words.forEach((raw, i) => {
        if (i === 0) return;
        const w = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9'’-]+$/g, "");
        if (!/^[A-Z][A-Za-z'’-]{2,}$/.test(w)) return;
        const lw = w.toLowerCase().replace(/['’]s$/, "");
        if (ALLOWED_CAPITALISED.has(lw) || teamTokens.has(lw)) return;
        if (!claimNorm.includes(normalizeForCompare(lw))) unclaimed.add(w);
      });
    }
  }
  return [...unclaimed];
}
