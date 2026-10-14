-- r80 — Milestone 2 final owner decisions.
--
--   1. A canonical account-closure marker (user_profiles.account_closed_at), so Messaging retention never infers closure from missing profile data, inactivity or email state.
--   2. Block is a relationship boundary beyond Messaging: it also stops Call BS between the pair and direct replies between them (comments stay public and are never deleted).
--   3. A canonical Call BS expiry reason, with the "ignored" policy centralised: only a genuine NO_RESPONSE counts against a Member.
--   4. Coherent Messaging retention: semantic defaults, a purge that follows the closure marker, and narrowly scoped, auditable retention holds.
--   5. Bounded, auditable abuse signals (flag by default; a temporary restriction only where an explicit, switched-on rule allows it).
--   6. Generic reporter outcome notifications.
--
-- Additive except where a function is replaced with a superset of its previous behaviour. The Messaging capability and every new switch default to the safe state.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 1. Canonical account closure
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.user_profiles add column account_closed_at timestamptz;
comment on column public.user_profiles.account_closed_at is 'Set once, by close_own_account(), when a Member closes their own account. The single source of truth for "this account was closed" — is_active is also cleared by an admin deactivation, so it cannot tell the two apart. Never cleared.';
create index user_profiles_account_closed_idx on public.user_profiles (account_closed_at) where account_closed_at is not null;

create or replace function public.user_profiles_closure_guard()
returns trigger
language plpgsql
as $$
begin
  raise exception 'account_closed_at is set once and never changed';
end;
$$;
create trigger user_profiles_closure_guard
  before update of account_closed_at on public.user_profiles
  for each row when (old.account_closed_at is not null and new.account_closed_at is distinct from old.account_closed_at)
  execute function public.user_profiles_closure_guard();

