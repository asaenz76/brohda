// Brohda 2.1 M3 — automatic rejection rules on the COPY itself. These run in code, regardless of score and regardless of what a model says about its own output.
//
// A story is rejected if it: exceeds the configured length, is about the wrong Game, contains betting language or advice, proposes a gradeable proposition other than "which team wins",
// contains hashtags/links/AI disclaimers/generic calls to action, trips the unsafe-content list, or is generic filler. (Unsupported/contradicted/stale/unclaimed facts are rejected in claims.ts and the pipeline.)
import { normalizeForCompare, similarity } from "./text";
import type { GameContext, RejectionCode, StoryConfig } from "./types";

export interface RuleViolation {
  code: RejectionCode;
  detail: string;
}

/** Sportsbook vocabulary and betting advice. The story is Game-first: pricing is never the editorial spine. */
const GAMBLING = /\b(point spread|(?:the|a|\d+(?:\.\d+)?-point) spread|against the spread|ats|over\/under|over-under|moneylines?|odds|betting|bettors?|bets?|wagers?|wagering|parlays?|sportsbooks?|bookmakers?|handicap(?:per|ping)?|lock of the (?:day|week)|(?:cover|covers|covered) the (?:spread|number|line|points?|total)|juice|vig|prop bets?|futures bets?|implied probability|gambl\w+)\b/i;
/** Any proposition other than the team winner: totals, margins, firsts, individual lines. */
const EXTRA_PROPOSITION = /\b(?:over|under) \d+\.\d+\b|\b(?:goes|go|going|hit|hits|cash|cashes|cashing|take|takes) (?:the )?(?:over|under)\b|\btotal (?:points|goals|runs)\b|\bby (?:more|less|at least) than \d+\b|\bwin by \d+|\bfirst (?:to|team to) score\b|\bwill (?:score|record|total|combine|throw|rush)\b.{0,30}\b(?:more|fewer|over|under) than\b|\bto (?:score|record) (?:over|under|at least)\b/i;
const HASHTAG_OR_LINK = /(^|\s)#\w+|https?:\/\/|\bwww\.\S+|\b\S+\.(?:com|net|org|io)\b/i;
const AI_DISCLAIMER = /\b(as an ai|ai[- ]generated|generated (?:by|with) (?:ai|claude|gpt)|language model|i (?:cannot|can't) (?:verify|browse))\b/i;
const CALL_TO_ACTION = /\b(pick a side|make your pick|make your prediction|vote (?:now|below)|let us know|comment below|sound off|drop your pick|tell us)\b/i;
/** Deliberately small and strict (sports copy legitimately says "kill", "dead", "attack"): self-harm incitement, sexual violence, slurs-by-category are handled by the model's own safety flag as well. */
const UNSAFE = /\b(kill yourself|commit suicide|rape[sd]?|nazi|terroris[tm])\b/i;

/** Filler that says nothing about THIS matchup. */
const GENERIC_PHRASES: readonly string[] = [
  "both teams want the win",
  "both teams want to win",
  "should be an exciting game",
  "should be an exciting matchup",
  "should be a great game",
  "anything can happen",
  "these teams are ready to battle",
  "who will come out on top",
  "who will win",
  "can't wait for this one",
  "this one has it all",
  "a battle for the ages",
  "expect fireworks",
  "it's going to be a good one",
  "two teams looking to",
  "looking to bounce back",
  "all eyes will be on",
  "needs no introduction",
];

/** Short forms of team names that real sports copy uses. Key = the alias, value = text that the team's full name contains. */
const TEAM_ALIASES: Readonly<Record<string, string>> = {
  philly: "philadelphia", cavs: "cavaliers", wolves: "timberwolves", twolves: "timberwolves", mavs: "mavericks", pats: "patriots", bucs: "buccaneers", niners: "49ers", sixers: "76ers", blazers: "trail blazers",
  habs: "canadiens", isles: "islanders", pens: "penguins", caps: "capitals", preds: "predators", bolts: "lightning", wings: "red wings", jackets: "blue jackets", leafs: "maple leafs", nugs: "nuggets",
  dubs: "warriors", celts: "celtics", grizz: "grizzlies", clips: "clippers", cards: "cardinals", fins: "dolphins", jags: "jaguars", okc: "oklahoma city", nola: "new orleans", kc: "kansas city", gb: "green bay", tb: "tampa bay",
};

export function checkCopyRules(hook: string, body: string, config: Pick<StoryConfig, "maxChars">, game: Pick<GameContext, "homeTeam" | "awayTeam">): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const text = `${hook}\n${body}`;
  const total = hook.length + body.length;
  if (!hook.trim() || !body.trim()) violations.push({ code: "INVALID_COPY", detail: "A story needs both a hook and a body." });
  else if (hook.trim().length < 5 || body.trim().length < 20) violations.push({ code: "INVALID_COPY", detail: "The hook or the body is too short to be a story." });
  if (total > config.maxChars) violations.push({ code: "OVER_LENGTH", detail: `The story is ${total} characters; the limit is ${config.maxChars}.` });

  const lower = normalizeForCompare(text);
  const mentions = (team: string) => {
    const words = team.trim().split(/\s+/);
    const forms = [team, words[words.length - 1], words.slice(0, -1).join(" ")].filter((w) => w.length >= 3).map(normalizeForCompare);
    // common short forms writers actually use ("Philly", "Cavs", "Pats"): an alias counts when the team's own name contains the key it stands for
    for (const [alias, standsFor] of Object.entries(TEAM_ALIASES)) if (normalizeForCompare(team).includes(standsFor)) forms.push(alias);
    return forms.some((f) => new RegExp(`(^| )${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`).test(lower) || (f.length >= 5 && lower.includes(f)));
  };
  if (!mentions(game.homeTeam) && !mentions(game.awayTeam)) violations.push({ code: "WRONG_GAME", detail: "The story names neither team of this Game." });

  const gambling = text.match(GAMBLING);
  if (gambling) violations.push({ code: "GAMBLING_COPY", detail: `Betting language ("${gambling[0]}") is not allowed; the story is Game-first.` });
  const extra = text.match(EXTRA_PROPOSITION);
  if (extra) violations.push({ code: "EXTRA_PROPOSITION", detail: `The copy proposes something other than which team wins ("${extra[0].trim()}").` });
  if (HASHTAG_OR_LINK.test(text)) violations.push({ code: "INVALID_COPY", detail: "Hashtags, links and web addresses are not allowed in a story." });
  if (AI_DISCLAIMER.test(text)) violations.push({ code: "INVALID_COPY", detail: "AI disclaimers are not allowed in a story." });
  if (CALL_TO_ACTION.test(text)) violations.push({ code: "GENERIC_FILLER", detail: "Generic calls to action are not allowed; the Pick buttons are the call to action." });
  if (UNSAFE.test(text)) violations.push({ code: "UNSAFE_CONTENT", detail: "The copy contains prohibited content." });
  const phrase = GENERIC_PHRASES.find((p) => lower.includes(normalizeForCompare(p)));
  if (phrase) violations.push({ code: "GENERIC_FILLER", detail: `Generic filler ("${phrase}") says nothing about this matchup.` });
  return violations;
}

/** The hook of an earlier story reused almost word for word is not original. */
export const maxSimilarityToRecent = (hook: string, recentHooks: readonly string[]): number => recentHooks.reduce((m, h) => Math.max(m, similarity(hook, h)), 0);
