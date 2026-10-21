import type { GamePreviewClaim, GamePreviewConfig } from "./types";
import type { CandidateFact, DraftHints, GameIdentity } from "./providers/types";
import { currentSeasonStart } from "./identity";
import { publisherDomainFromName, SYNDICATION_HOSTS } from "./publishers";

/**
 * The deterministic gate between a drafted Preview and a saved one: ONLY facts code can decide. Everything that needs to understand meaning (is this number right, is this claim current, is the logic sound, does it belong to this Game now) is the independent reader's job
 * (`verify`, with BLOCKING and ADVISORY findings) and is never encoded as a regex here.
 *   - shape: a title and a caption; at least one claim, each citing researched facts, none from a blocked source;
 *   - length: title + caption TOGETHER fewer than the configured limit, counted exactly;
 *   - no fabricated quote (a quote must appear in a cited passage);
 *   - the contract's style invariants: no em dash, no hashtag, no wagering language, no banned phrase.
 * `draftHints` lists what a person would want a second look at (a figure no cited fact contains, "this season" on a fact that does not say it): hints for the reader, not gates.
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

// "one" and "second" are left out on purpose: they are ordinary words far more often than figures ("no one", "a second half").
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

/**
 * Prose that uses a number word as plain language, not as a figure: "the two teams" / "two rebuilt rosters" (the two sides of THIS Game — no statistic is being claimed) and "first" as an adverb at the end of a clause ("who adjusts first?", "holds up first.").
 * Dropped before the figures are read; everything else ("two straight wins", "their first win", "third in the league") still has to be in a cited fact.
 */
const PLAIN_TWO = /\b(the )?two (\w+ ){0,2}(teams?|sides?|clubs?|rosters?|franchises|programs|squads|lineups?|offenses|defenses)\b/gi;
const ADVERB_FIRST = /\bfirst(?=\s*[.?!,;:]|\s*$)/gi;

/**
 * Figures a piece of PROSE actually CLAIMS, as opposed to every word that can express a number. "his first chance", "the first meeting", "two stars are out", "the first to arrive" are ordinary language and need no source;
 * "five straight", "60 wins", "two touchdowns", "first in the league", "ranked third", "their first win of the season" are factual quantitative claims and must be in a cited fact. Digits always count.
 */
const QUANT_NOUN = "straight|consecutive|in a row|wins?|losses|loss|defeats?|victories|games?|points?|goals?|assists?|yards?|touchdowns?|interceptions?|picks|sacks?|takeaways|giveaways|turnovers|rebounds?|steals?|blocks?|saves?|shutouts?|minutes|seasons?|years|meetings|titles|championships|starts|appearances|times|percent|shots|homers|runs|hits|innings|strikeouts|penalties";
const ORDINAL_CONTEXT = /\b(wins?|loss(es)?|defeats?|victory|career|season|league|nfl|nba|nhl|mlb|conference|division|straight|consecutive|ever|goal|touchdown|shutout|title|championship|playoffs?|round|overall|road|home|away)\b/i;
export function claimedFigures(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) out.add(m[0].replace(",", "."));
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z']+/g) ?? [];
  const rankedBefore = (i: number) => /^(ranked|ranks|ranking|top|last|no)$/.test(words[i - 1] ?? "");
  words.forEach((w, i) => {
    if (SPELLED[w]) {
      const next = words.slice(i + 1, i + 3).join(" ");
      if (new RegExp(`^(\\w+ )?(${QUANT_NOUN})\\b`).test(next) || new RegExp(`^(${QUANT_NOUN})\\b`).test(next) || rankedBefore(i)) out.add(SPELLED[w]);
    } else if (ORDINALS[w]) {
      const ahead = words.slice(i + 1, i + 5).join(" ");
      if (ORDINAL_CONTEXT.test(ahead) || rankedBefore(i)) out.add(ORDINALS[w]);
    }
  });
  return out;
}