create or replace function public.close_own_account(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_balance bigint;
  v_pending_requests int;
begin
  select balance into v_balance
  from public.wallet_balances
  where user_id = p_user_id and account_type = 'user';

  if v_balance is null then
    raise exception 'wallet_not_found';
  end if;

  if v_balance != 0 then
    raise exception 'nonzero_balance';
  end if;

  select count(*) into v_pending_requests
  from public.wallet_requests
  where user_id = p_user_id and status = 'pending';

  if v_pending_requests > 0 then
    raise exception 'pending_wallet_request';
  end if;

  update public.user_profiles
  set is_active = false,
      account_closed_at = coalesce(account_closed_at, now()),
      display_name = 'Deleted User',
      username = null,
      avatar_url = null,
      bio = null,
      pronouns = null,
      gender = null,
      stories_last_seen_at = null
  where id = p_user_id;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 2. Block as a relationship boundary
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Is there a block between these two Members, in EITHER direction? The one place that question is answered.
create or replace function public.members_blocked(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.member_blocks where (blocker_id = p_a and blocked_id = p_b) or (blocker_id = p_b and blocked_id = p_a));
$$;
revoke all on function public.members_blocked(uuid, uuid) from public, anon, authenticated;
grant execute on function public.members_blocked(uuid, uuid) to service_role;

comment on table public.member_blocks is 'A Member-level block: a relationship boundary between two Members. It stops direct Messaging, Message Requests, Call BS in either direction and direct replies between the pair, and lets the blocker hide the other Member''s comments from their own view. It never deletes or hides anyone''s public comments for other Members.';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 3. Call BS expiry reason
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.challenges add column expiry_reason text
  check (expiry_reason in ('NO_RESPONSE', 'GAME_OR_MARKET_CANCELLED', 'SYSTEM_INVALIDATED', 'COMPETING_CHALLENGE_RESOLVED', 'ACCOUNT_STATE_CHANGE', 'RELATIONSHIP_BLOCKED', 'OTHER_SYSTEM_REASON'));
comment on column public.challenges.expiry_reason is 'Why a Call BS ended without being answered. Set exactly when status = EXPIRED. Only NO_RESPONSE (nobody answered in time) can ever count against a Member; every other reason is system- or relationship-driven. Rows that expired before this column existed are OTHER_SYSTEM_REASON: their cause was never recorded, so they are deliberately never counted as ignored.';

-- History: the cause was never recorded, so none of it may count against anyone.
update public.challenges set expiry_reason = 'OTHER_SYSTEM_REASON' where status = 'EXPIRED' and expiry_reason is null;

-- The invariant: EXPIRED always carries a reason and nothing else does. A writer that forgets to name one gets OTHER_SYSTEM_REASON (excluded from "ignored"), never a silent NULL.
create or replace function public.challenges_expiry_reason_guard()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'EXPIRED' then
    new.expiry_reason := coalesce(new.expiry_reason, 'OTHER_SYSTEM_REASON');
  else
    new.expiry_reason := null;
  end if;
  return new;
end;
$$;
create trigger challenges_expiry_reason_guard before insert or update on public.challenges for each row execute function public.challenges_expiry_reason_guard();
alter table public.challenges add constraint challenges_expiry_reason_shape check ((status = 'EXPIRED') = (expiry_reason is not null));

-- THE policy: which expiry reasons count as "ignored". Challenge response rate and "Challenges ignored" both read this, nowhere else. (Mirrored by lib/challenges/expiry.ts and a parity test.)
create or replace function public.challenge_expiry_counts_as_ignored(p_reason text)
returns boolean
language sql
stable -- not immutable: an immutable function with constant arguments is folded at plan time, which would skip the EXECUTE privilege check below
as $$
  select p_reason = 'NO_RESPONSE';
$$;
revoke all on function public.challenge_expiry_counts_as_ignored(text) from public, anon, authenticated;
grant execute on function public.challenge_expiry_counts_as_ignored(text) to service_role;

-- The reason for a Call BS that ran out of time because of the Game or Market it names: a cancelled / postponed / suspended / abandoned Game or a deactivated Market is not the recipient's silence,
-- an unknown provider status is the system's, and anything else (the Game started or finished with the challenge unanswered) is a genuine NO_RESPONSE.
create or replace function public.challenge_game_expiry_reason(p_fixture_status public.fixture_internal_status, p_market_status text)
returns text
language sql
stable
as $$
  select case
    when p_market_status = 'INACTIVE' or p_fixture_status in ('POSTPONED', 'SUSPENDED', 'ABANDONED', 'CANCELLED') then 'GAME_OR_MARKET_CANCELLED'
    when p_fixture_status = 'UNKNOWN' then 'SYSTEM_INVALIDATED'
    else 'NO_RESPONSE'
  end;
$$;
revoke all on function public.challenge_game_expiry_reason(public.fixture_internal_status, text) from public, anon, authenticated;
grant execute on function public.challenge_game_expiry_reason(public.fixture_internal_status, text) to service_role;

-- A recipient's response record, computed ONLY through the policy above. "Answerable" = accepted + declined + genuinely ignored; Call BS still pending, or ended for a system reason, is in neither number.
create or replace function public.call_bs_response_stats(p_recipient_id uuid)
returns table (answerable integer, accepted integer, declined integer, ignored integer, response_rate numeric)
language sql
stable
security definer
set search_path = public
as $$
  with c as (
    select
      (count(*) filter (where accepted_at is not null))::integer as n_accepted,
      (count(*) filter (where status = 'DECLINED'))::integer as n_declined,
      (count(*) filter (where status = 'EXPIRED' and public.challenge_expiry_counts_as_ignored(expiry_reason)))::integer as n_ignored
    from public.challenges
    where recipient_user_id = p_recipient_id
  )
  select n_accepted + n_declined + n_ignored, n_accepted, n_declined, n_ignored,
         case when n_accepted + n_declined + n_ignored = 0 then null else round((n_accepted + n_declined)::numeric / (n_accepted + n_declined + n_ignored), 4) end
  from c;
$$;
revoke all on function public.call_bs_response_stats(uuid) from public, anon, authenticated;
grant execute on function public.call_bs_response_stats(uuid) to service_role;

-- Sending a Call BS: unchanged except that a block between the pair, in either direction, refuses it. The refusal is one neutral code for both directions so it never reveals who blocked whom.
create or replace function public.call_bs(p_challenger_user_id uuid, p_recipient_prediction_id uuid)
returns challenges
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_recipient_pred public.predictions;
  v_challenger_pred public.predictions;
  v_fixture_status public.fixture_internal_status;
  v_scheduled_start timestamptz;
  v_lock_minutes integer;
  v_effective_lock_at timestamptz;
  v_enabled boolean;
  v_result public.challenges;
  v_challenger_active boolean;
  v_recipient_active boolean;
begin
  select coalesce(call_bs_enabled, false) into v_enabled from public.platform_settings where id = true;
  if not coalesce(v_enabled, false) then
    raise exception 'call_bs_disabled';
  end if;

  select * into v_recipient_pred from public.predictions where id = p_recipient_prediction_id;
  if not found then
    raise exception 'recipient_pick_not_found';
  end if;

  select coalesce(is_active, false) into v_recipient_active from public.user_profiles where id = v_recipient_pred.user_id;
  if not coalesce(v_recipient_active, false) then
    raise exception 'recipient_inactive';
  end if;

  select coalesce(is_active, false) into v_challenger_active from public.user_profiles where id = p_challenger_user_id;
  if not coalesce(v_challenger_active, false) then
    raise exception 'challenger_inactive';
  end if;

  if public.members_blocked(p_challenger_user_id, v_recipient_pred.user_id) then
    raise exception 'relationship_blocked';
  end if;

  select * into v_challenger_pred from public.predictions where user_id = p_challenger_user_id and market_id = v_recipient_pred.market_id;
  if not found then
    raise exception 'challenger_pick_not_found';
  end if;

  if v_challenger_pred.user_id = v_recipient_pred.user_id then
    raise exception 'self_challenge';
  end if;

  if v_challenger_pred.selected_outcome = v_recipient_pred.selected_outcome then
    raise exception 'picks_not_opposing';
  end if;

  if v_challenger_pred.lifecycle_state = 'GRADED' or v_recipient_pred.lifecycle_state = 'GRADED' then
    raise exception 'pick_already_graded';
  end if;

  select f.internal_status, f.scheduled_start_utc
    into v_fixture_status, v_scheduled_start
    from public.markets m
    join public.fixtures f on f.id = m.fixture_id
    where m.id = v_recipient_pred.market_id;

  if not found then
    raise exception 'market_not_found';
  end if;

  select coalesce(pick_lock_minutes_before_kickoff, 10) into v_lock_minutes from public.platform_settings where id = true;
  v_effective_lock_at := v_scheduled_start - (coalesce(v_lock_minutes, 10) || ' minutes')::interval;

  if now() >= v_effective_lock_at or v_fixture_status <> 'NOT_STARTED' then
    raise exception 'past_challenge_cutoff';
  end if;

  begin
    insert into public.challenges (
      market_id, challenger_user_id, recipient_user_id,
      challenger_prediction_id, recipient_prediction_id,
      challenger_selection_snapshot, recipient_selection_snapshot
    ) values (
      v_recipient_pred.market_id, p_challenger_user_id, v_recipient_pred.user_id,
      v_challenger_pred.id, v_recipient_pred.id,
      v_challenger_pred.selected_outcome, v_recipient_pred.selected_outcome
    )
    returning * into v_result;
    return v_result;
  exception when unique_violation then
    raise exception 'duplicate_pending_challenge';
  end;
end;
$function$;

-- Accepting: the same rules as before, each EXPIRED now naming its cause, plus the block rule (a blocked pair can never become an accepted Call BS).
create or replace function public.accept_call_bs(p_challenge_id uuid, p_recipient_user_id uuid)
returns accept_call_bs_result
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_challenge public.challenges;
  v_lower public.predictions;
  v_upper public.predictions;
  v_challenger_pred public.predictions;
  v_recipient_pred public.predictions;
  v_fixture_status public.fixture_internal_status;
  v_market_status text;
  v_scheduled_start timestamptz;
  v_lock_minutes integer;
  v_effective_lock_at timestamptz;
  v_result public.challenges;
  v_first_user uuid;
  v_second_user uuid;
  v_conflict_count integer;
  v_challenger_active boolean;
  v_recipient_active boolean;
begin
  select * into v_challenge from public.challenges where id = p_challenge_id for update;
  if not found then
    raise exception 'challenge_not_found';
  end if;

  if v_challenge.recipient_user_id <> p_recipient_user_id then
    raise exception 'not_recipient';
  end if;

  if v_challenge.status <> 'PENDING' then
    return (v_challenge, 'not_pending')::public.accept_call_bs_result;
  end if;

  if v_challenge.challenger_user_id < v_challenge.recipient_user_id then
    v_first_user := v_challenge.challenger_user_id;
    v_second_user := v_challenge.recipient_user_id;
  else
    v_first_user := v_challenge.recipient_user_id;
    v_second_user := v_challenge.challenger_user_id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_challenge.market_id::text || ':' || v_first_user::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(v_challenge.market_id::text || ':' || v_second_user::text, 0));

  select coalesce(is_active, false) into v_challenger_active from public.user_profiles where id = v_challenge.challenger_user_id;
  select coalesce(is_active, false) into v_recipient_active from public.user_profiles where id = v_challenge.recipient_user_id;
  if not coalesce(v_challenger_active, false) or not coalesce(v_recipient_active, false) then
    update public.challenges set status = 'EXPIRED', expiry_reason = 'ACCOUNT_STATE_CHANGE', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_ineligible_account')::public.accept_call_bs_result;
  end if;

  -- A block between the pair ends the challenge (the answer is the same neutral "no longer available" an invalidated one gets, so it reveals nothing about who blocked whom).
  if public.members_blocked(v_challenge.challenger_user_id, v_challenge.recipient_user_id) then
    update public.challenges set status = 'EXPIRED', expiry_reason = 'RELATIONSHIP_BLOCKED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_invalidated')::public.accept_call_bs_result;
  end if;

  select count(*) into v_conflict_count
  from public.challenges
  where market_id = v_challenge.market_id
    and status = 'ACCEPTED'
    and id <> v_challenge.id
    and (challenger_user_id in (v_challenge.challenger_user_id, v_challenge.recipient_user_id)
         or recipient_user_id in (v_challenge.challenger_user_id, v_challenge.recipient_user_id));

  if v_conflict_count > 0 then
    update public.challenges set status = 'EXPIRED', expiry_reason = 'COMPETING_CHALLENGE_RESOLVED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_already_paired')::public.accept_call_bs_result;
  end if;

  select f.internal_status, f.scheduled_start_utc, m.status::text
    into v_fixture_status, v_scheduled_start, v_market_status
    from public.markets m
    join public.fixtures f on f.id = m.fixture_id
    where m.id = v_challenge.market_id;

  if not found then
    update public.challenges set status = 'EXPIRED', expiry_reason = 'SYSTEM_INVALIDATED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_invalidated')::public.accept_call_bs_result;
  end if;

  select coalesce(pick_lock_minutes_before_kickoff, 10) into v_lock_minutes from public.platform_settings where id = true;
  v_effective_lock_at := v_scheduled_start - (coalesce(v_lock_minutes, 10) || ' minutes')::interval;

  if now() >= v_effective_lock_at or v_fixture_status <> 'NOT_STARTED' then
    update public.challenges set status = 'EXPIRED', expiry_reason = public.challenge_game_expiry_reason(v_fixture_status, v_market_status), updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_cutoff')::public.accept_call_bs_result;
  end if;

  if v_challenge.challenger_prediction_id < v_challenge.recipient_prediction_id then
    select * into v_lower from public.predictions where id = v_challenge.challenger_prediction_id for update;
    select * into v_upper from public.predictions where id = v_challenge.recipient_prediction_id for update;
    v_challenger_pred := v_lower;
    v_recipient_pred := v_upper;
  else
    select * into v_lower from public.predictions where id = v_challenge.recipient_prediction_id for update;
    select * into v_upper from public.predictions where id = v_challenge.challenger_prediction_id for update;
    v_challenger_pred := v_upper;
    v_recipient_pred := v_lower;
  end if;

  -- (Pick-lock interpretation unchanged: CUTOFF closes the Pick; CHALLENGE_ACCEPTED means it already belongs to a free pairing; MONETARY_POSITION_ACCEPTED does not block a free Call BS.)
  if v_challenger_pred.lock_reason = 'CUTOFF' or v_recipient_pred.lock_reason = 'CUTOFF' then
    update public.challenges set status = 'EXPIRED', expiry_reason = 'NO_RESPONSE', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_cutoff')::public.accept_call_bs_result;
  end if;

  if v_challenger_pred.lock_reason = 'CHALLENGE_ACCEPTED' or v_recipient_pred.lock_reason = 'CHALLENGE_ACCEPTED' then
    update public.challenges set status = 'EXPIRED', expiry_reason = 'COMPETING_CHALLENGE_RESOLVED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_already_paired')::public.accept_call_bs_result;
  end if;

  if v_challenger_pred.selected_outcome <> v_challenge.challenger_selection_snapshot
     or v_recipient_pred.selected_outcome <> v_challenge.recipient_selection_snapshot
     or v_challenger_pred.lifecycle_state = 'GRADED'
     or v_recipient_pred.lifecycle_state = 'GRADED'
  then
    update public.challenges set status = 'EXPIRED', expiry_reason = 'SYSTEM_INVALIDATED', updated_at = now() where id = v_challenge.id returning * into v_result;
    return (v_result, 'rejected_invalidated')::public.accept_call_bs_result;
  end if;

  update public.predictions
    set locked_at = now(), lock_reason = 'CHALLENGE_ACCEPTED', updated_at = now()
    where id in (v_challenger_pred.id, v_recipient_pred.id) and locked_at is null;

  update public.challenges set status = 'ACCEPTED', accepted_at = now(), updated_at = now()
    where id = v_challenge.id
    returning * into v_result;

  -- Cascade: every OTHER still-PENDING Challenge on this Market involving either participant can no longer be accepted — a competing Call BS was resolved first, which is not anyone's silence.
  update public.challenges
    set status = 'EXPIRED', expiry_reason = 'COMPETING_CHALLENGE_RESOLVED', updated_at = now()
    where market_id = v_challenge.market_id
      and status = 'PENDING'
      and id <> v_challenge.id
      and (challenger_user_id in (v_challenge.challenger_user_id, v_challenge.recipient_user_id)
           or recipient_user_id in (v_challenge.challenger_user_id, v_challenge.recipient_user_id));

  return (v_result, 'accepted')::public.accept_call_bs_result;
