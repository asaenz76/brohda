-- correct_prediction_log (20260101000018_leaderboard.sql) has real FKs to
-- pools/settlements with no ON DELETE clause — it only survives today
-- because reverse_pool_settlement and delete_terminal_pool (both in
-- 20260101000047) each delete these rows first, in the right order, before
-- deleting the settlement/pool. Any future code path that deletes a pool or
-- settlement without going through those two functions hits an FK
-- violation instead of a clear error. Matches the exact precedent already
-- set for pool_grading_evidence's own settlement_id FK (20260101000073):
-- never hard-FK an append-only log table to a mutable entity — drop the
-- constraint, keep an index for the query patterns that used it.
alter table public.correct_prediction_log
  drop constraint if exists correct_prediction_log_pool_id_fkey;

alter table public.correct_prediction_log
  drop constraint if exists correct_prediction_log_settlement_id_fkey;

create index if not exists correct_prediction_log_pool_idx
  on public.correct_prediction_log (pool_id);
