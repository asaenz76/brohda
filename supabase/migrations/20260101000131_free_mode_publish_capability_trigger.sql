-- FREE prediction mode — Phase 2 (creation/publish capability trigger, §5.2 item 1).
--
-- A courtesy layer, not the primary boundary (that's create_pool_entry's
-- entry-time check, migration 128) — stops an admin from publishing a new
-- pool of a currently-disabled mode. Same fail-closed treatment
-- (IS DISTINCT FROM TRUE, explicit not-found handling) and the same
-- FOR SHARE lock as the entry-time check, for consistency; this introduces
-- no new deadlock risk since this trigger's transaction already locks its
-- own `pools` row (the row being inserted/updated) before this SELECT
-- runs — same canonical order as create_pool_entry (§13).
--
-- Scoped precisely to the DRAFT/absent -> OPEN transition so it never
-- fires on ordinary lifecycle writes (lock, grade, settle, void) to a pool
-- that's already OPEN.

create or replace function public.enforce_pool_capability()
returns trigger
language plpgsql
as $$
declare
  v_paid_enabled boolean;
  v_free_enabled boolean;
begin
  if NEW.status = 'OPEN' and (TG_OP = 'INSERT' or OLD.status is distinct from 'OPEN') then
    select paid_pools_enabled, free_pools_enabled
      into v_paid_enabled, v_free_enabled
      from public.platform_settings
      where id = true
      for share;

    if NEW.entry_mode = 'PAID' then
      if not found then
        raise exception 'platform_settings_missing';
      end if;
      if v_paid_enabled is distinct from true then
        raise exception 'paid_pools_disabled';
      end if;
    else
      if not found then
        raise exception 'platform_settings_missing';
      end if;
      if v_free_enabled is distinct from true then
        raise exception 'free_pools_disabled';
      end if;
    end if;
  end if;

  return NEW;
end;
$$;

create trigger pools_enforce_capability
before insert or update on public.pools
for each row execute function public.enforce_pool_capability();
