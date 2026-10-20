# Venue timezone audit (r111)

Found while reviewing the Game Preview pilot: the Pittsburgh Steelers @ New Orleans Saints Game (Oct 25, 2026) had `venue_timezone = America/Costa_Rica`. The Game is actually played at the Stade de France in Saint-Denis (Paris), so the defect is not about New Orleans: it is that any venue city missing from the curated map silently takes the platform default.

## Where the value comes from
- The provider reports a venue CITY, never an IANA timezone. `lib/sports-data/timezone.ts` resolves it with a curated city map (`CITY_TIMEZONES`); a city not in the map falls back to the competition default and then to `DEFAULT_TIMEZONE` (`America/Costa_Rica`). The result is stored in `fixtures.venue_timezone` (migration 008) and is re-resolved on every sync upsert (`lib/sports-data/persist.ts`).
- NBA and NHL providers return no venue at all: `venue_city` and `venue_timezone` are NULL (2,675 fixtures). That is honest, not wrong.

## Who is affected (production, 2026-10-20)
- NFL: 29 of 321 fixtures took the fallback, all with a venue city that was missing from the map: Orchard Park (10), Miami Gardens (10), and the league's international games (London 3, Melbourne, Mexico City, Rio de Janeiro, Madrid, Munich, Saint-Denis: 1 each).
- The retired football (soccer) competitions: about 2,300 fixtures took the fallback (most cities outside the original list). They are not served anymore and were left alone.

## Downstream impact
`venue_timezone` is read in exactly one place outside the importer: the Game Preview generator (`lib/game-previews/automation.ts`), which used it to describe the scheduled start in local time. Nothing else reads it:
- Displayed kickoff: rendered in the viewer's own timezone from `scheduled_start_utc`.
- Prediction lock, post-start generation guard, grading and scheduling: all UTC.
- Notifications: not timezone-dependent on this column.
- The "same-calendar-day void rule" the column was added for is not implemented yet (the migration comment says Phase 4/5); when it is, a fallback timezone would be wrong for these venues, which is why the map is fixed rather than the column ignored.

So the only live effect was a Preview prompt saying "Sun, Oct 25, 2026, 8:25 AM America/Costa_Rica" for a Paris game.

## Fix (no hard-coded Game patch)
1. The map now contains the NFL's missing and international venues (Orchard Park, Miami Gardens, London, Dublin, Paris, Saint-Denis, Madrid, Munich, Berlin, Frankfurt, Mexico City, Rio de Janeiro, Sao Paulo, Melbourne). The next sync run re-resolves every affected row; no backfill or migration is needed.
2. New `trustedVenueTimezone(city, storedTz)`: the Game Preview generator now uses the stored timezone only when it is exactly what the map gives the venue's city. A fallback value (or no venue) means the scheduled start is stated in UTC only, never in a wrong local time. This protects against the next unmapped city too.
3. Tests: `tests/unit/venue-timezone.test.ts`.

## Not changed
`resolveVenueTimezone` still falls back to `DEFAULT_TIMEZONE` for unmapped cities (the platform rule the column was designed around). Whether the retired soccer cities should be mapped, or the fallback should become NULL, is a product decision for when the void rule is built.
