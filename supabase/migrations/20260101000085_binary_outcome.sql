-- Stage 1 of "Evolve TEMPLATE_GRADED into PollPools' default binary
-- prediction system": give the existing Yes/No pool_options a stable
-- semantic outcome, independent of their display label.

create type public.binary_outcome as enum ('YES', 'NO');

alter table public.pool_options add column binary_outcome public.binary_outcome;

-- Prevents a future duplicate YES (or duplicate NO) row per pool. Partial
-- so 3-way WHO_WILL_ADVANCE/REGULATION_RESULT options (binary_outcome
-- always null) are never constrained by this.
create unique index pool_options_unique_binary_outcome
on public.pool_options (pool_id, binary_outcome)
where binary_outcome is not null;

-- Structurally conservative backfill (not just a pre-check): only a pool
-- whose options are EXACTLY {one 'Yes', one 'No'} gets backfilled. Any
-- other shape (extra/missing options, relabeled options, a third option)
-- is left with binary_outcome = null permanently — gradeTemplatePool's
-- label-based fallback (see grade.ts) keeps grading those correctly.
with clean_binary_pools as (
  select pool_id
  from public.pool_options
  group by pool_id
  having count(*) = 2
    and count(*) filter (where label = 'Yes') = 1
    and count(*) filter (where label = 'No') = 1
)
update public.pool_options po
set binary_outcome = case po.label
  when 'Yes' then 'YES'::public.binary_outcome
  when 'No' then 'NO'::public.binary_outcome
end
from clean_binary_pools cbp
where po.pool_id = cbp.pool_id
  and po.label in ('Yes', 'No');

-- Freezes an option's semantic identity once its pool has taken its first
-- entry — label/binary_outcome/external_team_id/team_name/sort_order can
-- never change underneath a pool players have already joined. entry_count/
-- total_entry_amount/is_winning_option are deliberately NOT covered here —
-- those are supposed to keep changing (entries, then settlement).
create or replace function public.enforce_pool_option_semantics_immutability()
returns trigger
language plpgsql
as $$
declare
  v_first_entry_at timestamptz;
begin
  select first_entry_at into v_first_entry_at
    from public.pools where id = old.pool_id;

  if v_first_entry_at is not null then
    if new.label <> old.label
      or new.binary_outcome is distinct from old.binary_outcome
      or new.external_team_id is distinct from old.external_team_id
      or new.team_name is distinct from old.team_name
      or new.sort_order <> old.sort_order
    then
      raise exception 'pool option semantics are frozen after the first entry';
    end if;
  end if;

  return new;
end;
$$;

create trigger pool_options_enforce_semantics_immutability
before update on public.pool_options
for each row execute function public.enforce_pool_option_semantics_immutability();
