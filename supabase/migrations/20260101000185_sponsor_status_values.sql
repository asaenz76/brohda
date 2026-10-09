-- Sponsor account lifecycle (identity milestone, step 1 of 2): the two new states. Postgres will not let a value added to an enum be used in the same transaction,
-- so the values are added here and everything that uses them is in the next migration.
alter type public.sponsor_status add value if not exists 'PENDING_REVIEW';
alter type public.sponsor_status add value if not exists 'REJECTED';
