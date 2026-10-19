import type { GamePreviewSource, PublicPreviewSource } from "./types";
import { domainOf } from "./validation";

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
  const chosen = recorded.length > 0 ? recorded.map((u) => rows.find((r) => r.url === u)).filter((r): r is NonNullable<typeof r> => Boolean(r)) : rows.slice(0, 1);
  const seen = new Set<string>();
  return chosen
    .filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)))
    .slice(0, 2)
    .map((r) => ({ url: r.url, name: sourceDisplayName(r.url, r.provider), title: r.title || null, publishedAt: r.publishedAt }));
}
