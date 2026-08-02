-- Three genuinely distinct integrity-failure modes that route a pool to
-- MANUAL_REVIEW — kept as separate values rather than one shared reason,
-- since each needs its own admin-facing explanation and its own upstream
-- cause:
--   BINARY_OPTIONS_UNRESOLVABLE   — a TEMPLATE_GRADED pool's pool_options
--                                   don't resolve to exactly one YES and
--                                   one NO (advance_or_cancel_locked_pool).
--   TEMPLATE_VERSION_UNRESOLVABLE — pools.template_id/template_version no
--                                   longer resolves to a known registry
--                                   entry at grading time (grade.ts).
--   TEMPLATE_CONFIG_INVALID       — the stored template_config no longer
--                                   validates against its resolved
--                                   version's schema at grading time
--                                   (grade.ts).
create type public.pool_review_reason as enum (
  'BINARY_OPTIONS_UNRESOLVABLE',
  'TEMPLATE_VERSION_UNRESOLVABLE',
  'TEMPLATE_CONFIG_INVALID'
);

alter table public.pools add column review_reason public.pool_review_reason;