end;
$function$;

-- The sweep: a PENDING Call BS that can no longer be accepted. WHY it ran out is decided by the one classifier above.
create or replace function public.expire_stale_challenges(p_limit integer default 200)
returns setof challenges
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_lock_minutes integer;
begin
  select coalesce(pick_lock_minutes_before_kickoff, 10) into v_lock_minutes from public.platform_settings where id = true;

  return query
  with stale as (
    select c.id, f.internal_status as fixture_status, m.status::text as market_status
    from public.challenges c
    join public.markets m on m.id = c.market_id
    join public.fixtures f on f.id = m.fixture_id
    where c.status = 'PENDING'
      and (
        now() >= f.scheduled_start_utc - (coalesce(v_lock_minutes, 10) || ' minutes')::interval
        or f.internal_status <> 'NOT_STARTED'
        or m.status <> 'ACTIVE'
      )
    order by c.created_at
    limit greatest(coalesce(p_limit, 200), 1)
    for update of c skip locked
  )
  update public.challenges c
    set status = 'EXPIRED', expiry_reason = public.challenge_game_expiry_reason(stale.fixture_status, stale.market_status), updated_at = now()
    from stale
    where c.id = stale.id and c.status = 'PENDING'
    returning c.*;
end;
$function$;

-- Direct replies between a blocked pair are refused (one neutral code). Top-level comments are public and untouched.
create or replace function public.add_post_comment(p_post_id uuid, p_user_id uuid, p_body text, p_parent_comment_id uuid default null::uuid)
returns post_comments
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_result public.post_comments;
  v_parent public.post_comments;
  v_max_length integer;
begin
  if not exists (select 1 from public.posts where id = p_post_id and published_at is not null) then
    raise exception 'post_not_found';
  end if;

  select coalesce(post_comment_max_length, 500) into v_max_length from public.platform_settings where id = true;
  if char_length(p_body) > coalesce(v_max_length, 500) then
    raise exception 'body_too_long';
  end if;

  if p_parent_comment_id is not null then
    select * into v_parent from public.post_comments where id = p_parent_comment_id;
    if not found or v_parent.post_id != p_post_id then
      raise exception 'parent_not_found';
    end if;
    if v_parent.parent_comment_id is not null then
      raise exception 'nesting_too_deep';
    end if;
    if public.members_blocked(p_user_id, v_parent.user_id) then
      raise exception 'relationship_blocked';
    end if;
  end if;

  insert into public.post_comments (post_id, user_id, body, parent_comment_id)
  values (p_post_id, p_user_id, p_body, p_parent_comment_id)
  returning * into v_result;

  return v_result;
end;
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.platform_settings rename column messaging_retention_deleted_account_days to messaging_retention_closed_account_days;

alter table public.platform_settings
  add column messaging_retention_audit_days integer default 365 check (messaging_retention_audit_days is null or messaging_retention_audit_days between 1 and 36500),
  add column messaging_retention_purge_enabled boolean not null default false,
  add column messaging_report_outcome_notifications_enabled boolean not null default true,
  add column messaging_abuse_window_seconds integer not null default 86400 check (messaging_abuse_window_seconds between 60 and 604800),
  add column messaging_abuse_requests_threshold integer not null default 12 check (messaging_abuse_requests_threshold between 1 and 1000),
  add column messaging_abuse_declines_threshold integer not null default 3 check (messaging_abuse_declines_threshold between 1 and 1000),
  add column messaging_abuse_blocks_threshold integer not null default 3 check (messaging_abuse_blocks_threshold between 1 and 1000),
  add column messaging_abuse_reports_threshold integer not null default 3 check (messaging_abuse_reports_threshold between 1 and 1000),
  add column messaging_abuse_duplicate_threshold integer not null default 4 check (messaging_abuse_duplicate_threshold between 2 and 1000),
  add column messaging_abuse_rapid_window_seconds integer not null default 600 check (messaging_abuse_rapid_window_seconds between 10 and 86400),
  add column messaging_abuse_rapid_threshold integer not null default 60 check (messaging_abuse_rapid_threshold between 2 and 10000),
  add column messaging_abuse_coordinated_threshold integer not null default 8 check (messaging_abuse_coordinated_threshold between 2 and 1000),
  add column messaging_abuse_restrict_enabled boolean not null default false,
  add column messaging_abuse_restrict_hours integer not null default 24 check (messaging_abuse_restrict_hours between 1 and 168);

