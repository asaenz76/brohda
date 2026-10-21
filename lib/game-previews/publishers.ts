/**
 * Publisher identity. The names Members know, by domain, and the reverse: a name a syndicated page gives for its ORIGINAL publisher ("Originally appeared on Sports Illustrated") can be mapped to a domain only when it is one of these known publishers.
 * An aggregator (Yahoo, MSN, AOL) hosting a story does not make the story trusted: the original publisher's identity decides, and only if that publisher is already trusted.
 */
/** Publisher names Members know, by domain. A team's own site reads as the team ("Chargers.com"); anything else falls back to the provider the research named, then to the domain. */
export const KNOWN_PUBLISHERS: Record<string, string> = {
  "espn.com": "ESPN",
  "nfl.com": "NFL.com",
  "nhl.com": "NHL.com",
  "nba.com": "NBA.com",
  "mlb.com": "MLB.com",
  "foxsports.com": "FOX Sports",
  "cbssports.com": "CBS Sports",
  "nbcsports.com": "NBC Sports",
  "apnews.com": "Associated Press",
  "reuters.com": "Reuters",
  "theathletic.com": "The Athletic",
  "si.com": "Sports Illustrated",
  "pro-football-reference.com": "Pro Football Reference",
  "hockey-reference.com": "Hockey Reference",
  "basketball-reference.com": "Basketball Reference",
};


/** Extra spellings of known publishers as pages write them. */
const ALIASES: Record<string, string> = { "sports illustrated": "si.com", si: "si.com", "the athletic": "theathletic.com", ap: "apnews.com", "ap news": "apnews.com", "associated press": "apnews.com", "nfl": "nfl.com", "nba": "nba.com", "nhl": "nhl.com", "mlb": "mlb.com" };

const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();

/** The domain of a known publisher named by a page, or null when the name is not a known publisher (never guessed). */
export function publisherDomainFromName(name: string | null | undefined): string | null {
  const n = norm(name ?? "");
  if (!n) return null;
  if (ALIASES[n]) return ALIASES[n];
  const hit = Object.entries(KNOWN_PUBLISHERS).find(([, label]) => norm(label) === n);
  return hit ? hit[0] : null;
}

/** Hosts that republish other publishers' stories. Hosting there says nothing about the original's trust. */
export const SYNDICATION_HOSTS = ["yahoo.com", "msn.com", "aol.com"];
