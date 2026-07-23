-- User-facing analytics (date-range boundaries, day/week/month buckets,
-- chart labels) need a real IANA timezone to be correct — UTC storage is
-- fine, UTC *bucketing* is not (a Jul 31 23:58 America/Costa_Rica entry
-- is Aug 1 05:58 UTC, and a UTC-bucketed monthly chart would silently
-- misfile it into August). Validation/canonicalization happens at the
-- application layer (Zod + Intl.DateTimeFormat, which rejects raw UTC
-- offsets and normalizes casing) before this column is ever written —
-- this column has no CHECK constraint because Postgres has no built-in
-- IANA-name validator usable in a CHECK (pg_timezone_names is a view,
-- not queryable from a CHECK constraint).
alter table public.user_profiles
  add column analytics_timezone text not null default 'America/Costa_Rica';
