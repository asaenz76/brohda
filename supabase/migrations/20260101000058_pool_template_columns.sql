-- template_id identifies which registry entry (lib/pools/templates/registry.ts)
-- graded this pool; template_config is that template's admin-entered,
-- structured config (e.g. {"team":"HOME","minimumMargin":2}). Both nullable
-- since only TEMPLATE_GRADED pools use them — every existing pool_type is
-- untouched.
alter table public.pools
  add column template_id text,
  add column template_config jsonb;

-- Re-created wholesale (Postgres functions are replaced, not patched) to
-- also freeze template_id/template_config once first_entry_at is set,
-- alongside the existing frozen fields. Same logic as the
-- 20260101000042_combo_pools.sql version otherwise.
create or replace function public.enforce_pool_fee_immutability()
returns trigger
language plpgsql
as $$
begin
  if old.first_entry_at is not null then
    if new.entry_fee <> old.entry_fee
      or new.house_fee_bps <> old.house_fee_bps
      or new.question <> old.question
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
