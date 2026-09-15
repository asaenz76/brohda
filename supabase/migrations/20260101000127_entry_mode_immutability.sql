-- FREE prediction mode — entry_mode immutability (§6).
--
-- Extends the existing enforce_pool_fee_immutability trigger (already bound
-- to pools as pools_enforce_fee_immutability) so entry_mode freezes once a
-- pool has its first entry, exactly like question/pool_type/title/
-- template_id/template_config already do. Deliberately NOT given the same
-- relaxation entry_fee/house_fee_bps got in 20260101000072 — converting an
-- active PAID pool to FREE in place (or vice versa) must never be possible,
-- since it would silently invalidate every already-collected entry's
-- meaning. One-line addition to an existing trigger function; no new
-- trigger object.

create or replace function public.enforce_pool_fee_immutability()
returns trigger
language plpgsql
as $$
begin
  if old.first_entry_at is not null then
    if new.question <> old.question
      or new.pool_type <> old.pool_type
      or new.entry_mode <> old.entry_mode
      or coalesce(new.title, '') <> coalesce(old.title, '')
      or coalesce(new.template_id, '') <> coalesce(old.template_id, '')
      or coalesce(new.template_config, '{}'::jsonb) <> coalesce(old.template_config, '{}'::jsonb)
      or coalesce(new.recommendation_evidence, '{}'::jsonb) <> coalesce(old.recommendation_evidence, '{}'::jsonb)
    then
      raise exception 'pool fields are frozen after the first entry';
    end if;

    if new.locks_at > old.locks_at then
      raise exception 'lock time may only move earlier after the first entry';
    end if;
  end if;

  return new;
end;
$$;
