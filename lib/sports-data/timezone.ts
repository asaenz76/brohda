// API-Football reports venue city, not an IANA timezone. Appendix X.7.2's
// same-calendar-day void rule needs a real timezone, so we resolve one at
// import time via this curated map, falling back to a competition default
// and finally the platform default (DEFAULT_TIMEZONE).
//
// This is necessarily a best-effort list (there's no free, reliable
// city -> timezone API in scope) — extend it as new venues come up.
const CITY_TIMEZONES: Record<string, string> = {
  london: "Europe/London",
  manchester: "Europe/London",
  liverpool: "Europe/London",
  birmingham: "Europe/London",
  madrid: "Europe/Madrid",
  barcelona: "Europe/Madrid",
  seville: "Europe/Madrid",
  paris: "Europe/Paris",
  marseille: "Europe/Paris",
  munich: "Europe/Berlin",
  berlin: "Europe/Berlin",
  dortmund: "Europe/Berlin",
  milan: "Europe/Rome",
  rome: "Europe/Rome",
  turin: "Europe/Rome",
  naples: "Europe/Rome",
  amsterdam: "Europe/Amsterdam",
  lisbon: "Europe/Lisbon",
  porto: "Europe/Lisbon",
  brussels: "Europe/Brussels",
  zurich: "Europe/Zurich",
  vienna: "Europe/Vienna",
  istanbul: "Europe/Istanbul",
  moscow: "Europe/Moscow",
  doha: "Asia/Qatar",
  riyadh: "Asia/Riyadh",
  tokyo: "Asia/Tokyo",
  seoul: "Asia/Seoul",
  shanghai: "Asia/Shanghai",
  beijing: "Asia/Shanghai",
  "mexico city": "America/Mexico_City",
  guadalajara: "America/Mexico_City",
  "buenos aires": "America/Argentina/Buenos_Aires",
  "rio de janeiro": "America/Sao_Paulo",
  "sao paulo": "America/Sao_Paulo",
  santiago: "America/Santiago",
  bogota: "America/Bogota",
  lima: "America/Lima",
  "san jose": "America/Costa_Rica",
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

  // NFL team-city venues (this map was originally built for European
  // soccer venues only, so every US city below was previously an unmapped
  // miss falling through to the platform default — confirmed live for
  // Canton while building the NFL provider).
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
