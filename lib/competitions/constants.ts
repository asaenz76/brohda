// Two separate windows, deliberately not one shared value — "we should
// import this soon" (Recommended eligibility) and "this league is useful
// for pool creation right now" (Active vs. Prepared) are different
// questions with different urgency.
export const RECOMMENDATION_WINDOW_DAYS = 30;
export const ACTIVATION_WINDOW_DAYS = 14;

// Import chunk bounds — a chunk is capped by whichever limit is hit first.
// NormalizedFixture embeds the *entire* raw provider payload per fixture
// (see lib/sports-data/persist.ts's toFixtureRow, which stores it into
// fixtures.provider_payload), so the byte bound is the real backstop, not
// the fixture count — a fixture count alone can't predict serialized size.
export const IMPORT_CHUNK_MAX_FIXTURES = 150;
export const IMPORT_CHUNK_MAX_BYTES = 500_000;

// A chunk stops being retried once it has failed this many times — at
// that point its fixtures count as permanently failed and the job as a
// whole becomes FAILED (see recalculate_import_job_progress).
export const IMPORT_JOB_MAX_ATTEMPTS = 5;

// How many processable chunks the cron claims per tick — bounds a single
// invocation's duration regardless of how many chunks are queued overall.
export const IMPORT_CHUNKS_PER_CRON_TICK = 10;

// How long a SUCCEEDED chunk's (potentially sizeable) fixtures_payload is
// kept before being reclaimed — job/chunk metadata (status, counts,
// timestamps, errors) is kept indefinitely; only the payload is cleared.
export const CHUNK_PAYLOAD_RECOVERY_WINDOW = "24 hours";

// Recommendation-availability cache TTLs — a league with upcoming fixtures
// last check is worth re-checking sooner than one that had none.
export const AVAILABILITY_CACHE_TTL_WITH_FIXTURES_HOURS = 6;
export const AVAILABILITY_CACHE_TTL_NO_FIXTURES_HOURS = 24;

// How often an already-imported, active competition gets re-scanned for
// newly scheduled/rescheduled fixtures (discover-competitions cron) —
// matches the availability cache's "has fixtures" TTL, since both are
// answering a similar "how fresh does this need to be" question.
export const DISCOVERY_SYNC_INTERVAL_HOURS = 6;

// How many due competitions the discovery cron re-scans per tick — bounds
// a single invocation's duration the same way IMPORT_CHUNKS_PER_CRON_TICK
// does for chunk processing.
export const DISCOVERY_COMPETITIONS_PER_CRON_TICK = 10;
