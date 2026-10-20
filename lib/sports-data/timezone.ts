// A provider reports venue city, not an IANA timezone. The same-calendar-
// day void rule needs a real timezone, so we resolve one at import time via
// this curated map, falling back to a competition default and finally the
// platform default (DEFAULT_TIMEZONE).
//
// This is necessarily a best-effort list (there's no free, reliable
// city -> timezone API in scope) — extend it as new venues come up. Entries
// below are kept because they serve NFL today or a plausible future NBA/
// NHL/MLB venue; every city that existed here solely for a retired
// Association-football/soccer competition (the European domestic leagues,
// Liga MX/Argentina/Brasileirão/Chile/Colombia/Peru/Costa Rica, and World-
// Cup/Saudi-league host cities) has been removed.
const CITY_TIMEZONES: Record<string, string> = {
  tokyo: "Asia/Tokyo",
  seoul: "Asia/Seoul",
  shanghai: "Asia/Shanghai",
  beijing: "Asia/Shanghai",
  "new york": "America/New_York",
  "los angeles": "America/Los_Angeles",
  miami: "America/New_York",
  atlanta: "America/New_York",
  toronto: "America/Toronto",
  sydney: "Australia/Sydney",
  auckland: "Pacific/Auckland",
  cairo: "Africa/Cairo",
  lagos: "Africa/Lagos",
  johannesburg: "Africa/Johannesburg",

  // NFL team-city venues (confirmed live for Canton while building the
  // NFL provider).
  glendale: "America/Phoenix",
  baltimore: "America/New_York",
  buffalo: "America/New_York",
  charlotte: "America/New_York",
  chicago: "America/Chicago",
  cincinnati: "America/New_York",
  cleveland: "America/New_York",
  arlington: "America/Chicago",
  denver: "America/Denver",
  detroit: "America/New_York",
  "green bay": "America/Chicago",
  houston: "America/Chicago",
  indianapolis: "America/Indiana/Indianapolis",
  jacksonville: "America/New_York",
  "kansas city": "America/Chicago",
  "las vegas": "America/Los_Angeles",
  inglewood: "America/Los_Angeles",
  minneapolis: "America/Chicago",
  nashville: "America/Chicago",
  foxborough: "America/New_York",
  "new orleans": "America/Chicago",
  "east rutherford": "America/New_York",
  philadelphia: "America/New_York",
  pittsburgh: "America/New_York",
  "santa clara": "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  tampa: "America/New_York",
  landover: "America/New_York",
  canton: "America/New_York",
  // NFL venues the map was missing (found by the r111 audit: their rows silently took the platform fallback, America/Costa_Rica) and the league's international games.
  "orchard park": "America/New_York",
  "miami gardens": "America/New_York",
  london: "Europe/London",
  dublin: "Europe/Dublin",
  paris: "Europe/Paris",
  "saint-denis": "Europe/Paris",
  madrid: "Europe/Madrid",
  munich: "Europe/Berlin",
  berlin: "Europe/Berlin",
  frankfurt: "Europe/Berlin",
  "mexico city": "America/Mexico_City",
  "rio de janeiro": "America/Sao_Paulo",
  "sao paulo": "America/Sao_Paulo",
  melbourne: "Australia/Melbourne",
};

export function resolveVenueTimezone(
  venueCity: string | null | undefined,
  competitionDefaultTz: string | null | undefined,
): string {
  const fallback = process.env.DEFAULT_TIMEZONE || "America/Costa_Rica";

  if (venueCity) {
    const match = CITY_TIMEZONES[venueCity.trim().toLowerCase()];
    if (match) return match;
  }

  return competitionDefaultTz || fallback;
}

/** The timezone the curated map gives a venue city, or null when the city is not in it. Unlike `resolveVenueTimezone` this never falls back to a default. */
export function mappedVenueTimezone(venueCity: string | null | undefined): string | null {
  return venueCity ? (CITY_TIMEZONES[venueCity.trim().toLowerCase()] ?? null) : null;
}

/**
 * The stored venue timezone, but only when it is TRUSTWORTHY: it is exactly what the curated map gives the venue's city. A row that took the platform fallback (the city was not in the map, or the provider gave no venue) carries a default that says nothing about the venue,
 * so it must not be used to describe a local kickoff time (a Paris game labelled America/Costa_Rica reads an hour wrong). Null means "state the time in UTC".
 */
export function trustedVenueTimezone(venueCity: string | null | undefined, storedTimezone: string | null | undefined): string | null {
  const mapped = mappedVenueTimezone(venueCity);
  return mapped && storedTimezone === mapped ? mapped : null;
}
