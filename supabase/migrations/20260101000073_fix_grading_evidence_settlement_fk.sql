-- pool_grading_evidence is append-only (no update/delete, even for
-- service_role — see 20260101000060) but its settlement_id column had a
-- hard FK to settlements. delete_terminal_pool deletes settlements rows for
-- any terminal (SETTLED/CANCELLED/VOIDED) pool once it's eligible for hard
-- deletion — so any TEMPLATE_GRADED pool that was graded through the
-- registry (which always writes evidence rows) became permanently
-- undeletable the moment it reached a terminal status, since the evidence
-- row referencing that settlement can never be removed to unblock it.
-- Matches the existing pool_id column on this same table (deliberately no
-- FK, per its own comment) and the precedent set for wallet_transactions/
-- audit_logs: never hard-FK an append-only table to a mutable entity.
alter table public.pool_grading_evidence
  drop constraint if exists pool_grading_evidence_settlement_id_fkey;

create index if not exists pool_grading_evidence_settlement_id_idx
  on public.pool_grading_evidence (settlement_id);