/** Numeric figures in a text: digits ("26", "3.5", "45-24" → 45 and 24), spelled numbers ("six") and ordinals ("third"), normalized to digits. */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  const plain = text.replace(PLAIN_TWO, " ").replace(ADVERB_FIRST, " ");
  for (const m of plain.matchAll(/\d+(?:[.,]\d+)?/g)) out.add(m[0].replace(",", "."));
  for (const word of plain.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (SPELLED[word]) out.add(SPELLED[word]);
    if (ORDINALS[word]) out.add(ORDINALS[word]);
  }
  return out;
}

/**
 * A deterministic backstop for the research's season classification, driven by the SUPPLIED season identifier (never the calendar year): a fact published before the current season began (NFL/NBA/NHL: before July 1 of the season's start year) is last season's news, whatever its
 * wording, and is re-scoped to history. It only ever demotes: a current-state fact (injury, availability) is by nature this season's.
 */
export function reconcileSeasonScope(facts: CandidateFact[], game: Pick<GameIdentity, "season" | "competition">): CandidateFact[] {
  const seasonStart = currentSeasonStart(game);
  return facts.map((f) => {
    if (f.kind === "current" || f.seasonScope === "HISTORICAL_CONTEXT") return f;
    if (seasonStart && f.publishedAt && new Date(f.publishedAt).getTime() < seasonStart.getTime()) return { ...f, seasonScope: "HISTORICAL_CONTEXT" };
    return f;
  });
}

/**
 * The domain labels an official team website can have: the nickname ("chargers.com"), "the" + nickname ("therams.com"), city + nickname ("detroitlions.com", "buffalobills.com") and the city's initials + nickname ("nygiants.com", "larams.com").
 * Matched on the WHOLE label, never as a substring, so an unrelated host that merely ends in a nickname ("cheat.com" for the Heat) is not a team site.
 */
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
export function teamSiteLabels(team: string): Set<string> {
  const words = team.trim().split(/\s+/);
  const nick = slug(words[words.length - 1] ?? "");
  const cityWords = words.slice(0, -1);
  const city = slug(cityWords.join(""));
  const initials = cityWords.map((w) => w[0]?.toLowerCase() ?? "").join("");
  const labels = new Set<string>();
  if (nick.length >= 4) {
    labels.add(nick);
    labels.add(`the${nick}`);
    if (city) labels.add(`${city}${nick}`);
    if (initials.length >= 2) labels.add(`${initials}${nick}`);
    // Two-word nicknames are one word on the web ("Maple Leafs", "Red Wings", "Blue Jackets", "Trail Blazers"): city + whole nickname, and the nickname alone.
  }
  const twoWord = words.length >= 3 ? slug(words.slice(-2).join("")) : "";
  if (twoWord.length >= 6) labels.add(twoWord);
  return labels;
}

/**
 * Whether a source is trusted as the PRIMARY support of a published Preview: a domain on the stored trusted list (the configurable `preferred_domains`: the leagues, ESPN, FOX Sports, established major sports reporting, ...) or one of the two teams' own websites.
 * A random blog, a content farm or a low-authority aggregator is never the primary source (it may still be a supporting one).
 */
export function isTrustedSource(url: string, teams: string[], trustedDomains: string[]): boolean {
  const host = domainOf(url);
  if (!host) return false;
  if (domainMatches(host, trustedDomains)) return true;
  const label = host.split(".").slice(-2)[0] ?? "";
  return label.length >= 4 && teams.some((t) => teamSiteLabels(t).has(label));
}

const normQuote = (t: string) => t.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

