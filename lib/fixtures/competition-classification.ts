// Best-effort, name-pattern-based classification for the date-first
// fixture discovery workflow's default filters ("Exclude friendlies",
// "Exclude youth competitions", "Exclude reserve competitions" — see
// app/(admin)/admin/fixtures, mode=date). API-Football has no structured
// field for any of this (confirmed: NormalizedLeague.type is only ever
// "League"/"Cup"); there is no per-competition ID allowlist here either —
// every check is a generic pattern applied uniformly to whatever
// competition/team name the provider returns, deliberately not a
// hardcoded list of specific competitions. This is inherently imprecise
// (a league genuinely named e.g. "Reserve League Trophy" would still slip
// through some edge case), which is why every one of these filters stays
// admin-toggleable rather than an unconditional hard exclusion.
const FRIENDLY_PATTERN = /\bfriendl(?:y|ies)\b/i;
const YOUTH_PATTERN = /\b(u1[0-9]|u2[0-3])\b|\byouth\b|\bjunior(?:s)?\b/i;
const RESERVE_PATTERN = /\breserves?\b|\b(ii|b)\s*$/i;

export interface CompetitionClassification {
  isFriendly: boolean;
  isYouth: boolean;
  isReserve: boolean;
}

/**
 * Classifies a competition (and optionally the two team names, since a
 * reserve fixture is often only signaled on the team side — e.g.
 * "Barcelona II" playing in an otherwise ordinary-looking league) using
 * simple, generic name patterns. Every flag defaults false when nothing
 * matches — never assume friendly/youth/reserve from absence of data.
 */
export function classifyCompetition(
  competitionName: string | null,
  teamNames: readonly string[] = [],
): CompetitionClassification {
  const haystacks = [competitionName, ...teamNames].filter((s): s is string => Boolean(s));
  return {
    isFriendly: haystacks.some((s) => FRIENDLY_PATTERN.test(s)),
    isYouth: haystacks.some((s) => YOUTH_PATTERN.test(s)),
    isReserve: haystacks.some((s) => RESERVE_PATTERN.test(s)),
  };
}
