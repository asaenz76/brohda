import type { GamePreviewSource, PublicPreviewSource } from "./types";
import { domainOf, isBettingPage, isStoryPage } from "./validation";

/** Publisher names Members know, by domain. A team's own site reads as the team ("Chargers.com"); anything else falls back to the provider the research named, then to the domain. */
const KNOWN: Record<string, string> = {
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

export function sourceDisplayName(url: string, provider: string | null | undefined): string {
  const host = domainOf(url);
  const known = Object.entries(KNOWN).find(([d]) => host === d || host.endsWith(`.${d}`));
  if (known) return known[1];
  const named = (provider ?? "").trim();
  if (named && named.toLowerCase() !== host) return named;
  const label = host.split(".").slice(-2)[0] ?? host;
  return host.split(".").length >= 2 ? `${label.charAt(0).toUpperCase()}${label.slice(1)}.com` : host || "Source";
}

/**
 * The sources a Member sees under a Preview. The stored sources are ordered primary first; a new Preview records exactly which of them are public (`publicSourceUrls`, one or at most two). A Preview saved before that was recorded shows its
 * first source only. Never a bibliography: at most two, and always at least one when any source exists.
 */
export function derivePublicSources(rows: Array<Pick<GamePreviewSource, "url" | "provider" | "title" | "publishedAt">>, meta: Record<string, unknown> | null | undefined): PublicPreviewSource[] {
  const recorded = Array.isArray(meta?.publicSourceUrls) ? (meta!.publicSourceUrls as unknown[]).map(String) : [];
  // A betting, odds or picks page is never the credited primary source. A Preview whose primary source is one has nothing eligible to credit and is not shown; a betting page is never listed as an "Also".
  const primaryUrl = typeof meta?.primarySourceUrl === "string" ? meta.primarySourceUrl : (recorded[0] ?? rows[0]?.url);
  const primaryRow = rows.find((r) => r.url === primaryUrl) ?? rows[0];
  // The credit must link to the original page a Member can read: a data endpoint (a JSON scoreboard or schedule API) is not one, so such a Preview is not shown either.
  if (primaryRow && (isBettingPage(primaryRow.url, primaryRow.title) || !isStoryPage(primaryRow.url))) return [];
  const listed = recorded.length > 0 ? recorded.map((u) => rows.find((r) => r.url === u)).filter((r): r is NonNullable<typeof r> => Boolean(r)) : rows.slice(0, 1);
  const chosen = listed.filter((r) => !isBettingPage(r.url, r.title) && isStoryPage(r.url));
  const seen = new Set<string>();
  return chosen
    .filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)))
    .slice(0, 2)
    .map((r) => ({ url: r.url, name: sourceDisplayName(r.url, r.provider), title: r.title || null, publishedAt: r.publishedAt }));
}
