-- Beta testing needs the Coordinator fee (and entry stake) adjustable even
-- after a pool has entries — e.g. dropping the fee to 0% mid-pool to
-- encourage participation. question/pool_type/title/template_id/
-- template_config stay frozen (those define what the pool IS, not its
-- economics), as does "lock time may only move earlier."
create or replace function public.enforce_pool_fee_immutability()
returns trigger
language plpgsql
as $$
begin
  if old.first_entry_at is not null then
    if new.question <> old.question
      or new.pool_type <> old.pool_type
      or coalesce(new.title, '') <> coalesce(old.title, '')
      or coalesce(new.template_id, '') <> coalesce(old.template_id, '')
      or coalesce(new.template_config, '{}'::jsonb) <> coalesce(old.template_config, '{}'::jsonb)
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