-- The initial operational policy (owner decision). All of these remain editable without a deploy.
alter table public.platform_settings alter column messaging_retention_unsent_days set default 30;
alter table public.platform_settings alter column messaging_retention_reported_days set default 180;
alter table public.platform_settings alter column messaging_retention_closed_account_days set default 30;
update public.platform_settings set messaging_retention_unsent_days = 30, messaging_retention_reported_days = 180, messaging_retention_closed_account_days = 30, messaging_retention_audit_days = 365;

comment on column public.platform_settings.messaging_retention_messages_days is 'Age-based purge of ordinary messages, in days. NULL (the default) means NO age-based purge while the accounts and conversation remain active — messages are kept for as long as they are relevant. A number is an explicit, owner-approved choice.';
comment on column public.platform_settings.messaging_retention_unsent_days is 'Days after a message was unsent (or removed by moderation) that its original content is kept. Default 30. Never applied to a message on an unresolved report or under a retention hold.';
comment on column public.platform_settings.messaging_retention_reported_days is 'Days after a report''s CASE CLOSURE that its evidence snapshot is kept. Default 180. An open report is never purged; a retention hold preserves the evidence regardless.';
comment on column public.platform_settings.messaging_retention_closed_account_days is 'Days after canonical account closure (user_profiles.account_closed_at) that message content in that Member''s conversations is removed. Default 30. A retention hold preserves only the held messages.';
comment on column public.platform_settings.messaging_retention_moderation_days is 'Days after case closure that the resolved report RECORD itself (the decision, not the evidence) is removed. NULL (default) keeps it.';
comment on column public.platform_settings.messaging_retention_audit_days is 'Days that Messaging''s own security metadata (resolved abuse signals, ended restrictions, released holds) is kept. Default 365. audit_logs is append-only by design and is not touched.';
comment on column public.platform_settings.messaging_retention_purge_enabled is 'Master switch for the retention purge. OFF by default: nothing is deleted until the owner turns it on, whatever the durations say.';
comment on column public.platform_settings.messaging_abuse_restrict_enabled is 'Whether a bounded, temporary restriction on NEW Message Requests may be applied automatically for the sender-behaviour signals (excessive requests, repeated declines, duplicate bursts, rapid messaging). OFF by default: signals are flagged for moderation only. Signals about what OTHER Members did (blocks, reports, coordinated targeting) never restrict anyone.';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 4. Retention holds
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table public.messaging_retention_holds (
  id uuid primary key default gen_random_uuid(),
  reason text not null check (reason in ('ABUSE_INVESTIGATION', 'MODERATION_CASE', 'LEGAL_OBLIGATION')),
  -- Narrow by construction: one message, one report (its record, evidence and reported message), or a bounded run of messages in one conversation. There is no Member-wide or conversation-wide hold.
  scope text not null check (scope in ('MESSAGE', 'REPORT', 'CONVERSATION_RANGE')),
  message_id uuid references public.messages (id) on delete cascade,
  report_id uuid references public.message_reports (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete cascade,
  seq_from bigint,
  seq_to bigint,
  note text not null check (char_length(note) between 3 and 1000),
  placed_by uuid references public.user_profiles (id) on delete set null,
  placed_at timestamptz not null default now(),
  released_by uuid references public.user_profiles (id) on delete set null,
  released_at timestamptz,
  release_note text check (release_note is null or char_length(release_note) <= 1000),
  constraint messaging_hold_scope_shape check (
    (scope = 'MESSAGE' and message_id is not null and report_id is null and conversation_id is null and seq_from is null and seq_to is null)
    or (scope = 'REPORT' and report_id is not null and message_id is null and conversation_id is null and seq_from is null and seq_to is null)
    or (scope = 'CONVERSATION_RANGE' and conversation_id is not null and message_id is null and report_id is null and seq_from is not null and seq_to is not null
        and seq_from >= 1 and seq_to >= seq_from and seq_to - seq_from < 200)),
  constraint messaging_hold_release_shape check (released_by is null or released_at is not null)
);
create unique index messaging_hold_one_active_message on public.messaging_retention_holds (message_id) where scope = 'MESSAGE' and released_at is null;
create unique index messaging_hold_one_active_report on public.messaging_retention_holds (report_id) where scope = 'REPORT' and released_at is null;
create index messaging_hold_active_conversation_idx on public.messaging_retention_holds (conversation_id) where scope = 'CONVERSATION_RANGE' and released_at is null;
create index messaging_hold_released_idx on public.messaging_retention_holds (released_at) where released_at is not null;

-- Is this message protected from the retention purge? Yes while it is on an UNRESOLVED report (an open moderation case) or covered by an active hold of any scope.
create or replace function public.messaging_message_protected(p_message_id uuid, p_conversation_id uuid, p_seq bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.message_reports r where r.message_id = p_message_id and r.status = 'OPEN')
    or exists (select 1 from public.messaging_retention_holds h where h.released_at is null and h.scope = 'MESSAGE' and h.message_id = p_message_id)
    or exists (select 1 from public.messaging_retention_holds h where h.released_at is null and h.scope = 'CONVERSATION_RANGE' and h.conversation_id = p_conversation_id and p_seq between h.seq_from and h.seq_to)
    or exists (select 1 from public.messaging_retention_holds h join public.message_reports r on r.id = h.report_id where h.released_at is null and h.scope = 'REPORT' and r.message_id = p_message_id);
$$;
revoke all on function public.messaging_message_protected(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.messaging_message_protected(uuid, uuid, bigint) to service_role;

create or replace function public.admin_messaging_place_hold(
  p_admin_id uuid, p_reason text, p_scope text, p_message_id uuid, p_report_id uuid, p_conversation_id uuid, p_seq_from bigint, p_seq_to bigint, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note text;
  v_id uuid;
  v_count bigint;
begin
  perform public.require_super_admin(p_admin_id);
  if p_reason not in ('ABUSE_INVESTIGATION', 'MODERATION_CASE', 'LEGAL_OBLIGATION') then raise exception 'invalid_reason'; end if;
  if p_scope not in ('MESSAGE', 'REPORT', 'CONVERSATION_RANGE') then raise exception 'invalid_scope'; end if;
  v_note := nullif(left(public.messaging_normalize_text(p_note), 1000), '');
  if v_note is null or char_length(v_note) < 3 then return jsonb_build_object('outcome', 'note_required'); end if;

  if p_scope = 'MESSAGE' then
    if not exists (select 1 from public.messages where id = p_message_id) then return jsonb_build_object('outcome', 'not_found'); end if;
  elsif p_scope = 'REPORT' then
    if not exists (select 1 from public.message_reports where id = p_report_id) then return jsonb_build_object('outcome', 'not_found'); end if;
  else
    select message_count into v_count from public.conversations where id = p_conversation_id;
    if not found then return jsonb_build_object('outcome', 'not_found'); end if;
    if p_seq_from is null or p_seq_to is null or p_seq_from < 1 or p_seq_to < p_seq_from or p_seq_to > v_count then return jsonb_build_object('outcome', 'invalid_range'); end if;
    if p_seq_to - p_seq_from >= 200 then return jsonb_build_object('outcome', 'range_too_wide'); end if;
  end if;

  begin
    insert into public.messaging_retention_holds (reason, scope, message_id, report_id, conversation_id, seq_from, seq_to, note, placed_by)
      values (p_reason, p_scope,
        case when p_scope = 'MESSAGE' then p_message_id end, case when p_scope = 'REPORT' then p_report_id end,
        case when p_scope = 'CONVERSATION_RANGE' then p_conversation_id end,
        case when p_scope = 'CONVERSATION_RANGE' then p_seq_from end, case when p_scope = 'CONVERSATION_RANGE' then p_seq_to end,
        v_note, p_admin_id) returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('outcome', 'already_held');
  end;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, reason, after)
    values (p_admin_id, 'messaging.hold_placed', 'messaging_hold', v_id::text, v_note, jsonb_build_object('reason', p_reason, 'scope', p_scope));
  return jsonb_build_object('outcome', 'held', 'holdId', v_id);
end;
$$;
revoke all on function public.admin_messaging_place_hold(uuid, text, text, uuid, uuid, uuid, bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.admin_messaging_place_hold(uuid, text, text, uuid, uuid, uuid, bigint, bigint, text) to service_role;

create or replace function public.admin_messaging_release_hold(p_admin_id uuid, p_hold_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold public.messaging_retention_holds;
  v_note text;
begin
  perform public.require_super_admin(p_admin_id);
  v_note := nullif(left(public.messaging_normalize_text(p_note), 1000), '');
  select * into v_hold from public.messaging_retention_holds where id = p_hold_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_hold.released_at is not null then return jsonb_build_object('outcome', 'already_released'); end if;
  update public.messaging_retention_holds set released_at = now(), released_by = p_admin_id, release_note = v_note where id = p_hold_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, reason) values (p_admin_id, 'messaging.hold_released', 'messaging_hold', p_hold_id::text, v_note);
  return jsonb_build_object('outcome', 'released');
end;
$$;
revoke all on function public.admin_messaging_release_hold(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_messaging_release_hold(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 5. Abuse signals
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create index messages_sender_created_idx on public.messages (sender_id, created_at desc);
create index message_reports_reported_idx on public.message_reports (reported_member_id, created_at desc) where reported_member_id is not null;
create index conversations_opened_declined_idx on public.conversations (opened_by, declined_at desc) where declined_at is not null;

create table public.messaging_abuse_signals (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.user_profiles (id) on delete cascade,
  signal_type text not null check (signal_type in ('EXCESSIVE_REQUESTS', 'REPEATED_DECLINES', 'REPEATED_BLOCKS', 'REPEATED_REPORTS', 'DUPLICATE_BURST', 'RAPID_MESSAGING', 'COORDINATED_TARGETING')),
  status text not null default 'OPEN' check (status in ('OPEN', 'REVIEWED', 'DISMISSED', 'ACTIONED')),
  -- Counts and the rule that fired — never message content, an IP, a device or a score.
  observed_count integer not null,
  threshold integer not null,
  window_seconds integer not null,
  response text not null default 'FLAGGED' check (response in ('FLAGGED', 'RESTRICTED')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_by uuid references public.user_profiles (id) on delete set null,
  resolved_at timestamptz,
  resolution_note text check (resolution_note is null or char_length(resolution_note) <= 1000)
);
create unique index messaging_abuse_one_open_per_type on public.messaging_abuse_signals (member_id, signal_type) where status = 'OPEN';
create index messaging_abuse_queue_idx on public.messaging_abuse_signals (status, last_seen_at desc);

create table public.messaging_restrictions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.user_profiles (id) on delete cascade,
  signal_id uuid references public.messaging_abuse_signals (id) on delete set null,
  rule text not null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  lifted_by uuid references public.user_profiles (id) on delete set null,
  lifted_at timestamptz,
  lift_note text check (lift_note is null or char_length(lift_note) <= 1000),
  created_at timestamptz not null default now(),
  constraint messaging_restriction_bounded check (ends_at > starts_at and ends_at <= starts_at + interval '7 days')
);
create index messaging_restrictions_member_idx on public.messaging_restrictions (member_id, ends_at desc) where lifted_at is null;

alter table public.messaging_retention_holds enable row level security;
alter table public.messaging_abuse_signals enable row level security;
alter table public.messaging_restrictions enable row level security;
revoke all on public.messaging_retention_holds, public.messaging_abuse_signals, public.messaging_restrictions from public, anon, authenticated;
grant all on public.messaging_retention_holds, public.messaging_abuse_signals, public.messaging_restrictions to service_role;

-- Is this Member currently restricted from opening NEW Message Requests? (Existing accepted conversations are never affected.)
create or replace function public.messaging_is_restricted(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.messaging_restrictions where member_id = p_user_id and lifted_at is null and ends_at > now());
$$;
revoke all on function public.messaging_is_restricted(uuid) from public, anon, authenticated;
grant execute on function public.messaging_is_restricted(uuid) to service_role;

-- Evaluate ONE signal for ONE Member against the configured thresholds. Cheap (a bounded, indexed count), idempotent (one OPEN signal per Member and type), and it only ever records or — where an explicit
-- switched-on rule allows it — applies a short, bounded restriction. It never bans, deletes or scores anyone, and it uses no IP or device information (a shared network is not proof of abuse).
create or replace function public.messaging_abuse_check(p_member uuid, p_type text, p_body text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_count integer := 0;
  v_threshold integer;
  v_window integer;
  v_signal_id uuid;
  v_restrictable boolean := false;
  v_response text := 'FLAGGED';
  v_inserted boolean;
begin
  if p_member is null then return; end if;
  select * into v_s from public.platform_settings where id = true;
  if v_s.messaging_enabled is not true then return; end if;
  v_window := v_s.messaging_abuse_window_seconds;

  if p_type = 'EXCESSIVE_REQUESTS' then
    v_threshold := v_s.messaging_abuse_requests_threshold; v_restrictable := true;
    select count(*) into v_count from public.messages where sender_id = p_member and is_request and created_at > now() - make_interval(secs => v_window);
  elsif p_type = 'REPEATED_DECLINES' then
    v_threshold := v_s.messaging_abuse_declines_threshold; v_restrictable := true;
    select count(*) into v_count from public.conversations where opened_by = p_member and declined_at > now() - make_interval(secs => v_window);
  elsif p_type = 'REPEATED_BLOCKS' then
    v_threshold := v_s.messaging_abuse_blocks_threshold;
    select count(distinct blocker_id) into v_count from public.member_blocks where blocked_id = p_member and created_at > now() - make_interval(secs => v_window);
  elsif p_type = 'REPEATED_REPORTS' then
    v_threshold := v_s.messaging_abuse_reports_threshold;
    select count(distinct reporter_id) into v_count from public.message_reports where reported_member_id = p_member and created_at > now() - make_interval(secs => v_window);
  elsif p_type = 'DUPLICATE_BURST' then
    v_threshold := v_s.messaging_abuse_duplicate_threshold; v_restrictable := true;
    if p_body is null then return; end if;
    select count(*) into v_count from public.messages where sender_id = p_member and kind = 'TEXT' and created_at > now() - make_interval(secs => v_window) and body = p_body;
  elsif p_type = 'RAPID_MESSAGING' then
    v_threshold := v_s.messaging_abuse_rapid_threshold; v_restrictable := true; v_window := v_s.messaging_abuse_rapid_window_seconds;
    select count(*) into v_count from public.messages where sender_id = p_member and created_at > now() - make_interval(secs => v_window);
  elsif p_type = 'COORDINATED_TARGETING' then
    v_threshold := v_s.messaging_abuse_coordinated_threshold;
    select count(distinct m.sender_id) into v_count
      from public.conversations c join public.messages m on m.conversation_id = c.id
      where (c.member_low = p_member or c.member_high = p_member) and m.sender_id is distinct from p_member and m.is_request and m.created_at > now() - make_interval(secs => v_window);
  else
    raise exception 'unknown_signal_type';
  end if;

  if v_count < v_threshold then return; end if;

  -- A restriction only where the rule is switched on AND the signal is about this Member's own sending behaviour; never because of what other Members reported or did.
  if v_restrictable and v_s.messaging_abuse_restrict_enabled then v_response := 'RESTRICTED'; end if;

  insert into public.messaging_abuse_signals (member_id, signal_type, observed_count, threshold, window_seconds, response)
    values (p_member, p_type, v_count, v_threshold, v_window, v_response)
    on conflict (member_id, signal_type) where status = 'OPEN'
    do update set observed_count = greatest(public.messaging_abuse_signals.observed_count, excluded.observed_count), last_seen_at = now()
    returning id, (xmax = 0) into v_signal_id, v_inserted;

  if v_inserted then
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
      values (null, 'messaging.abuse_signal', 'member', p_member::text, jsonb_build_object('type', p_type, 'count', v_count, 'threshold', v_threshold, 'response', v_response));
  end if;

  if v_response = 'RESTRICTED' and not public.messaging_is_restricted(p_member) then
    insert into public.messaging_restrictions (member_id, signal_id, rule, ends_at)
      values (p_member, v_signal_id, p_type, now() + make_interval(hours => v_s.messaging_abuse_restrict_hours));
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, after)
      values (null, 'messaging.restriction_applied', 'member', p_member::text, jsonb_build_object('rule', p_type, 'hours', v_s.messaging_abuse_restrict_hours));
  end if;
end;
$$;
revoke all on function public.messaging_abuse_check(uuid, text, text) from public, anon, authenticated;
grant execute on function public.messaging_abuse_check(uuid, text, text) to service_role;

-- Triggers feed the evaluator. Detection must never be able to break sending, blocking, declining or reporting, so each one swallows (and warns about) its own failure.
create or replace function public.messaging_abuse_on_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipient uuid;
begin
  begin
    perform public.messaging_abuse_check(new.sender_id, 'RAPID_MESSAGING');
    if new.is_request then
      perform public.messaging_abuse_check(new.sender_id, 'EXCESSIVE_REQUESTS');
      select case when c.member_low = new.sender_id then c.member_high else c.member_low end into v_recipient from public.conversations c where c.id = new.conversation_id;
      perform public.messaging_abuse_check(v_recipient, 'COORDINATED_TARGETING');
    end if;
    if new.kind = 'TEXT' and new.body is not null then perform public.messaging_abuse_check(new.sender_id, 'DUPLICATE_BURST', new.body); end if;
  exception when others then
    raise warning 'messaging abuse evaluation failed: %', sqlstate;
  end;
  return null;
end;
$$;
create trigger messaging_abuse_on_message after insert on public.messages for each row execute function public.messaging_abuse_on_message();

create or replace function public.messaging_abuse_on_decline()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.messaging_abuse_check(new.opened_by, 'REPEATED_DECLINES');
  exception when others then
    raise warning 'messaging abuse evaluation failed: %', sqlstate;
  end;
  return null;
end;
$$;
create trigger messaging_abuse_on_decline after update of declined_at on public.conversations for each row when (new.declined_at is not null and new.declined_at is distinct from old.declined_at) execute function public.messaging_abuse_on_decline();

create or replace function public.messaging_abuse_on_block()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.messaging_abuse_check(new.blocked_id, 'REPEATED_BLOCKS');
  exception when others then
    raise warning 'messaging abuse evaluation failed: %', sqlstate;
  end;
  return null;
end;
$$;
create trigger messaging_abuse_on_block after insert on public.member_blocks for each row execute function public.messaging_abuse_on_block();

create or replace function public.messaging_abuse_on_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.messaging_abuse_check(new.reported_member_id, 'REPEATED_REPORTS');
  exception when others then
    raise warning 'messaging abuse evaluation failed: %', sqlstate;
  end;
  return null;
end;
$$;
create trigger messaging_abuse_on_report after insert on public.message_reports for each row execute function public.messaging_abuse_on_report();

create or replace function public.admin_messaging_resolve_signal(p_admin_id uuid, p_signal_id uuid, p_action text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_signal public.messaging_abuse_signals;
  v_note text;
begin
  perform public.require_super_admin(p_admin_id);
  if p_action not in ('REVIEW', 'DISMISS', 'ACTION') then raise exception 'invalid_action'; end if;
  v_note := nullif(left(public.messaging_normalize_text(p_note), 1000), '');
  select * into v_signal from public.messaging_abuse_signals where id = p_signal_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_signal.status <> 'OPEN' then return jsonb_build_object('outcome', 'already_resolved', 'status', v_signal.status); end if;
  update public.messaging_abuse_signals
    set status = case p_action when 'REVIEW' then 'REVIEWED' when 'DISMISS' then 'DISMISSED' else 'ACTIONED' end, resolved_by = p_admin_id, resolved_at = now(), resolution_note = v_note
    where id = p_signal_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, reason) values (p_admin_id, 'messaging.abuse_signal_' || lower(p_action), 'messaging_abuse_signal', p_signal_id::text, v_note);
  return jsonb_build_object('outcome', 'resolved');
end;
$$;
revoke all on function public.admin_messaging_resolve_signal(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_messaging_resolve_signal(uuid, uuid, text, text) to service_role;

create or replace function public.admin_messaging_lift_restriction(p_admin_id uuid, p_restriction_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_r public.messaging_restrictions;
  v_note text;
begin
  perform public.require_super_admin(p_admin_id);
  v_note := nullif(left(public.messaging_normalize_text(p_note), 1000), '');
  select * into v_r from public.messaging_restrictions where id = p_restriction_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_r.lifted_at is not null then return jsonb_build_object('outcome', 'already_lifted'); end if;
  update public.messaging_restrictions set lifted_at = now(), lifted_by = p_admin_id, lift_note = v_note where id = p_restriction_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, reason) values (p_admin_id, 'messaging.restriction_lifted', 'member', v_r.member_id::text, v_note);
  return jsonb_build_object('outcome', 'lifted');
end;
$$;
revoke all on function public.admin_messaging_lift_restriction(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_messaging_lift_restriction(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 6. Reporter outcome notifications (generic by design) — on top of the existing resolve function
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_messaging_resolve_report(p_admin_id uuid, p_report_id uuid, p_action text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report public.message_reports;
  v_note text;
  v_notify boolean;
begin
  perform public.require_super_admin(p_admin_id);
  if p_action not in ('DISMISS', 'HIDE_MESSAGE', 'ACTION') then raise exception 'invalid_action'; end if;
  v_note := nullif(left(public.messaging_normalize_text(p_note), 1000), '');
  select * into v_report from public.message_reports where id = p_report_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_report.status <> 'OPEN' then return jsonb_build_object('outcome', 'already_resolved', 'status', v_report.status); end if;

  if p_action = 'HIDE_MESSAGE' then
    if v_report.message_id is null then return jsonb_build_object('outcome', 'no_message'); end if;
    insert into public.message_unsent_evidence (message_id, body, share_type, share_ref)
      select id, body, share_type, share_ref from public.messages where id = v_report.message_id on conflict do nothing;
    update public.messages set body = null, share_ref = null, moderation_removed_at = now() where id = v_report.message_id;
  end if;

  update public.message_reports set status = case when p_action = 'DISMISS' then 'DISMISSED' else 'ACTIONED' end, resolved_by = p_admin_id, resolved_at = now(), resolution_note = v_note where id = p_report_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, reason) values (p_admin_id, 'messaging.report_' || lower(p_action), 'message_report', p_report_id::text, v_note);

  -- The reporter hears ONE of two generic sentences. Nothing about the other Member, what was done to them, the moderator's note or any other reporter ever goes into it.
  select messaging_report_outcome_notifications_enabled into v_notify from public.platform_settings where id = true;
  if coalesce(v_notify, false) and v_report.reporter_id is not null then
    insert into public.notifications (user_id, type, title, body)
      values (v_report.reporter_id, 'MESSAGE_REPORT_OUTCOME', 'We reviewed your report',
        case when p_action = 'DISMISS' then 'We reviewed your report and did not find a violation under the current rules.' else 'We reviewed your report and action was taken.' end);
  end if;
  return jsonb_build_object('outcome', 'resolved');
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Block: the Messaging function now also ends any still-PENDING Call BS between the pair (never counted as anyone's silence).
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.messaging_set_block(p_user_id uuid, p_blocked_id uuid, p_blocked boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  if not public.messaging_is_active_member(p_user_id) then raise exception 'not_a_member'; end if;
  if p_user_id = p_blocked_id then return jsonb_build_object('outcome', 'self'); end if;
  if p_blocked then
    if not exists (select 1 from public.user_profiles where id = p_blocked_id) then return jsonb_build_object('outcome', 'not_found'); end if;
    insert into public.member_blocks (blocker_id, blocked_id) values (p_user_id, p_blocked_id) on conflict do nothing;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then insert into public.audit_logs (actor_id, action, entity_type, entity_id) values (p_user_id, 'messaging.blocked', 'member', p_blocked_id::text); end if;
    update public.challenges set status = 'EXPIRED', expiry_reason = 'RELATIONSHIP_BLOCKED', updated_at = now()
      where status = 'PENDING' and ((challenger_user_id = p_user_id and recipient_user_id = p_blocked_id) or (challenger_user_id = p_blocked_id and recipient_user_id = p_user_id));
  else
    delete from public.member_blocks where blocker_id = p_user_id and blocked_id = p_blocked_id;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then insert into public.audit_logs (actor_id, action, entity_type, entity_id) values (p_user_id, 'messaging.unblocked', 'member', p_blocked_id::text); end if;
  end if;
  return jsonb_build_object('outcome', case when p_blocked then 'blocked' else 'unblocked' end);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Retention: one coherent model. NULL ordinary-message retention means no age-based purge; closure comes only from account_closed_at; holds and open cases protect only what they name.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.messaging_purge_expired(p_batch integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_messages integer := 0;
  v_unsent integer := 0;
  v_reported integer := 0;
  v_closed_messages integer := 0;
  v_closed_conversations integer := 0;
  v_moderation integer := 0;
  v_security integer := 0;
  v_n integer;
begin
  select * into v_s from public.platform_settings where id = true;
  if p_batch is null or p_batch < 1 then p_batch := 500; end if;
  -- The master switch: with it off (the default) this deletes nothing, whatever the durations say.
  if v_s.messaging_retention_purge_enabled is not true then
    return jsonb_build_object('enabled', false);
  end if;

  -- Ordinary messages: only when an age is explicitly configured.
  if v_s.messaging_retention_messages_days is not null then
    delete from public.messages where id in (
      select m.id from public.messages m
      where m.created_at < now() - make_interval(days => v_s.messaging_retention_messages_days) and not public.messaging_message_protected(m.id, m.conversation_id, m.seq)
      order by m.created_at limit p_batch);
    get diagnostics v_messages = row_count;
  end if;

  -- Originals of unsent / moderator-removed messages.
  if v_s.messaging_retention_unsent_days is not null then
    delete from public.message_unsent_evidence where message_id in (
      select e.message_id from public.message_unsent_evidence e join public.messages m on m.id = e.message_id
      where e.unsent_at < now() - make_interval(days => v_s.messaging_retention_unsent_days) and not public.messaging_message_protected(m.id, m.conversation_id, m.seq)
      order by e.unsent_at limit p_batch);
    get diagnostics v_unsent = row_count;
  end if;

  -- Report evidence: counted from CASE CLOSURE; an open case is never touched; a hold on the report (or on its message) preserves it.
  if v_s.messaging_retention_reported_days is not null then
    update public.message_reports set evidence = '[]'::jsonb where id in (
      select r.id from public.message_reports r
      where r.status <> 'OPEN' and r.evidence <> '[]'::jsonb and r.resolved_at < now() - make_interval(days => v_s.messaging_retention_reported_days)
        and not exists (select 1 from public.messaging_retention_holds h where h.released_at is null and h.scope = 'REPORT' and h.report_id = r.id)
        and (r.message_id is null or not exists (select 1 from public.messaging_retention_holds h where h.released_at is null and h.scope = 'MESSAGE' and h.message_id = r.message_id))
      order by r.resolved_at limit p_batch);
    get diagnostics v_reported = row_count;
  end if;

  -- Message content after CANONICAL account closure (user_profiles.account_closed_at — nothing inferred). Only unprotected messages go; a hold keeps exactly what it names.
  if v_s.messaging_retention_closed_account_days is not null then
    delete from public.messages where id in (
      select m.id from public.messages m
      where m.conversation_id in (
        select c.id from public.conversations c join public.user_profiles p on p.id = c.member_low
          where p.account_closed_at < now() - make_interval(days => v_s.messaging_retention_closed_account_days)
        union
        select c.id from public.conversations c join public.user_profiles p on p.id = c.member_high
          where p.account_closed_at < now() - make_interval(days => v_s.messaging_retention_closed_account_days))
      and not public.messaging_message_protected(m.id, m.conversation_id, m.seq)
      limit p_batch);
    get diagnostics v_closed_messages = row_count;

    -- The emptied conversation shell goes too — but never one that still holds a protected message.
    delete from public.conversations where id in (
      select c.id from public.conversations c join public.user_profiles p on p.id = c.member_low
        where p.account_closed_at < now() - make_interval(days => v_s.messaging_retention_closed_account_days) and not exists (select 1 from public.messages m where m.conversation_id = c.id)
      union
      select c.id from public.conversations c join public.user_profiles p on p.id = c.member_high
        where p.account_closed_at < now() - make_interval(days => v_s.messaging_retention_closed_account_days) and not exists (select 1 from public.messages m where m.conversation_id = c.id)
      limit p_batch);
    get diagnostics v_closed_conversations = row_count;
  end if;

  -- The resolved report RECORD (decision metadata, not evidence).
  if v_s.messaging_retention_moderation_days is not null then
    delete from public.message_reports where id in (
      select r.id from public.message_reports r
      where r.status <> 'OPEN' and r.resolved_at < now() - make_interval(days => v_s.messaging_retention_moderation_days)
        and not exists (select 1 from public.messaging_retention_holds h where h.released_at is null and h.scope = 'REPORT' and h.report_id = r.id)
      order by r.resolved_at limit p_batch);
    get diagnostics v_moderation = row_count;
  end if;

  -- Messaging's own security metadata (resolved signals, ended restrictions, released holds). audit_logs is append-only by design and is never touched.
  if v_s.messaging_retention_audit_days is not null then
    delete from public.messaging_abuse_signals where id in (select id from public.messaging_abuse_signals where status <> 'OPEN' and resolved_at < now() - make_interval(days => v_s.messaging_retention_audit_days) order by resolved_at limit p_batch);
    get diagnostics v_n = row_count; v_security := v_security + v_n;
    delete from public.messaging_restrictions where id in (
      select id from public.messaging_restrictions where least(ends_at, coalesce(lifted_at, ends_at)) < now() - make_interval(days => v_s.messaging_retention_audit_days) order by ends_at limit p_batch);
    get diagnostics v_n = row_count; v_security := v_security + v_n;
    delete from public.messaging_retention_holds where id in (select id from public.messaging_retention_holds where released_at < now() - make_interval(days => v_s.messaging_retention_audit_days) order by released_at limit p_batch);
    get diagnostics v_n = row_count; v_security := v_security + v_n;
  end if;

  return jsonb_build_object('enabled', true, 'messages', v_messages, 'unsentEvidence', v_unsent, 'reportedEvidence', v_reported, 'closedAccountMessages', v_closed_messages,
    'closedAccountConversations', v_closed_conversations, 'moderationRecords', v_moderation, 'securityMetadata', v_security);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- The audited settings function: the same contract as before, now carrying the retention, abuse and notification policy.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.admin_set_messaging_config(p_admin_id uuid, p_config jsonb)
returns public.platform_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.platform_settings;
  v_after public.platform_settings;
  v_key text;
  v_b jsonb;
  v_a jsonb;
  v_allowed text[] := array[
    'messaging_enabled', 'messaging_max_message_length', 'messaging_max_unanswered_requests', 'messaging_unsend_window_seconds', 'messaging_duplicate_window_seconds',
    'messaging_send_rate_window_seconds', 'messaging_send_rate_max', 'messaging_request_rate_window_seconds', 'messaging_request_rate_max', 'messaging_report_rate_window_seconds',
    'messaging_report_rate_max', 'messaging_poll_interval_seconds', 'messaging_retention_messages_days', 'messaging_retention_unsent_days', 'messaging_retention_reported_days',
    'messaging_retention_closed_account_days', 'messaging_retention_moderation_days', 'messaging_retention_audit_days', 'messaging_retention_purge_enabled',
    'messaging_report_outcome_notifications_enabled', 'messaging_abuse_window_seconds', 'messaging_abuse_requests_threshold', 'messaging_abuse_declines_threshold',
    'messaging_abuse_blocks_threshold', 'messaging_abuse_reports_threshold', 'messaging_abuse_duplicate_threshold', 'messaging_abuse_rapid_window_seconds',
    'messaging_abuse_rapid_threshold', 'messaging_abuse_coordinated_threshold', 'messaging_abuse_restrict_enabled', 'messaging_abuse_restrict_hours'];
begin
  perform public.require_super_admin(p_admin_id);
  if p_config is null or jsonb_typeof(p_config) <> 'object' then raise exception 'invalid_config'; end if;
  for v_key in select jsonb_object_keys(p_config) loop
    if not (v_key = any (v_allowed)) then raise exception 'unknown_setting_%', v_key; end if;
  end loop;
  select * into v_before from public.platform_settings where id = true for update;
  update public.platform_settings set
    messaging_enabled = coalesce((p_config ->> 'messaging_enabled')::boolean, messaging_enabled),
    messaging_max_message_length = coalesce((p_config ->> 'messaging_max_message_length')::integer, messaging_max_message_length),
    messaging_max_unanswered_requests = coalesce((p_config ->> 'messaging_max_unanswered_requests')::integer, messaging_max_unanswered_requests),
    messaging_unsend_window_seconds = coalesce((p_config ->> 'messaging_unsend_window_seconds')::integer, messaging_unsend_window_seconds),
    messaging_duplicate_window_seconds = coalesce((p_config ->> 'messaging_duplicate_window_seconds')::integer, messaging_duplicate_window_seconds),
    messaging_send_rate_window_seconds = coalesce((p_config ->> 'messaging_send_rate_window_seconds')::integer, messaging_send_rate_window_seconds),
    messaging_send_rate_max = coalesce((p_config ->> 'messaging_send_rate_max')::integer, messaging_send_rate_max),
    messaging_request_rate_window_seconds = coalesce((p_config ->> 'messaging_request_rate_window_seconds')::integer, messaging_request_rate_window_seconds),
    messaging_request_rate_max = coalesce((p_config ->> 'messaging_request_rate_max')::integer, messaging_request_rate_max),
    messaging_report_rate_window_seconds = coalesce((p_config ->> 'messaging_report_rate_window_seconds')::integer, messaging_report_rate_window_seconds),
    messaging_report_rate_max = coalesce((p_config ->> 'messaging_report_rate_max')::integer, messaging_report_rate_max),
    messaging_poll_interval_seconds = coalesce((p_config ->> 'messaging_poll_interval_seconds')::integer, messaging_poll_interval_seconds),
    -- Retention values may be set back to NULL ("keep"): an explicit JSON null in the payload clears them.
    messaging_retention_messages_days = case when p_config ? 'messaging_retention_messages_days' then (p_config ->> 'messaging_retention_messages_days')::integer else messaging_retention_messages_days end,
    messaging_retention_unsent_days = case when p_config ? 'messaging_retention_unsent_days' then (p_config ->> 'messaging_retention_unsent_days')::integer else messaging_retention_unsent_days end,
    messaging_retention_reported_days = case when p_config ? 'messaging_retention_reported_days' then (p_config ->> 'messaging_retention_reported_days')::integer else messaging_retention_reported_days end,
    messaging_retention_closed_account_days = case when p_config ? 'messaging_retention_closed_account_days' then (p_config ->> 'messaging_retention_closed_account_days')::integer else messaging_retention_closed_account_days end,
    messaging_retention_moderation_days = case when p_config ? 'messaging_retention_moderation_days' then (p_config ->> 'messaging_retention_moderation_days')::integer else messaging_retention_moderation_days end,
    messaging_retention_audit_days = case when p_config ? 'messaging_retention_audit_days' then (p_config ->> 'messaging_retention_audit_days')::integer else messaging_retention_audit_days end,
    messaging_retention_purge_enabled = coalesce((p_config ->> 'messaging_retention_purge_enabled')::boolean, messaging_retention_purge_enabled),
    messaging_report_outcome_notifications_enabled = coalesce((p_config ->> 'messaging_report_outcome_notifications_enabled')::boolean, messaging_report_outcome_notifications_enabled),
    messaging_abuse_window_seconds = coalesce((p_config ->> 'messaging_abuse_window_seconds')::integer, messaging_abuse_window_seconds),
    messaging_abuse_requests_threshold = coalesce((p_config ->> 'messaging_abuse_requests_threshold')::integer, messaging_abuse_requests_threshold),
    messaging_abuse_declines_threshold = coalesce((p_config ->> 'messaging_abuse_declines_threshold')::integer, messaging_abuse_declines_threshold),
    messaging_abuse_blocks_threshold = coalesce((p_config ->> 'messaging_abuse_blocks_threshold')::integer, messaging_abuse_blocks_threshold),
    messaging_abuse_reports_threshold = coalesce((p_config ->> 'messaging_abuse_reports_threshold')::integer, messaging_abuse_reports_threshold),
    messaging_abuse_duplicate_threshold = coalesce((p_config ->> 'messaging_abuse_duplicate_threshold')::integer, messaging_abuse_duplicate_threshold),
    messaging_abuse_rapid_window_seconds = coalesce((p_config ->> 'messaging_abuse_rapid_window_seconds')::integer, messaging_abuse_rapid_window_seconds),
    messaging_abuse_rapid_threshold = coalesce((p_config ->> 'messaging_abuse_rapid_threshold')::integer, messaging_abuse_rapid_threshold),
    messaging_abuse_coordinated_threshold = coalesce((p_config ->> 'messaging_abuse_coordinated_threshold')::integer, messaging_abuse_coordinated_threshold),
    messaging_abuse_restrict_enabled = coalesce((p_config ->> 'messaging_abuse_restrict_enabled')::boolean, messaging_abuse_restrict_enabled),
    messaging_abuse_restrict_hours = coalesce((p_config ->> 'messaging_abuse_restrict_hours')::integer, messaging_abuse_restrict_hours),
    updated_at = now(), updated_by = p_admin_id
    where id = true returning * into v_after;
  v_b := (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(v_before)) where key like 'messaging\_%');
  v_a := (select jsonb_object_agg(key, value) from jsonb_each(to_jsonb(v_after)) where key like 'messaging\_%');
  if v_b is distinct from v_a then
    insert into public.audit_logs (actor_id, action, entity_type, entity_id, before, after) values (p_admin_id, 'settings.messaging_updated', 'platform_settings', null, v_b, v_a);
  end if;
  return v_after;
end;
$$;
