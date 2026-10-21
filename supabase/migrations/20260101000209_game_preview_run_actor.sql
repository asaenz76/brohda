-- Who asked for a manually triggered Game Preview generation (r116).
--
-- game_preview_runs gains `actor_id`: the authenticated Admin behind an ADMIN-triggered run. It is NULL for AUTOMATIC runs (automation never pretends to be a person) and for every run recorded before this migration
-- (the attribution of those is unknown and is deliberately not guessed). A DB-level rule keeps it honest: only an ADMIN run may carry an actor, and the actor must be a Super Admin.
-- Every run that carries an actor writes an audit event in the SAME transaction (`game_preview.generate`, actor, the Game, the generation run, the result), using the existing audit_logs table; there is no parallel log.

alter table public.game_preview_runs
  add column actor_id uuid references public.user_profiles (id) on delete set null;

comment on column public.game_preview_runs.actor_id is 'The authenticated Admin who triggered an ADMIN run. NULL for automatic runs and for runs recorded before attribution existed (unknown, never inferred).';

alter table public.game_preview_runs
  add constraint game_preview_runs_actor_only_admin check (actor_id is null or trigger = 'ADMIN');

create or replace function public.audit_game_preview_generation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.actor_id is null then
    return new;
  end if;
  if not public.is_super_admin(new.actor_id) then
    raise exception 'actor_not_admin';
  end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
  values (
    new.actor_id,
    'game_preview.generate',
    'game_preview_runs',
    new.id::text,
    jsonb_build_object('fixture_id', new.fixture_id, 'run_id', new.id, 'trigger', new.trigger, 'reason', new.reason, 'status', new.status, 'error', new.error, 'preview_id', new.preview_id, 'at', new.finished_at)
  );
  return new;
end;
$$;
revoke all on function public.audit_game_preview_generation() from public, anon, authenticated;

create trigger game_preview_runs_audit
after insert on public.game_preview_runs
for each row execute function public.audit_game_preview_generation();