/** A quote in the Preview must be in a cited source passage: a fabricated quote is never published. Returns the quotes that were not found. */
export function unsupportedQuotes(text: string, cited: CandidateFact[]): string[] {
  const corpus = normQuote(cited.map((f) => `${f.claim} ${f.excerpt ?? ""}`).join(" "));
  const missing: string[] = [];
  for (const m of text.matchAll(/["\u201C]([^"\u201D]{12,})["\u201D]/g)) {
    const q = normQuote(m[1]);
    if (q.split(" ").length >= 3 && !corpus.includes(q)) missing.push(m[1]);
  }
  return missing;
}

/**
 * A page whose purpose is betting: odds, best bets, a sportsbook, wagering picks, prop bets, gambling advice. Such a page may never be the publicly credited PRIMARY source of a Brohda Preview, even on an otherwise trusted domain (an NBC Sports news story qualifies;
 * NBC Sports' betting/odds page does not). It may support a non-betting fact only when that fact is independently verified and another eligible trusted source carries the central story.
 *
 * Decided from the page's PURPOSE, not from one editorial word: "preview", "prediction(s)" and "picks" alone are ordinary sports-editorial words ("2026-27 NBA season preview: rankings, predictions", "who we pick to win the division") and are NOT betting. They count only together with a wagering
 * term (odds, spread, line(s), bet(s), props, parlay, sportsbook, moneyline, over/under) in the URL or the title, or when the URL itself sits in a betting section (/betting/, /odds/, /sportsbook/, /gambling/).
 */
const WAGER_TERMS = "odds|spreads?|lines?|bets?|betting|props?|parlays?|sportsbooks?|moneylines?|over-under|ats|wager(?:s|ing)?|gambling|dfs";
const BETTING_SECTION = /\/(betting|odds|sportsbooks?|gambling|best-bets?|parlays?|dfs|props|prop-bets|picks)(\/|$)/i; // "picks" only as a whole section (a picks hub), never inside an article slug
const BETTING_SLUG = new RegExp(`(^|[-_/.])(odds|best-bets?|parlays?|sportsbooks?|betting|prop-bets?|player-props|moneyline|against-the-spread)([-_/.]|$)`, "i");
const PICK_OR_PREDICTION = /(^|[-_/.])(picks?|predictions?|expert-picks)([-_/.]|$)/i;
const WAGER_IN_SLUG = new RegExp(`(^|[-_/.])(${WAGER_TERMS})([-_/.]|$)`, "i");
const BETTING_TITLE_STRONG = /\b(odds|best bets?|betting|parlays?|sportsbooks?|moneyline|against the spread|over\/under|player props|prop bets?)\b/i;
const PICK_OR_PREDICTION_TITLE = /\b(picks?|predictions?)\b/i;
const WAGER_IN_TITLE = /\b(odds|spreads?|lines?|bets?|betting|props?|parlays?|sportsbooks?|moneylines?|over\/under|against the spread|wagers?)\b/i;
export function isBettingPage(url: string, title?: string | null): boolean {
  let path = url;
  try {
    const u = new URL(url);
    path = `${u.pathname}${u.search}`;
  } catch {
    /* a non-URL falls through to the title check */
  }
  const t = title ?? "";
  if (BETTING_SECTION.test(path) || BETTING_SLUG.test(path)) return true;
  if (PICK_OR_PREDICTION.test(path) && (WAGER_IN_SLUG.test(path) || WAGER_IN_TITLE.test(t))) return true;
  if (BETTING_TITLE_STRONG.test(t)) return true;
  return PICK_OR_PREDICTION_TITLE.test(t) && WAGER_IN_TITLE.test(t);
}

/**
 * A source that can be CREDITED to a reader: a page about a story, not a data endpoint. A JSON API (`/apis/`, `site.api.`), a feed or a raw data file is evidence for a number, not "the original reporting" a Member can open and read.
 */
export function isStoryPage(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    return !(/^(site\.)?api[.-]/i.test(u.hostname) || /\/apis?\//i.test(u.pathname) || /\.(json|xml|csv|rss|atom)$/i.test(u.pathname));
  } catch {
    return false;
  }
}

/**
 * PUBLIC CREDIT eligibility, separate from EVIDENCE eligibility. A source may be valid evidence for a fact (a JSON feed, a schedule PDF, a live injury list, a stats table, a data feed) and still be a poor thing to show a Member as "the original reporting". A creditable page is a
 * readable page a Member can open and understand: a story page (not a data endpoint), not a betting page, not a document or data file (pdf, uploads), and not a live list, table or profile page (injuries, schedule(s), scoreboard, standings, stats, roster, depth chart, transactions, game log, player profile / player stats pages).
 * Decided on whole URL path SEGMENTS, so an article whose slug merely contains "injury-report" or "schedule" is still creditable.
 */
const NON_EDITORIAL_SEGMENTS = new Set(["injuries", "injury-report", "injury", "schedule", "schedules", "scoreboard", "standings", "stats", "statistics", "roster", "depth-chart", "transactions", "game-log", "gamelog", "splits", "uploads", "feed", "feeds", "api", "player", "players", "profile", "profiles", "athlete", "athletes", "dashboard"]);
/** A live player page whose slug ends "-player" (fox sports: /nfl/micah-parsons-player): a profile and stats page, not a story. */
const PLAYER_PAGE_SLUG = /-player$/;
export function isCreditablePage(url: string, title?: string | null): boolean {
  if (!isStoryPage(url) || isBettingPage(url, title)) return false;
  try {
    const u = new URL(url);
    if (/\.(pdf|docx?|xlsx?|pptx?|zip|txt)$/i.test(u.pathname)) return false;
    const segments = u.pathname.toLowerCase().split("/").filter(Boolean);
    return !segments.some((seg) => NON_EDITORIAL_SEGMENTS.has(seg)) && !PLAYER_PAGE_SLUG.test(segments[segments.length - 1] ?? "");
  } catch {
    return false;
  }
}

/** Whether a URL is on an aggregator that republishes other publishers' stories (Yahoo, MSN, AOL). */
export const isSyndicationHost = (url: string): boolean => domainMatches(domainOf(url), SYNDICATION_HOSTS);

/**
 * The domain of the ORIGINAL publisher of a syndicated page, when the page reliably identifies it: the original URL it names, or the name of a publisher Brohda knows ("Originally appeared on Sports Illustrated"). Null otherwise: nothing is guessed.
 */
export function originalPublisherDomain(fact: Pick<CandidateFact, "originalPublisher" | "originalUrl">): string | null {
  const fromUrl = fact.originalUrl ? domainOf(fact.originalUrl) : "";
  if (fromUrl && !domainMatches(fromUrl, SYNDICATION_HOSTS)) return fromUrl;
  return publisherDomainFromName(fact.originalPublisher);
}

/**
 * Whether a fact's source is trusted. A page on an aggregator is trusted ONLY if it identifies an original publisher that is already trusted; hosting on Yahoo is never trust on its own, and nothing is added to the trusted list.
 */
export function isTrustedFactSource(fact: Pick<CandidateFact, "sourceUrl" | "originalPublisher" | "originalUrl">, teams: string[], trustedDomains: string[]): boolean {
  if (isSyndicationHost(fact.sourceUrl)) {
    const original = originalPublisherDomain(fact);
    return original ? isTrustedSource(`https://${original}/`, teams, trustedDomains) : false;
  }
  return isTrustedSource(fact.sourceUrl, teams, trustedDomains);
}

/** Whether a fact's source may be the story's PRIMARY (publicly credited) source: trusted (by its original publisher when syndicated) AND creditable. Evidence eligibility is wider (any non-blocked source). */
export function isEligiblePrimarySource(fact: Pick<CandidateFact, "sourceUrl" | "sourceTitle" | "originalPublisher" | "originalUrl">, teams: string[], trustedDomains: string[]): boolean {
  return isTrustedFactSource(fact, teams, trustedDomains) && isCreditablePage(fact.sourceUrl, fact.sourceTitle);
}

/** Current-state numbers and the Games that came after their evidence. */
const DAY = 86_400_000;
const evidenceTime = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  // A date with no time of day ("2026-10-19T00:00:00Z") covers that whole day.
  return /T00:00:00(\.000)?Z$/.test(iso) ? t + DAY - 1 : t;
};
export interface StaleCandidate {
  factId: string;
  reason: string;
}
/**
 * The deterministic freshness signal. Only a CURRENT_STATE number (season record, average, total, rank, streak, "so far") is checked, never a FIXED one (a specific score, last season's total, "entering the season").
 * It is a STALE_CANDIDATE when a relevant Game was COMPLETED after the number's evidence: the evidence date is the figure's own as-of date when the page gives one, otherwise the page date. No evidence date at all is also a candidate (freshness cannot be shown).
 * A candidate is not false: it must be refreshed (confirmed, updated or removed) before it can be published as current. "Relevant" = the most recent completed Game of the fact's own team, or of either team when the fact names none. An opener has no earlier Game, so nothing is stale.
 */
