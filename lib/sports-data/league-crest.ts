// A Game's league identity — the competition's name and crest — for every Game/prediction card.
//
// ONE canonical source: the competition fields the provider adapter stores on the fixture (`competition_name`, `competition_logo_url`, the same row
// that mirrors into `leagues`). That is the existing, trusted branding path (the NFL's crest is self-hosted by its adapter because the provider CDN
// copy was unreliable; the others are the provider's own CDN, the same host as the team logos). A new sport — MLB — needs no UI change: its adapter
// fills the same fields and the card renders them.
//
// The identity comes from the GAME, never from a Market: every Market of a Game shows the same crest. Nothing here (or in a component) names a
// league or maps a league to an image.
export interface LeagueIdentity {
  /** The league's name, as the provider reports it ("NBA"). Null only when the provider sent none. */
  name: string | null;
  /** A usable crest URL (https, or a self-hosted root-relative asset); null when there is none worth rendering. */
  crestUrl: string | null;
}

const isUsableUrl = (url: string | null | undefined): url is string =>
  typeof url === "string" && (url.startsWith("https://") || /^\/[^/]/.test(url));

const reported = new Set<string>();

export function resolveLeagueIdentity(input: { competitionName: string | null; competitionLogoUrl: string | null }, report: (message: string) => void = (m) => console.warn(m)): LeagueIdentity {
  const name = input.competitionName?.trim() || null;
  if (isUsableUrl(input.competitionLogoUrl)) return { name, crestUrl: input.competitionLogoUrl };
  // Missing / unusable crest: the card falls back to the league name as text. Reported once per league per process, never per card.
  const key = name ?? "(unnamed league)";
  if (!reported.has(key)) {
    reported.add(key);
    report(`[league-crest] no usable crest for "${key}" — rendering the league name only`);
  }
  return { name, crestUrl: null };
}

/** Test seam: forget which missing crests were already reported. */
export function resetLeagueCrestReports(): void {
  reported.clear();
}
