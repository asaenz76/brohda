// Brohda 2.1 M3 — the ONE place source trust is decided. Prompts never carry trust rules; the public UI never decides trust.
//
// Hierarchy (highest first): official league → official team → primary statistical/structured data → major sports journalism → reputable local/team reporting → other credible reporting.
// Social media, forums, wikis, aggregators and sportsbook/odds pages are never evidence of a fact: they may only help discover a story, so they are excluded here.
// Configuration can ADD preferred domains (promoted to local-reporting trust) and ADD blocked domains. It can never un-block a built-in blocked domain.
import type { ClaimType, EvidenceType, GameContext, SourceKind, StoryConfig } from "./types";

/** Authority score (0–100) by source kind. */
export const AUTHORITY: Readonly<Record<SourceKind, number>> = {
  OFFICIAL_LEAGUE: 90,
  OFFICIAL_TEAM: 85,
  STRUCTURED_DATA: 95,
  MAJOR_JOURNALISM: 75,
  LOCAL_JOURNALISM: 60,
  OTHER_REPORTING: 40,
};

const LEAGUE_DOMAINS = ["nfl.com", "nba.com", "nhl.com", "mlb.com", "wnba.com"];
const MAJOR_JOURNALISM_DOMAINS = [
  "espn.com", "apnews.com", "reuters.com", "theathletic.com", "nytimes.com", "washingtonpost.com", "si.com", "cbssports.com", "nbcsports.com", "foxsports.com",
  "usatoday.com", "sportsnet.ca", "tsn.ca", "nbcnews.com", "cbsnews.com", "wsj.com", "bbc.com", "profootballtalk.com",
];
/** Never evidence: sportsbook/odds, social, forums, wikis, aggregators. */
export const BUILT_IN_BLOCKED_DOMAINS = [
  "draftkings.com", "fanduel.com", "betmgm.com", "caesars.com", "bet365.com", "oddsshark.com", "actionnetwork.com", "covers.com", "vegasinsider.com", "sportsbettingdime.com", "bovada.lv",
  "reddit.com", "twitter.com", "x.com", "facebook.com", "instagram.com", "tiktok.com", "threads.net", "snapchat.com", "discord.com", "telegram.org", "youtube.com", "youtu.be",
  "wikipedia.org", "fandom.com", "quora.com", "medium.com", "substack.com", "blogspot.com", "wordpress.com", "tumblr.com",
];

export const normalizeHost = (host: string): string => host.trim().toLowerCase().replace(/^www\./, "");

export function hostOf(url: string): string | null {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

export const domainMatches = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);
const matchesAny = (host: string, domains: readonly string[]): boolean => domains.some((d) => domainMatches(host, normalizeHost(d)));

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A team's own site: the host's registrable label is the team's name or nickname (patriots.com, mapleleafs.com, celtics.com). Only the two teams of the Game are considered. */
export function isOfficialTeamHost(host: string, game: Pick<GameContext, "homeTeam" | "awayTeam">): boolean {
  const label = host.split(".").slice(-2, -1)[0] ?? "";
  const labelSlug = slug(label);
  if (labelSlug.length < 4) return false;
  return [game.homeTeam, game.awayTeam].some((team) => {
    const full = slug(team);
    const nickname = slug(team.trim().split(/\s+/).slice(-1)[0] ?? "");
    const city = slug(team.trim().split(/\s+/).slice(0, -1).join(" "));
    return labelSlug === full || (nickname.length >= 4 && labelSlug === nickname) || (nickname.length >= 4 && labelSlug === `${city}${nickname}`);
  });
}

export interface SourceClassification {
  kind: SourceKind;
  authority: number;
  /** A blocked source is excluded from evidence, with the reason recorded. */
  blocked: boolean;
  reason: string | null;
}

export function classifySource(url: string | null, game: Pick<GameContext, "homeTeam" | "awayTeam">, config: Pick<StoryConfig, "preferredDomains" | "blockedDomains">): SourceClassification {
  const host = url ? hostOf(url) : null;
  if (!host) return { kind: "OTHER_REPORTING", authority: 0, blocked: true, reason: "no_valid_url" };
  if (matchesAny(host, BUILT_IN_BLOCKED_DOMAINS)) return { kind: "OTHER_REPORTING", authority: 0, blocked: true, reason: "not_a_factual_source" };
  if (matchesAny(host, config.blockedDomains)) return { kind: "OTHER_REPORTING", authority: 0, blocked: true, reason: "blocked_by_configuration" };
  if (matchesAny(host, LEAGUE_DOMAINS)) return { kind: "OFFICIAL_LEAGUE", authority: AUTHORITY.OFFICIAL_LEAGUE, blocked: false, reason: null };
  if (isOfficialTeamHost(host, game)) return { kind: "OFFICIAL_TEAM", authority: AUTHORITY.OFFICIAL_TEAM, blocked: false, reason: null };
  if (matchesAny(host, MAJOR_JOURNALISM_DOMAINS)) return { kind: "MAJOR_JOURNALISM", authority: AUTHORITY.MAJOR_JOURNALISM, blocked: false, reason: null };
  if (matchesAny(host, config.preferredDomains)) return { kind: "LOCAL_JOURNALISM", authority: AUTHORITY.LOCAL_JOURNALISM, blocked: false, reason: null };
  return { kind: "OTHER_REPORTING", authority: AUTHORITY.OTHER_REPORTING, blocked: false, reason: null };
}

/** The lowest authority that may establish a claim of this type. High-risk claims need a stronger source; a quote or an availability claim from a weak source is never enough. */
export function minAuthorityForClaim(type: ClaimType): number {
  switch (type) {
    case "AVAILABILITY":
    case "QUOTE":
    case "TRANSACTION":
      return 60;
    default:
      return 40;
  }
}

/** The evidence type a source of this kind is expected to be (a hint for normalisation; structured data is always STRUCTURED). */
export function defaultEvidenceType(kind: SourceKind): EvidenceType {
  return kind === "STRUCTURED_DATA" ? "STRUCTURED" : kind === "OFFICIAL_LEAGUE" || kind === "OFFICIAL_TEAM" ? "OFFICIAL_STATEMENT" : "ARTICLE";
}

/** Tracking parameters and fragments do not make a URL a different page. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    const keep = [...u.searchParams.entries()].filter(([k]) => !/^(utm_|fbclid|gclid|mc_|ref$|source$|cmp$|ocid$)/i.test(k));
    keep.sort(([a], [b]) => a.localeCompare(b));
    const query = keep.length ? `?${keep.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
    return `${normalizeHost(u.hostname)}${u.pathname.replace(/\/+$/, "")}${query}`;
  } catch {
    return url.trim().toLowerCase();
  }
}
