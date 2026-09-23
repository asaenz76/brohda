-- Milestone R13 remediation: `predictions.result`/`resolved_outcome_
-- snapshot`/`graded_at`/`lifecycle_state`/`selected_outcome` had no
-- field-level immutability trigger, unlike sibling tables in the same
-- R1-R12 range (markets_forbid_identity_mutation, posts_forbid_fixture_
-- reassignment, communities_forbid_subject_mutation). The guarantee that a
-- graded Pick's result is permanent rested entirely on "no application
-- code path calls a raw UPDATE on these columns" — the weaker of the two
-- guarantees this project otherwise prefers, and a real gap given
-- `predictions.result` is the exact source of truth
-- `settle_monetary_position()` reads to move real money.
--
-- markPredictionGraded() (lib/predictions/repository.ts) already scopes
-- its own UPDATE with `.eq("lifecycle_state", "PENDING")`, i.e. it only
-- ever performs the legitimate PENDING -> GRADED transition — this
-- trigger codifies that same rule at the DB layer: once a row is already
-- GRADED, any further attempt to change its result, snapshot, timestamp,
-- lifecycle state, or the selected_outcome that was graded is rejected
-- outright, regardless of caller (including service_role, which is the
-- only role with UPDATE on this table). set_pick()'s own edit path
-- (20260101000152) only ever touches selected_outcome/probabilities/
-- snapshots while a Pick is still PENDING and unlocked, so this trigger
-- never blocks a legitimate pre-grading edit.
create or replace function public.forbid_graded_prediction_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.lifecycle_state = 'GRADED' and (
    new.result is distinct from old.result
    or new.resolved_outcome_snapshot is distinct from old.resolved_outcome_snapshot
    or new.graded_at is distinct from old.graded_at
    or new.lifecycle_state is distinct from old.lifecycle_state
    or new.selected_outcome is distinct from old.selected_outcome
  ) then
    raise exception 'predictions.% is GRADED — result/resolved_outcome_snapshot/graded_at/lifecycle_state/selected_outcome are immutable once graded; grading is a permanent, one-shot transition, never re-derived or corrected in place', old.id;
  end if;
  return new;
end;
$$;

create trigger predictions_forbid_graded_mutation
before update on public.predictions
for each row execute function public.forbid_graded_prediction_mutation();

comment on column public.predictions.result is
  'CORRECT | INCORRECT | VOID, set exactly once by markPredictionGraded() at the PENDING -> GRADED transition. Immutable thereafter — enforced by predictions_forbid_graded_mutation, not merely by application convention.';

comment on column public.predictions.graded_at is
  'Set exactly once alongside result. Immutable once the row is GRADED (predictions_forbid_graded_mutation).';
