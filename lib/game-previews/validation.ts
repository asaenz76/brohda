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

/** Wording that puts a statement in a PREVIOUS season whatever the research said ("last season", "a year ago"). */
const PREVIOUS_SEASON_WORDS = /\b(last|previous|prior) (season|year)\b|\b(a )?(year|seasons?) ago\b/i;

/**
 * A deterministic backstop for the research's season classification: it can only move a fact from CURRENT_SEASON to HISTORICAL_CONTEXT, never the other way. A current-state fact (injury, availability) is by nature this season's; a fact whose own wording
 * names an earlier season (a year before this one, or "last season") is history. Years are judged against the Game's date: from August on, a season that began last year is over; in the first half of the year the previous calendar year may still be this season (a season that spans New Year).
 */
export function reconcileSeasonScope(facts: CandidateFact[], game: Pick<GameIdentity, "kickoffUtc">): CandidateFact[] {
  const kickoff = new Date(game.kickoffUtc);
  const year = kickoff.getUTCFullYear();
  const firstPastYear = kickoff.getUTCMonth() >= 7 ? year - 1 : year - 2; // years at or before this are an earlier season
  return facts.map((f) => {
    if (f.kind === "current") return f.seasonScope === "CURRENT_SEASON" ? f : { ...f, seasonScope: "CURRENT_SEASON" };
    if (f.seasonScope === "HISTORICAL_CONTEXT") return f;
    const text = `${f.claim} ${f.excerpt ?? ""}`;
    const years = [...text.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
    const mentionsPast = years.some((y) => y <= firstPastYear) || PREVIOUS_SEASON_WORDS.test(f.claim);
    return mentionsPast ? { ...f, seasonScope: "HISTORICAL_CONTEXT" } : f;
  });
}

/** Statements about where a team stands in the league change with every game any team plays: "leads the NFL in", "tied for the most", "ranks 29th", "last unbeaten team", "first in the division". */
const RANKING_WORDS = /\b(ranks?|ranked|ranking)\b|\b\d+(st|nd|rd|th) (in|of|among)\b|\btied for (the )?(most|fewest|lead|best|worst|first|last)\b|\b(leads?|leading|leaders?) (the )?(NFL|NHL|NBA|MLB|league|conference|division)\b|\b(most|fewest|best|worst) in the (NFL|NHL|NBA|MLB|league)\b|\b(last|only) (remaining )?(unbeaten|undefeated|winless)\b|\b(first|second|third|fourth) in the [A-Z]/i;

/**
 * A league rank or lead is a statement about the CURRENT state however it is phrased: it was true when its source was written and may have changed since (a team's "10 takeaways, tied for the most in the NFL" is no longer true once another team's game adds an eleventh).
 * Research may file one as historical because the numbers come from completed games; it is re-filed as current, so it needs a dated source inside the freshness window like any other current-state fact. Only ever promotes historical -> current.
 */
export function reconcileFactKind(facts: CandidateFact[]): CandidateFact[] {
  return facts.map((f) => (f.kind === "historical" && RANKING_WORDS.test(f.claim) ? { ...f, kind: "current" as const } : f));
}

export interface ExcludedFact {
  fact: CandidateFact;
  reason: string;
}

/**
 * Which researched facts may be written at all. A fact about the CURRENT state (an injury, a return, who is expected to start) is only worth as much as its source's date: with no publication time, or one older than the configured window,
 * it cannot be stated as current — so it never reaches the angle or the writer (otherwise the story is built on a fact the provenance gate must reject, and the rewrite fails the same way). History does not expire this way.
 */
export function splitUsableFacts(facts: CandidateFact[], config: Pick<GamePreviewConfig, "currentFactMaxAgeHours">, now: Date): { usable: CandidateFact[]; excluded: ExcludedFact[] } {
  const usable: CandidateFact[] = [];
  const excluded: ExcludedFact[] = [];
  for (const fact of facts) {
    if (fact.kind !== "current") {
      usable.push(fact);
      continue;
    }
    const published = fact.publishedAt ? new Date(fact.publishedAt).getTime() : NaN;
    if (!Number.isFinite(published)) excluded.push({ fact, reason: "about the current state, but its source shows no publication time" });
    else if (now.getTime() - published > config.currentFactMaxAgeHours * 3_600_000) excluded.push({ fact, reason: `about the current state, but its source is older than ${config.currentFactMaxAgeHours} hours` });
    else usable.push(fact);
  }
  return { usable, excluded };
}

/** A time frame a statement claims for itself: "this season", "this year", "so far this season". */
const SEASON_QUALIFIER = /\b(this|the current) (season|year)\b|\bso far in 20\d\d\b/i;
/** What a fact must itself say to carry that time frame. */
const FACT_STATES_SEASON = /\b(this|the current) (season|year)\b|\bso far in 20\d\d\b|\b2026\b/i;

/** How a Preview may name a team: the full name, the nickname ("Wild"), or the city/region ("Minnesota"). */
const teamTokens = (name: string) => {
  const words = name.toLowerCase().split(/\s+/);
  return [name.toLowerCase(), words[words.length - 1], ...(words.length > 1 ? [words.slice(0, -1).join(" ")] : [])];
};

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

  // A time frame is a claim too. "Six straight games" may run into last season; writing "six straight games THIS SEASON" is only allowed when a cited fact says so itself.
  const statesSeason = (f: CandidateFact) => FACT_STATES_SEASON.test(`${f.claim} ${f.excerpt ?? ""}`);
  draft.claims.forEach((claim, i) => {
    const facts = claim.factIds.map((id) => byId.get(id)).filter((f): f is CandidateFact => Boolean(f));
    if (SEASON_QUALIFIER.test(claim.text) && facts.length > 0 && !facts.some(statesSeason)) problems.push(`Claim ${i + 1} says "this season" (or "this year"), but none of the facts it cites says that; a streak or count may reach into last season. State only the time frame the facts give.`);
  });
  if (SEASON_QUALIFIER.test(`${hook} ${preview}`) && cited.size > 0 && ![...cited.values()].some(statesSeason)) problems.push('The hook or preview says "this season" (or "this year"), but none of the cited facts says that. State only the time frame the facts give.');

  const text = `${hook} ${preview}`.toLowerCase();
  const names = [game.homeTeam, game.awayTeam].flatMap(teamTokens);
  if (!names.some((n) => n.length >= 3 && text.includes(n))) problems.push(`The preview does not name either team (${game.awayTeam}, ${game.homeTeam}).`);

  return { ok: problems.length === 0, problems };
}
