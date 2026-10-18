import type { GamePreviewClaim, GamePreviewConfig } from "./types";
import type { CandidateFact, GameIdentity } from "./providers/types";

/**
 * The gate between a drafted Preview and a saved one. Pure and deterministic, so every rule is unit-tested; a draft that fails ANY of them is rejected (and the writer is told why) — an unsupported fact is never published.
 *   - length: the hook and the story are within the configured limits;
 *   - provenance: every claim cites facts that exist in this run's research, none from a blocked source;
 *   - freshness: a claim about the CURRENT state needs a source published within the configured window; history may rest on an older authoritative source;
 *   - numbers: every figure in the hook or story (digits, spelled-out numbers, ordinals) appears in the facts the draft cites — a number the research does not contain cannot be written;
 *   - identity: the Preview is about this Game (it names one of its teams).
 * The model-based verification (is each sentence entailed by its cited facts?) runs in addition to this, never instead of it.
 */
export interface DraftToValidate {
  hook: string;
  preview: string;
  claims: GamePreviewClaim[];
}
export interface ValidationResult {
  ok: boolean;
  problems: string[];
}

// "one" and "second" are left out on purpose: they are ordinary words far more often than figures ("no one", "a second half"), and flagging them would reject true prose.
const SPELLED: Record<string, string> = { two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12" };
const ORDINALS: Record<string, string> = { first: "1", third: "3", fourth: "4", fifth: "5", sixth: "6", seventh: "7", eighth: "8", ninth: "9", tenth: "10" };

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
export function domainMatches(host: string, domains: string[]): boolean {
  return domains.some((d) => {
    const dom = d.toLowerCase().replace(/^www\./, "");
    return host === dom || host.endsWith(`.${dom}`);
  });
}

/** Numeric figures in a text: digits ("26", "3.5", "45-24" → 45 and 24), spelled numbers ("six") and ordinals ("third"), normalized to digits. */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) out.add(m[0].replace(",", "."));
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (SPELLED[word]) out.add(SPELLED[word]);
    if (ORDINALS[word]) out.add(ORDINALS[word]);
  }
  return out;
}

const teamTokens = (name: string) => [name.toLowerCase(), ...(name.toLowerCase().split(/\s+/).slice(-1))];

export function validateDraft({ draft, facts, game, config, now }: { draft: DraftToValidate; facts: CandidateFact[]; game: GameIdentity; config: GamePreviewConfig; now: Date }): ValidationResult {
  const problems: string[] = [];
  const hook = draft.hook.trim();
  const preview = draft.preview.trim();
  if (!hook) problems.push("The hook is empty.");
  if (!preview) problems.push("The preview is empty.");
  if (hook.length > config.hookMaxChars) problems.push(`The hook is ${hook.length} characters; the limit is ${config.hookMaxChars}.`);
  if (preview.length > config.maxChars) problems.push(`The preview is ${preview.length} characters; the limit is ${config.maxChars}.`);

  const byId = new Map(facts.map((f) => [f.id, f]));
  if (draft.claims.length === 0) problems.push("The draft lists no supporting claims, so nothing in it is backed by research.");
  const cited = new Map<string, CandidateFact>();
  draft.claims.forEach((claim, i) => {
    if (!claim.text.trim()) problems.push(`Claim ${i + 1} is empty.`);
    if (claim.factIds.length === 0) problems.push(`Claim ${i + 1} ("${claim.text.slice(0, 60)}") cites no fact.`);
    for (const id of claim.factIds) {
      const fact = byId.get(id);
      if (!fact) problems.push(`Claim ${i + 1} cites "${id}", which is not one of the researched facts.`);
      else cited.set(id, fact);
    }
  });

  for (const fact of cited.values()) {
    const host = domainOf(fact.sourceUrl);
    if (!host) problems.push(`Fact ${fact.id} has an unusable source URL.`);
    else if (domainMatches(host, config.blockedDomains)) problems.push(`Fact ${fact.id} comes from a blocked source (${host}).`);
    if (fact.kind === "current") {
      const published = fact.publishedAt ? new Date(fact.publishedAt).getTime() : NaN;
      if (!Number.isFinite(published)) problems.push(`Fact ${fact.id} is about the current state but its source has no publication time, so it cannot be treated as current.`);
      else if (now.getTime() - published > config.currentFactMaxAgeHours * 3_600_000) problems.push(`Fact ${fact.id} describes the current state but its source is older than ${config.currentFactMaxAgeHours} hours; state it as history or drop it.`);
    }
  }

  const supported = new Set<string>();
  for (const fact of cited.values()) for (const n of numbersIn(`${fact.claim} ${fact.excerpt ?? ""}`)) supported.add(n);
  for (const claim of draft.claims) for (const n of numbersIn(claim.text)) if (!supported.has(n)) problems.push(`The figure "${n}" in a claim is not in the facts it cites.`);
  for (const n of numbersIn(`${hook} ${preview}`)) if (!supported.has(n)) problems.push(`The figure "${n}" appears in the hook or preview but in none of the cited facts.`);

  const text = `${hook} ${preview}`.toLowerCase();
  const names = [game.homeTeam, game.awayTeam].flatMap(teamTokens);
  if (!names.some((n) => n.length >= 3 && text.includes(n))) problems.push(`The preview does not name either team (${game.awayTeam}, ${game.homeTeam}).`);

  return { ok: problems.length === 0, problems };
}
