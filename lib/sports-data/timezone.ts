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