export function staleNumberCandidates(facts: CandidateFact[], game: Pick<GameIdentity, "lastCompleted" | "homeTeam" | "awayTeam">): StaleCandidate[] {
  // Unknown (the schedule data was not available) is not "none": freshness cannot be shown for any current-state number. Known-none (an opener) leaves nothing to be stale against.
  if (game.lastCompleted === undefined) return facts.filter((f) => f.numberKind === "CURRENT_STATE").map((f) => ({ factId: f.id, reason: "the latest completed Games are not known, so freshness cannot be shown" }));
  const completed = game.lastCompleted;
  if (completed.length === 0) return [];
  const out: StaleCandidate[] = [];
  for (const f of facts) {
    if (f.numberKind !== "CURRENT_STATE") continue;
    const own = f.subjectTeam ? completed.filter((c) => f.subjectTeam!.toLowerCase().includes(c.team.toLowerCase().split(" ").pop() ?? "") || c.team.toLowerCase().includes(f.subjectTeam!.toLowerCase())) : [];
    const relevant = own.length > 0 ? own : completed;
    const latest = Math.max(...relevant.map((c) => new Date(c.completedUtc).getTime()));
    const at = evidenceTime(f.asOf) ?? evidenceTime(f.publishedAt);
    if (at === null) out.push({ factId: f.id, reason: "a current-state number whose evidence has no date: freshness cannot be shown" });
    else if (at < latest) out.push({ factId: f.id, reason: `a Game was completed (${new Date(latest).toISOString().slice(0, 16)}Z) after this number's evidence (${new Date(at).toISOString().slice(0, 16)}Z)` });
  }
  return out;
}

