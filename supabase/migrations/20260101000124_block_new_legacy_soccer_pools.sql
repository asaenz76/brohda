-- Association football / soccer is retired as a Brohda sport. WHO_WILL_ADVANCE
-- and REGULATION_RESULT are the two legacy, SQL-graded pool types built
-- entirely around soccer semantics (penalty shootouts, extra time, a 3-way
-- regulation-time draw — see prepare_pool_settlement below). The app layer
-- already stops offering them (lib/pools/templates.ts's eligibility check),
-- but this is the DB-level backstop: even a direct/manipulated insert must
-- never be able to create a new pool of either type again.
--
-- This is a BEFORE INSERT trigger, deliberately not an UPDATE trigger and
-- not a CHECK constraint. Every pool-lifecycle operation on an existing row
-- (lock, settle, reverse, void, undo-grading, recovery) is an UPDATE, never
-- a re-INSERT — confirmed by grepping every migration in this repo for an
-- INSERT into public.pools, which found none outside pool creation itself
-- (all app-layer, via lib/actions/pools.ts). A CHECK constraint would also
-- reject every future UPDATE of an existing legacy-typed row (Postgres
-- re-validates CHECK on every UPDATE, not just INSERT), which would make
-- settling, reversing, or otherwise recovering any historical WHO_WILL_ADVANCE
-- or REGULATION_RESULT pool impossible — exactly the failure mode this
-- migration must avoid. A trigger scoped to INSERT has no such blast radius:
-- every existing row, and prepare_pool_settlement's own grading branch for
-- these two types, remains fully callable forever.
-- The trigger consults a transaction-local GUC (app.allow_legacy_pool_seed)
-- rather than unconditionally rejecting every legacy insert, so that
-- seed_legacy_pool_for_tests (below) — and only that function — can still
-- simulate a pre-existing historical row for regression coverage of
-- settlement/reversal logic on legacy pools. No real app code path ever
-- sets this GUC; current_setting's `missing_ok=true` makes an unset GUC
-- resolve to null (coalesced to 'false'), so every ordinary insert (the
-- overwhelming majority of transactions, which never touch this GUC at
-- all) is rejected exactly as before.
create or replace function public.reject_new_legacy_soccer_pool()
returns trigger
language plpgsql
security invoker
as $$
begin
  if new.pool_type in ('WHO_WILL_ADVANCE', 'REGULATION_RESULT')
     and coalesce(current_setting('app.allow_legacy_pool_seed', true), 'false') <> 'true' then
    raise exception 'legacy_soccer_pool_type_retired'
      using detail = 'WHO_WILL_ADVANCE and REGULATION_RESULT are retired — Association football is no longer a supported sport. Existing pools of these types remain fully gradable/reversible; only new creation is blocked.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_reject_new_legacy_soccer_pool on public.pools;
create trigger trg_reject_new_legacy_soccer_pool
  before insert on public.pools
  for each row
  execute function public.reject_new_legacy_soccer_pool();

-- Test/seed-only escape hatch: simulates a pool that already existed
-- before this retirement (a "historical" row), so integration tests and
-- scripts/seed-dev-grading.ts can still exercise legacy WHO_WILL_ADVANCE/
-- REGULATION_RESULT settlement, reversal, and grading logic without that
-- coverage silently disappearing. SECURITY DEFINER + revoked from
-- anon/authenticated, granted only to service_role — same trust boundary
-- as apply_wallet_transaction/create_pool_entry/prepare_pool_settlement
-- elsewhere in this schema. No real product code path (Server Action, RPC
-- called from the client, cron job) may ever call this; it exists purely
-- so "does a historical legacy pool still grade/settle/reverse correctly"
-- stays a real, running test rather than an untestable claim.
create or replace function public.seed_legacy_pool_for_tests(
  p_fixture_id uuid,
  p_created_by uuid,
  p_pool_type text,
  p_question text,
  p_entry_fee integer,
  p_house_fee_bps integer,
  p_min_total_entries integer,
  p_locks_at timestamptz
)
returns public.pools
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool public.pools;
begin
  if p_pool_type not in ('WHO_WILL_ADVANCE', 'REGULATION_RESULT') then
    raise exception 'seed_legacy_pool_for_tests only creates legacy soccer pool rows (WHO_WILL_ADVANCE/REGULATION_RESULT) — use the normal pool-creation action for every other pool_type.';
  end if;

  perform set_config('app.allow_legacy_pool_seed', 'true', true);

  insert into public.pools (
    fixture_id, created_by, pool_type, question, entry_fee, house_fee_bps,
    min_total_entries, open_at, locks_at, status
  ) values (
    p_fixture_id, p_created_by, p_pool_type::public.pool_type, p_question, p_entry_fee, p_house_fee_bps,
    p_min_total_entries, now(), p_locks_at, 'OPEN'
  )
  returning * into v_pool;

  return v_pool;
end;
$$;

revoke all on function public.seed_legacy_pool_for_tests from public, anon, authenticated;
grant execute on function public.seed_legacy_pool_for_tests to service_role;
