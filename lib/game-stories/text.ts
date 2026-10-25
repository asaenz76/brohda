// Brohda 2.1 M3 — small, pure text helpers shared by evidence normalisation, claim verification and copy rules.

/** Characters that carry no meaning in evidence text but can hide instructions or break layouts: control characters, zero-width and bidi overrides, HTML tags. */
export function sanitizeText(value: string, maxLength: number): string {
  return value
    .replace(/<[^>]{0,200}>/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** Text a retrieved page might use to instruct the system or the model. Such an item is quarantined (never drafted from); a real sports fact never reads like this. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts?|rules|messages)/i,
  /disregard (all |any |the )?(previous|prior|above|earlier|your) (instructions|prompts?|rules|guidelines)/i,
  /\b(system|developer) (prompt|message|instruction)s?\b/i,
  /you are (now|no longer) (a|an|the|in)\b/i,
  /\b(reveal|print|output|show|leak) (your|the) (system |hidden |secret )?(prompt|instructions|api[ -]?key|secrets?|credentials?)\b/i,
  /\bapi[ _-]?key\b|\bsecret[ _-]?key\b|\bservice[ _-]?role\b|\bbearer [a-z0-9._-]{12,}/i,
  /\b(set|give|assign|score|rate) (all )?(the )?(scores?|ratings?|dimensions?) (to|as|=)\b/i,
  /\b(publish|approve|accept) (this|the) (story|draft|copy|article) (automatically|immediately|now)\b/i,
  /\bdo not (verify|check|reject|flag)\b/i,
  /\bnew (instructions?|rules?|task)\s*:/i,
  /<\|?(im_start|im_end|system|assistant|endoftext)\|?>/i,
  /\[\/?(INST|SYS)\]/i,
  /\b(assistant|system|user)\s*:\s*(ignore|you|from now)/i,
  /\bexecute (this )?(command|code|script)\b|\brun the following (command|code)\b/i,
];
export const looksLikeInjection = (value: string): boolean => INJECTION_PATTERNS.some((p) => p.test(value));

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  once: 1, twice: 2, thrice: 3, double: 2, triple: 3, dozen: 12,
};
/** Words that read as numbers but are pure grammar ("second" as a unit of time is rare in copy; "one" as a pronoun is common) are NOT treated as figures on their own. */
const AMBIGUOUS_WORDS = new Set(["one", "second", "first", "once", "double"]);

/** Numeric figures stated in a text, as canonical strings: digits (commas removed), decimals, and number words. Ambiguous words only count when written as a digit. */
export function numbersIn(text: string, options: { includeAmbiguousWords?: boolean } = {}): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/(?<![a-z0-9])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![a-z0-9])|(?<![a-z])(\d+)(?:st|nd|rd|th)\b/g)) {
    const whole = (m[1] ?? m[3] ?? "").replace(/,/g, "");
    if (!whole) continue;
    out.add(m[2] ? `${Number(whole)}.${m[2]}` : String(Number(whole)));
  }
  // hyphenated/slashed records such as 4-1 or 108-103 are covered by the digit pattern (digits bounded by non-alphanumerics)
  for (const m of lower.matchAll(/\b([a-z]+)\b/g)) {
    const n = NUMBER_WORDS[m[1]];
    if (n === undefined) continue;
    if (AMBIGUOUS_WORDS.has(m[1]) && !options.includeAmbiguousWords) continue;
    out.add(String(n));
  }
  return out;
}

/** Everything a text says numerically, including the ambiguous words, for the EVIDENCE side of a comparison (evidence may legitimately say "one"). */
export const evidenceNumbers = (text: string): Set<string> => numbersIn(text, { includeAmbiguousWords: true });

/** Remove team names (and their nicknames) so digits inside names ("49ers", "76ers") are not read as figures. */
export function stripTeamNames(text: string, teams: readonly string[]): string {
  let out = text;
  for (const team of teams) {
    const words = team.trim().split(/\s+/);
    const forms = new Set<string>([team, words[words.length - 1] ?? "", words.slice(0, -1).join(" ")].filter((w) => w.length >= 3));
    for (const f of forms) out = out.replace(new RegExp(`\\b${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), " ");
  }
  return out;
}

/** Lower-case, punctuation-free, single-spaced: used to compare quotes and phrases regardless of typography. */
export const normalizeForCompare = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const tokensOf = (value: string): string[] => normalizeForCompare(value).split(" ").filter(Boolean);

/** Jaccard similarity of two texts' word sets (0–1). Used to spot repeated copy across Games. */
export function similarity(a: string, b: string): number {
  const A = new Set(tokensOf(a));
  const B = new Set(tokensOf(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}