/**
 * Whether a claim is actually stated in the PUBLIC title or caption: every number in the claim, and most of its distinctive words, appear in the text. A claim kept only in internal research metadata does not count (so a source that backs only such a claim is not shown publicly).
 */
export function claimAppearsInText(claim: string, text: string): boolean {
  const t = text.toLowerCase();
  const numbers = claim.match(/\d+(?:[.,:]\d+)?/g) ?? [];
  if (numbers.some((n) => !t.includes(n.toLowerCase()))) return false;
  const words = [...new Set((claim.toLowerCase().match(/[a-z]{5,}/g) ?? []))];
  if (words.length === 0) return numbers.length > 0;
  const present = words.filter((w) => t.includes(w.slice(0, Math.max(5, w.length - 2)))).length;
  return present / words.length >= 0.6;
}

/**
 * Whether a stored evidence passage looks CUT OFF before it proves anything: it ends in an ellipsis or a colon, a quotation is left open, or it ends on the setup of a quote ("when asked ...", a question) before the answer. Structural cues only; whether a passage
 * actually proves a claim is the verifier's and the reviewer's judgement. A passage with no issue may still be insufficient; a passage with an issue is never silently trusted.
 */
export function excerptIssues(excerpt: string | null | undefined): string[] {
  const t = (excerpt ?? "").trim();
  if (!t) return [];
  const issues: string[] = [];
  if (/(\.\.\.|\u2026|:)$/.test(t)) issues.push("ends in an ellipsis or a colon");
  const straight = (t.match(/"/g) ?? []).length;
  const opens = (t.match(/\u201C/g) ?? []).length;
  const closes = (t.match(/\u201D/g) ?? []).length;
  if (straight % 2 === 1 || opens !== closes) issues.push("a quotation is left open");
  const last = t.split(/(?<=[.!?])\s+/).pop() ?? "";
  if (/\?["'\u201D]?$/.test(last) || (/\b(when|if|as|after|before) (he was |she was |they were |being )?asked\b|\bwas asked\b|\bwere asked\b/i.test(last) && !/["\u201C]/.test(last))) issues.push("ends on a question or the setup of a quote, before its answer");
  return issues;
}

/** The Game's time frame as the freshness check needs it. */
export interface FreshnessContext {
  now: Date;
  currentFactMaxAgeHours: number;
}

/**
 * Why a fact needs ADDITIONAL verification, if it does. One inspected trusted source that clearly says what is claimed is enough, so such a fact needs none. Extra checking is for AMBIGUITY and RISK: a source outside the trusted group or a betting page, research's own flags
 * (ambiguous season/date/team, unusually surprising, trusted sources disagree), no passage showing the source says it, a current-season figure on a page that cannot place it in a season, and a CURRENT-STATE fact (an injury, availability, a league standing) that is undated or
 * older than the freshness window — which may be stale. An unresolved exception removes only its own story.
 */
export function verificationReasons(fact: CandidateFact, trusted: boolean, freshness?: FreshnessContext): string[] {
  const reasons: string[] = [];
  if (!trusted) reasons.push("the source is outside the trusted group");
  if (isBettingPage(fact.sourceUrl, fact.sourceTitle)) reasons.push("the page is a betting, odds or picks page");
  if (fact.disputed) reasons.push("trusted sources disagree about it");
  if (fact.ambiguous) reasons.push("the page is ambiguous about season, date or team");
  if (fact.surprising) reasons.push("the claim is unusually surprising or consequential");
  if (!fact.excerpt || !fact.excerpt.trim()) reasons.push("no passage shows that the source says it");
  else if (excerptIssues(fact.excerpt).length > 0) reasons.push(`the stored passage looks cut off (${excerptIssues(fact.excerpt)[0]})`);
  const undatedPage = ["profile", "archive", "reference", "other"].includes(fact.sourceType) && !fact.pageSeason && !fact.publishedAt;
  if (fact.seasonScope === "CURRENT_SEASON" && undatedPage) reasons.push("the page cannot place the figure in the current season");
  if (freshness && fact.kind === "current") {
    const published = fact.publishedAt ? new Date(fact.publishedAt).getTime() : NaN;
    if (!Number.isFinite(published)) reasons.push("a current-state fact whose source shows no publication date may be stale");
    else if (freshness.now.getTime() - published > freshness.currentFactMaxAgeHours * 3_600_000) reasons.push(`a current-state fact from a source older than ${freshness.currentFactMaxAgeHours} hours may be stale`);
  }
  return reasons;
}

/** Wagering language (contract: no betting odds, no wagering advice). Narrowed to terms that are only ever about betting: "favorites" and "underdogs" are ordinary sports prose. */
const WAGERING = /\b(odds|moneyline|point spread|against the spread|parlay|wager(?:s|ed|ing)?|bet(?:s|ting)?|sportsbook|over\/under|prop bets?)\b/i;
/** The contract's banned phrases. */
const BANNED_PHRASES = [/epic showdown/i, /must[- ]watch clash/i, /both teams (?:want|need|are looking for) (?:the|a) win/i];

/** The contract's style invariants, in code because they are deterministic: no em dash, no hashtag, no wagering language, no banned phrase. Returns what was found. */
export function styleProblems(text: string): string[] {
  const out: string[] = [];
  if (text.includes("\u2014")) out.push("It contains an em dash. Use a comma, a period or a colon.");
  if (/(^|\s)#\w/.test(text)) out.push("It contains a hashtag.");
  if (WAGERING.test(text)) out.push("It uses wagering language (odds, bets, spread, parlay). A Preview is not betting content.");
  for (const re of BANNED_PHRASES) if (re.test(text)) out.push(`It uses a banned phrase ("${text.match(re)![0]}").`);
  return out;
}

/** A time frame a statement claims for itself: "this season", "this year", "so far this season". */
const SEASON_QUALIFIER = /\b(this|the current) (season|year)\b|\bso far in 20\d\d\b/i;
/** What a fact must itself say to carry that time frame. */
const FACT_STATES_SEASON = /\b(this|the current) (season|year)\b|\bso far in 20\d\d\b|\b2026\b/i;


/** Words that make a status, an announcement, a forecast or a statistic provisional ("unlikely", "pretty sure", "so far", "as of"). A hint only: the reviewer decides whether the Preview kept that uncertainty and did not present an as-of figure as the current one. */
const HEDGE = /\b(unlikely|doubtful|questionable|probable|expected|projected|could|might|may|likely|day-to-day|game-time decision|hopes?|plans? to|is listed as|listed as|no guarantee|not yet cleared|has a chance|pretty sure|i think|reportedly|rumou?red|appears to|so far|as of|set to|poised to)\b/g;

/** Things worth a second look. NOT gates: the independent reader judges meaning; without a reader configured the pipeline falls back to treating unsupported DIGITS as blocking. */
export function draftHints(draft: DraftToValidate, facts: CandidateFact[]): DraftHints {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const cited = new Map<string, CandidateFact>();
  for (const c of draft.claims) for (const id of c.factIds) if (byId.has(id)) cited.set(id, byId.get(id)!);
  const supported = new Set<string>();
  for (const fact of cited.values()) for (const n of numbersIn(`${fact.claim} ${fact.excerpt ?? ""}`)) supported.add(n);
  const figures = [...claimedFigures(`${draft.hook} ${draft.preview}`)].filter((n) => !supported.has(n));
  const statesSeason = (f: CandidateFact) => FACT_STATES_SEASON.test(`${f.claim} ${f.excerpt ?? ""}`);
  const seasonClaims = draft.claims
    .filter((c) => SEASON_QUALIFIER.test(c.text) && c.factIds.length > 0 && !c.factIds.map((id) => byId.get(id)).filter((f): f is CandidateFact => Boolean(f)).some(statesSeason))
    .map((c) => c.text);
  // Status certainty: the hedges the cited facts carry ("unlikely to play", "questionable", "expected back"). The reviewer checks that the title and caption do not state more certainty than these.
  const hedges = [...cited.values()].flatMap((f) => [...new Set(`${f.claim} ${f.excerpt ?? ""}`.toLowerCase().match(HEDGE) ?? [])].map((h) => `${f.id}: "${h}"`));
  // Figures by scope: current-state numbers say what they are current THROUGH; fixed ones must not be written as the current figure ("already has 929" when 929 was the entering-season total).
  const staleNumbers = [...cited.values()].filter((f) => f.numberKind === "CURRENT_STATE").map((f) => `${f.id}: current through ${f.asOfLabel ?? f.asOf?.slice(0, 10) ?? f.publishedAt?.slice(0, 10) ?? "an unknown date"}`);
  const fixedNumbers = [...cited.values()].filter((f) => f.numberKind === "FIXED" && /\d/.test(f.claim)).map((f) => `${f.id}: ${f.asOfLabel ?? f.claim.slice(0, 70)}`);
  return { figures, seasonClaims, hedges, staleNumbers, fixedNumbers };
}

export function validateDraft({ draft, facts, config }: { draft: DraftToValidate; facts: CandidateFact[]; game?: GameIdentity; config: Pick<GamePreviewConfig, "maxChars" | "blockedDomains">; now?: Date }): ValidationResult {
  const problems: string[] = [];
  const hook = draft.hook.trim();
  const preview = draft.preview.trim();
  if (!hook) problems.push("The title is empty.");
  if (!preview) problems.push("The caption is empty.");
  // Title + caption together must be FEWER than the configured limit (contract: "fewer than 700 characters including spaces and punctuation"), counted exactly.
  const total = hook.length + preview.length;
  if (total >= config.maxChars) problems.push(`Title and caption together are ${total} characters; they must be fewer than ${config.maxChars}.`);

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
  }
  for (const q of unsupportedQuotes(`${hook} ${preview}`, [...cited.values()])) problems.push(`The quote "${q.slice(0, 80)}" is not in any cited source passage. Never write a quote the research did not capture.`);
  problems.push(...styleProblems(`${hook} ${preview}`));
  return { ok: problems.length === 0, problems };
}
