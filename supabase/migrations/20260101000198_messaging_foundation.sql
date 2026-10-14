-- P2P Messaging foundation (Milestone 2).
--
-- Permanent invariants, enforced by the schema and not by configuration:
--   * A conversation has EXACTLY TWO participants, both Members. There is no group concept anywhere: the pair is stored as (member_low, member_high) with member_low < member_high, and the pair is UNIQUE,
--     so A<->B and B<->A are one conversation and two parallel threads between the same pair cannot exist.
--   * Text and structured Brohda-object shares only. There is no attachment, media, image, file or voice column and none is planned.
--   * Sponsors are not Members: every participant column references user_profiles, and a Sponsor login has no user_profiles row (the MEMBER xor SPONSOR rule), so a Sponsor cannot be a participant,
--     a sender or a recipient. Every function below also re-checks that the actor is an active Member.
--
-- Access model (the existing one): every write is a SECURITY DEFINER function callable only by the service role (the server actions call them after requireMemberAccount); the browser's own role can
-- only SELECT, and only through RLS that limits it to the caller's own conversations. Private data a participant must not see (the other side's mute and read state, unsent and reported content,
-- moderation records, anything about a block against them) is in tables with no authenticated grant at all.
--
-- Product policy is in platform_settings (below) and read live by the functions; nothing here is a product-policy constant. Retention defaults to "keep" (NULL) until the owner and counsel set
-- durations; the purge function exists and is tested but is deliberately NOT scheduled by this milestone.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.platform_settings
  add column messaging_enabled boolean not null default false,
  add column messaging_max_message_length integer not null default 1000 check (messaging_max_message_length between 1 and 4000),
  add column messaging_max_unanswered_requests integer not null default 2 check (messaging_max_unanswered_requests between 1 and 10),
  add column messaging_unsend_window_seconds integer not null default 900 check (messaging_unsend_window_seconds between 0 and 86400),
  add column messaging_duplicate_window_seconds integer not null default 30 check (messaging_duplicate_window_seconds between 0 and 3600),
  add column messaging_send_rate_window_seconds integer not null default 60 check (messaging_send_rate_window_seconds between 1 and 3600),
  add column messaging_send_rate_max integer not null default 20 check (messaging_send_rate_max between 1 and 1000),
  add column messaging_request_rate_window_seconds integer not null default 3600 check (messaging_request_rate_window_seconds between 1 and 86400),
  add column messaging_request_rate_max integer not null default 5 check (messaging_request_rate_max between 1 and 1000),
  add column messaging_report_rate_window_seconds integer not null default 3600 check (messaging_report_rate_window_seconds between 1 and 86400),
  add column messaging_report_rate_max integer not null default 10 check (messaging_report_rate_max between 1 and 1000),
  add column messaging_poll_interval_seconds integer not null default 10 check (messaging_poll_interval_seconds between 3 and 300),
  add column messaging_retention_messages_days integer check (messaging_retention_messages_days is null or messaging_retention_messages_days between 1 and 36500),
  add column messaging_retention_unsent_days integer check (messaging_retention_unsent_days is null or messaging_retention_unsent_days between 1 and 36500),
  add column messaging_retention_reported_days integer check (messaging_retention_reported_days is null or messaging_retention_reported_days between 1 and 36500),
  add column messaging_retention_deleted_account_days integer check (messaging_retention_deleted_account_days is null or messaging_retention_deleted_account_days between 1 and 36500),
  add column messaging_retention_moderation_days integer check (messaging_retention_moderation_days is null or messaging_retention_moderation_days between 1 and 36500);

comment on column public.platform_settings.messaging_enabled is 'Member Messaging capability. OFF by default and on any unreadable value (fail closed): no new requests or messages, the UI is hidden; history is preserved and moderation stays available.';
comment on column public.platform_settings.messaging_max_message_length is 'Maximum characters in one text message. The table ceiling is 4000; this policy value may be lowered or raised without a migration.';
comment on column public.platform_settings.messaging_max_unanswered_requests is 'Maximum Message Requests from one Member to another that have not been accepted (pending or declined). Each pre-acceptance message is one request. Further requests are refused until the recipient accepts.';
comment on column public.platform_settings.messaging_unsend_window_seconds is 'How long after sending a Member may unsend their own message. 0 turns unsending off.';
comment on column public.platform_settings.messaging_duplicate_window_seconds is 'An identical text message from the same sender in the same conversation within this many seconds is refused (repeat-content spam). 0 turns the check off.';
comment on column public.platform_settings.messaging_retention_messages_days is 'Days to keep ordinary messages; NULL keeps them. Requires owner/counsel approval before being set. Not scheduled by default.';
comment on column public.platform_settings.messaging_retention_unsent_days is 'Days to keep the original content of unsent messages; NULL keeps it.';
comment on column public.platform_settings.messaging_retention_reported_days is 'Days to keep the evidence snapshot on a message report; NULL keeps it.';
comment on column public.platform_settings.messaging_retention_deleted_account_days is 'Days to keep a conversation after one participant account is gone; NULL keeps it.';
comment on column public.platform_settings.messaging_retention_moderation_days is 'Days to keep resolved moderation reports; NULL keeps them.';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- A Member-level block. Messaging is the first consumer; whether it should also cover Call BS or comments is a separate product decision and is NOT assumed here.
create table public.member_blocks (
  blocker_id uuid not null references public.user_profiles (id) on delete cascade,
  blocked_id uuid not null references public.user_profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint member_blocks_not_self check (blocker_id <> blocked_id)
);
-- "Has anyone I'm writing to blocked me?" asks by blocked_id.
create index member_blocks_blocked_idx on public.member_blocks (blocked_id, blocker_id);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  -- The two participants, ordered so the pair has ONE representation. SET NULL (not CASCADE) so a removed account never destroys the other Member's history; a conversation with a missing
  -- participant is read-only and shows a neutral "Deleted Member" placeholder.
  member_low uuid references public.user_profiles (id) on delete set null,
  member_high uuid references public.user_profiles (id) on delete set null,
  status text not null default 'PENDING' check (status in ('PENDING', 'ACTIVE', 'DECLINED')),
  opened_by uuid references public.user_profiles (id) on delete set null,
  message_count bigint not null default 0,
  last_message_at timestamptz,
  last_sender_id uuid references public.user_profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  declined_at timestamptz,
  constraint conversations_pair_ordered check (member_low is null or member_high is null or member_low < member_high),
  constraint conversations_opener_is_participant check (opened_by is null or opened_by in (member_low, member_high))
);
-- ONE canonical conversation per unordered pair (the ordering check above makes (low, high) canonical).
create unique index conversations_pair_unique on public.conversations (member_low, member_high) where member_low is not null and member_high is not null;
-- Inbox ordering and the retention sweeps.
create index conversations_low_activity_idx on public.conversations (member_low, last_message_at desc nulls last);
create index conversations_high_activity_idx on public.conversations (member_high, last_message_at desc nulls last);
create index conversations_last_message_idx on public.conversations (last_message_at);

-- Per-Member state: the read cursor and the mute. Two rows per conversation. A Member can read ONLY their own row, so the other side's mute and read state is never revealed.
create table public.conversation_participants (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  member_id uuid not null references public.user_profiles (id) on delete cascade,
  last_read_seq bigint not null default 0,
  muted_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (conversation_id, member_id)
);
-- The unread badge and the inbox both start from "my participations".
create index conversation_participants_member_idx on public.conversation_participants (member_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  seq bigint not null,
  sender_id uuid references public.user_profiles (id) on delete set null,
  kind text not null check (kind in ('TEXT', 'SHARE')),
  body text check (body is null or char_length(body) between 1 and 4000),
  share_type text check (share_type in ('POST', 'MARKET', 'PICK', 'CALL_BS')),
  share_ref uuid,
  -- True for a message sent while the conversation was not yet accepted. The count of these is what the unanswered-request limit reads; unsending one does NOT give the request back.
  is_request boolean not null default false,
  idempotency_key text,
  created_at timestamptz not null default now(),
  unsent_at timestamptz,
  moderation_removed_at timestamptz,
  constraint messages_shape check (
    (kind = 'TEXT' and share_type is null and share_ref is null and (body is not null or unsent_at is not null or moderation_removed_at is not null))
    or (kind = 'SHARE' and share_type is not null and body is null and (share_ref is not null or unsent_at is not null or moderation_removed_at is not null))
  ),
  constraint messages_seq_unique unique (conversation_id, seq),
  constraint messages_idempotency_unique unique (sender_id, idempotency_key)
);
-- Request counting: "how many request messages has this sender put in this conversation?"
create index messages_request_idx on public.messages (conversation_id, sender_id) where is_request;
-- Retention sweeps by age.
create index messages_created_idx on public.messages (created_at);

-- The original content of an unsent message, kept for moderation only and for the configured retention. No Member-facing role can read it.
create table public.message_unsent_evidence (
  message_id uuid primary key references public.messages (id) on delete cascade,
  body text,
  share_type text,
  share_ref uuid,
  unsent_at timestamptz not null default now()
);
create index message_unsent_evidence_age_idx on public.message_unsent_evidence (unsent_at);

create table public.message_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references public.user_profiles (id) on delete set null,
  reported_member_id uuid references public.user_profiles (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,
  scope text not null check (scope in ('MESSAGE', 'CONVERSATION')),
  reason text not null check (reason in ('SPAM', 'HARASSMENT', 'THREAT', 'HATE', 'SEXUAL', 'SCAM', 'OTHER')),
  note text check (note is null or char_length(note) <= 1000),
  -- A bounded snapshot taken at report time (the reported message and a few before it), so an unsend or a later edit cannot erase what was reported.
  evidence jsonb not null default '[]'::jsonb,
  status text not null default 'OPEN' check (status in ('OPEN', 'ACTIONED', 'DISMISSED')),
  resolved_by uuid references public.user_profiles (id) on delete set null,
  resolved_at timestamptz,
  resolution_note text check (resolution_note is null or char_length(resolution_note) <= 1000),
  created_at timestamptz not null default now()
);
create index message_reports_queue_idx on public.message_reports (status, created_at desc);
-- One report per reporter per message, and one OPEN conversation-level report per reporter per conversation (abuse-resistant: no report flooding).
create unique index message_reports_one_per_message on public.message_reports (reporter_id, message_id) where message_id is not null;
create unique index message_reports_one_open_per_conversation on public.message_reports (reporter_id, conversation_id) where scope = 'CONVERSATION' and status = 'OPEN';

-- The two-Member invariant, enforced by the schema and not only by the functions that happen never to break it:
--   * a participant row can only be for one of the two Members the conversation names (so a third participant can never be added), and
--   * a conversation's two Members never change — the only permitted change is to NULL, which is exactly what ON DELETE SET NULL does when an account is removed.
create or replace function public.conversation_participants_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (select 1 from public.conversations c where c.id = new.conversation_id and new.member_id in (c.member_low, c.member_high)) then
    raise exception 'not_a_participant';
  end if;
  return new;
end;
$$;
create trigger conversation_participants_guard before insert on public.conversation_participants for each row execute function public.conversation_participants_guard();

create or replace function public.conversation_identity_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (old.member_low is not null and new.member_low is not null and new.member_low is distinct from old.member_low)
     or (old.member_high is not null and new.member_high is not null and new.member_high is distinct from old.member_high) then
    raise exception 'conversation_members_immutable';
  end if;
  return new;
end;
$$;
create trigger conversation_identity_guard before update of member_low, member_high on public.conversations for each row execute function public.conversation_identity_guard();

-- Notifications get a real conversation link (instead of overloading another column).
alter table public.notifications add column conversation_id uuid references public.conversations (id) on delete cascade;
-- "Is there already an unread message notification for this conversation?" (coalescing, so a burst of messages is one notification).
create index notifications_conversation_unread_idx on public.notifications (user_id, conversation_id, type) where read_at is null and conversation_id is not null;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- RLS and grants: SELECT only, and only the caller's own conversations. Everything else is a service-role function below.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.member_blocks enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.messages enable row level security;
alter table public.message_unsent_evidence enable row level security;
alter table public.message_reports enable row level security;

revoke all on public.member_blocks, public.conversations, public.conversation_participants, public.messages, public.message_unsent_evidence, public.message_reports from public, anon, authenticated;
grant select on public.member_blocks, public.conversations, public.conversation_participants, public.messages to authenticated;
grant all on public.member_blocks, public.conversations, public.conversation_participants, public.messages, public.message_unsent_evidence, public.message_reports to service_role;

create policy "members_read_own_blocks" on public.member_blocks for select to authenticated using (blocker_id = auth.uid());
create policy "participants_read_conversation" on public.conversations for select to authenticated using (auth.uid() in (member_low, member_high));
create policy "members_read_own_participation" on public.conversation_participants for select to authenticated using (member_id = auth.uid());
create policy "participants_read_messages" on public.messages for select to authenticated
  using (exists (select 1 from public.conversations c where c.id = messages.conversation_id and auth.uid() in (c.member_low, c.member_high)));
-- message_unsent_evidence and message_reports: RLS on, NO policy and NO authenticated grant. Not even a participant can read them.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- An active MEMBER account (a Sponsor login has no user_profiles row, so it can never satisfy this).
create or replace function public.messaging_is_active_member(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_profiles up
    join public.account_types at on at.user_id = up.id and at.account_type = 'MEMBER'
    where up.id = p_user_id and up.is_active
  );
$$;
revoke all on function public.messaging_is_active_member(uuid) from public, anon, authenticated;
grant execute on function public.messaging_is_active_member(uuid) to service_role;

-- Messaging's own rate limiter. The shared check_and_increment_rate_limit is callable by any signed-in Member with ANY identifier, which would let one Member burn another Member's bucket and block them
-- from sending. This wrapper is service-role only (the server derives the identifier from the authenticated Member), so a Member can only ever spend their own allowance.
create or replace function public.messaging_rate_limit(p_identifier text, p_window_seconds integer, p_max_attempts integer)
returns boolean
language sql
security definer
set search_path = public
as $$
  select public.check_and_increment_rate_limit(p_identifier, p_window_seconds, p_max_attempts);
$$;
revoke all on function public.messaging_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.messaging_rate_limit(text, integer, integer) to service_role;

-- Strips control characters (except newline and tab), normalises Unicode, trims, and collapses runs of blank lines. The database is the authority; the client only does the same for UX.
create or replace function public.messaging_normalize_text(p_text text)
returns text
language sql
immutable
set search_path = public
as $$
  -- btrim's default trims spaces only, so the trim set names every whitespace character a message could be made of (space, tab, CR, LF, non-breaking space).
  select btrim(regexp_replace(regexp_replace(normalize(coalesce(p_text, ''), NFC), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g'), E'\n{3,}', E'\n\n', 'g'), E' \t\r\n\u00a0');
$$;
revoke all on function public.messaging_normalize_text(text) from public, anon, authenticated;
grant execute on function public.messaging_normalize_text(text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Sending: one function creates the conversation if needed, enforces every rule, and writes the message and notification atomically.
--   Returns jsonb {outcome, conversationId, messageId, seq, status}. Ordinary business refusals are an `outcome`, not an exception, so the UI can say something specific and plain.
--   `unavailable` is deliberately ONE code for "cannot message this Member" (blocked by them, inactive, not a Member): it never reveals which.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.messaging_send(
  p_user_id uuid,
  p_recipient_id uuid,
  p_kind text,
  p_body text,
  p_share_type text,
  p_share_ref uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_low uuid;
  v_high uuid;
  v_conv public.conversations;
  v_body text;
  v_existing public.messages;
  v_requests integer;
  v_is_request boolean := false;
  v_prev public.messages;
  v_seq bigint;
  v_msg public.messages;
  v_became_active boolean := false;
  v_reopened boolean := false;
  v_muted boolean;
  v_sender_name text;
begin
  select * into v_s from public.platform_settings where id = true;
  if v_s.messaging_enabled is not true then return jsonb_build_object('outcome', 'messaging_disabled'); end if;

  if p_kind not in ('TEXT', 'SHARE') then raise exception 'invalid_kind'; end if;
  if p_user_id is null or p_recipient_id is null then raise exception 'invalid_participant'; end if;
  if p_user_id = p_recipient_id then return jsonb_build_object('outcome', 'self'); end if;
  if not public.messaging_is_active_member(p_user_id) then raise exception 'not_a_member'; end if;
  if not public.messaging_is_active_member(p_recipient_id) then return jsonb_build_object('outcome', 'unavailable'); end if;
  -- Blocked by the recipient: the same neutral answer as an unavailable Member. Blocked by the sender: they must unblock first.
  if exists (select 1 from public.member_blocks where blocker_id = p_recipient_id and blocked_id = p_user_id) then return jsonb_build_object('outcome', 'unavailable'); end if;
  if exists (select 1 from public.member_blocks where blocker_id = p_user_id and blocked_id = p_recipient_id) then return jsonb_build_object('outcome', 'blocked_by_you'); end if;

  if p_kind = 'TEXT' then
    v_body := public.messaging_normalize_text(p_body);
    if v_body = '' then return jsonb_build_object('outcome', 'empty'); end if;
    if char_length(v_body) > v_s.messaging_max_message_length then return jsonb_build_object('outcome', 'too_long'); end if;
    if p_share_type is not null or p_share_ref is not null then raise exception 'invalid_message'; end if;
  else
    if p_share_type not in ('POST', 'MARKET', 'PICK', 'CALL_BS') or p_share_ref is null then raise exception 'invalid_share'; end if;
    if p_body is not null and public.messaging_normalize_text(p_body) <> '' then raise exception 'invalid_message'; end if;
  end if;

  if p_user_id < p_recipient_id then v_low := p_user_id; v_high := p_recipient_id; else v_low := p_recipient_id; v_high := p_user_id; end if;
  -- Serialise everything about this pair so concurrent sends, accepts and creations cannot interleave.
  perform pg_advisory_xact_lock(hashtextextended('messaging:' || v_low::text || ':' || v_high::text, 0));

  -- A retry of the same send (same sender and key) returns the original message and changes nothing.
  if p_idempotency_key is not null then
    select * into v_existing from public.messages where sender_id = p_user_id and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('outcome', 'sent', 'replay', true, 'conversationId', v_existing.conversation_id, 'messageId', v_existing.id, 'seq', v_existing.seq);
    end if;
  end if;

  select * into v_conv from public.conversations where member_low = v_low and member_high = v_high for update;
  if not found then
    insert into public.conversations (member_low, member_high, status, opened_by)
      values (v_low, v_high, 'PENDING', p_user_id) returning * into v_conv;
    insert into public.conversation_participants (conversation_id, member_id) values (v_conv.id, v_low), (v_conv.id, v_high);
  end if;

  if v_conv.status = 'PENDING' then
    if v_conv.opened_by is distinct from p_user_id then
      -- The recipient of a pending request must accept it explicitly; replying never accepts by accident.
      return jsonb_build_object('outcome', 'request_pending_accept_first', 'conversationId', v_conv.id);
    end if;
    select count(*) into v_requests from public.messages where conversation_id = v_conv.id and sender_id = p_user_id and is_request;
    if v_requests >= v_s.messaging_max_unanswered_requests then return jsonb_build_object('outcome', 'request_limit', 'conversationId', v_conv.id); end if;
    v_is_request := true;
  elsif v_conv.status = 'DECLINED' then
    if v_conv.opened_by = p_user_id then
      -- The sender may ask again, but declined requests still count: this is what stops delete-and-recreate or repeated asking.
      select count(*) into v_requests from public.messages where conversation_id = v_conv.id and sender_id = p_user_id and is_request;
      if v_requests >= v_s.messaging_max_unanswered_requests then return jsonb_build_object('outcome', 'request_limit', 'conversationId', v_conv.id); end if;
      v_is_request := true;
      v_reopened := true;
    else
      -- The Member who declined is now writing first: that is their own choice to open the conversation.
      v_became_active := true;
    end if;
  end if;

  if p_kind = 'TEXT' and v_s.messaging_duplicate_window_seconds > 0 then
    select * into v_prev from public.messages where conversation_id = v_conv.id and sender_id = p_user_id and kind = 'TEXT' order by seq desc limit 1;
    if found and v_prev.body is not distinct from v_body and v_prev.created_at > now() - make_interval(secs => v_s.messaging_duplicate_window_seconds) then
      return jsonb_build_object('outcome', 'duplicate_message', 'conversationId', v_conv.id);
    end if;
  end if;

  v_seq := v_conv.message_count + 1;
  insert into public.messages (conversation_id, seq, sender_id, kind, body, share_type, share_ref, is_request, idempotency_key)
    values (v_conv.id, v_seq, p_user_id, p_kind, case when p_kind = 'TEXT' then v_body else null end,
            case when p_kind = 'SHARE' then p_share_type else null end, case when p_kind = 'SHARE' then p_share_ref else null end, v_is_request, p_idempotency_key)
    returning * into v_msg;

  update public.conversations set
    message_count = v_seq, last_message_at = v_msg.created_at, last_sender_id = p_user_id,
    status = case when v_reopened then 'PENDING' when v_became_active then 'ACTIVE' else status end,
    accepted_at = case when v_became_active then now() else accepted_at end,
    declined_at = case when v_reopened then null else declined_at end
    where id = v_conv.id;
  -- The sender has, by definition, read their own message.
  update public.conversation_participants set last_read_seq = v_seq where conversation_id = v_conv.id and member_id = p_user_id;

  select display_name into v_sender_name from public.user_profiles where id = p_user_id;
  select (muted_at is not null) into v_muted from public.conversation_participants where conversation_id = v_conv.id and member_id = p_recipient_id;

  if v_conv.status = 'ACTIVE' or v_became_active then
    if v_became_active then
      insert into public.notifications (user_id, type, title, body, conversation_id)
        values (p_recipient_id, 'MESSAGE_REQUEST_ACCEPTED', 'Message request accepted', coalesce(v_sender_name, 'A Member') || ' can now message you.', v_conv.id);
    elsif not coalesce(v_muted, false)
      and not exists (select 1 from public.notifications where user_id = p_recipient_id and conversation_id = v_conv.id and type = 'MESSAGE_RECEIVED' and read_at is null) then
      insert into public.notifications (user_id, type, title, body, conversation_id)
        values (p_recipient_id, 'MESSAGE_RECEIVED', 'New message', coalesce(v_sender_name, 'A Member') || ' sent you a message.', v_conv.id);
    end if;
  elsif v_is_request
    and not exists (select 1 from public.notifications where user_id = p_recipient_id and conversation_id = v_conv.id and type = 'MESSAGE_REQUEST_RECEIVED' and read_at is null) then
    insert into public.notifications (user_id, type, title, body, conversation_id)
      values (p_recipient_id, 'MESSAGE_REQUEST_RECEIVED', 'New message request', coalesce(v_sender_name, 'A Member') || ' wants to message you.', v_conv.id);
  end if;

  return jsonb_build_object('outcome', 'sent', 'conversationId', v_conv.id, 'messageId', v_msg.id, 'seq', v_seq, 'isRequest', v_is_request);
end;
$$;
revoke all on function public.messaging_send(uuid, uuid, text, text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.messaging_send(uuid, uuid, text, text, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Accept / decline a request. Only the recipient (not the opener) may. Idempotent. A decline is silent toward the sender.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.messaging_respond_request(p_user_id uuid, p_conversation_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_conv public.conversations;
  v_other uuid;
  v_name text;
begin
  select * into v_s from public.platform_settings where id = true;
  if v_s.messaging_enabled is not true then return jsonb_build_object('outcome', 'messaging_disabled'); end if;
  if p_action not in ('ACCEPT', 'DECLINE') then raise exception 'invalid_action'; end if;
  if not public.messaging_is_active_member(p_user_id) then raise exception 'not_a_member'; end if;

  select * into v_conv from public.conversations where id = p_conversation_id for update;
  -- IS DISTINCT FROM, never NOT IN: a missing participant is NULL and `x NOT IN (y, NULL)` is never true, which would let a non-participant through.
  if not found or (p_user_id is distinct from v_conv.member_low and p_user_id is distinct from v_conv.member_high) then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  v_other := case when v_conv.member_low = p_user_id then v_conv.member_high else v_conv.member_low end;
  if v_other is null or v_conv.opened_by is null or v_conv.opened_by = p_user_id then return jsonb_build_object('outcome', 'not_found'); end if;

  if p_action = 'ACCEPT' then
    if v_conv.status = 'ACTIVE' then return jsonb_build_object('outcome', 'accepted', 'conversationId', v_conv.id, 'replay', true); end if;
    if v_conv.status <> 'PENDING' then return jsonb_build_object('outcome', 'not_pending', 'conversationId', v_conv.id); end if;
    if exists (select 1 from public.member_blocks where blocker_id = v_other and blocked_id = p_user_id) then return jsonb_build_object('outcome', 'unavailable'); end if;
    update public.conversations set status = 'ACTIVE', accepted_at = now() where id = v_conv.id;
    select display_name into v_name from public.user_profiles where id = p_user_id;
    if not exists (select 1 from public.member_blocks where blocker_id = v_other and blocked_id = p_user_id) then
      insert into public.notifications (user_id, type, title, body, conversation_id)
        values (v_other, 'MESSAGE_REQUEST_ACCEPTED', 'Message request accepted', coalesce(v_name, 'A Member') || ' accepted your message request.', v_conv.id);
    end if;
    insert into public.audit_logs (actor_id, action, entity_type, entity_id) values (p_user_id, 'messaging.request_accepted', 'conversation', v_conv.id::text);
    return jsonb_build_object('outcome', 'accepted', 'conversationId', v_conv.id);
  end if;

  if v_conv.status = 'DECLINED' then return jsonb_build_object('outcome', 'declined', 'conversationId', v_conv.id, 'replay', true); end if;
  if v_conv.status <> 'PENDING' then return jsonb_build_object('outcome', 'not_pending', 'conversationId', v_conv.id); end if;
  update public.conversations set status = 'DECLINED', declined_at = now() where id = v_conv.id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id) values (p_user_id, 'messaging.request_declined', 'conversation', v_conv.id::text);
  return jsonb_build_object('outcome', 'declined', 'conversationId', v_conv.id);
end;
$$;
revoke all on function public.messaging_respond_request(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.messaging_respond_request(uuid, uuid, text) to service_role;

-- Read cursor: one row update per open, never one write per message.
create or replace function public.messaging_mark_read(p_user_id uuid, p_conversation_id uuid, p_seq bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.conversation_participants p
    set last_read_seq = greatest(p.last_read_seq, least(coalesce(p_seq, 0), c.message_count))
    from public.conversations c
    where c.id = p.conversation_id and p.conversation_id = p_conversation_id and p.member_id = p_user_id;
$$;
revoke all on function public.messaging_mark_read(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.messaging_mark_read(uuid, uuid, bigint) to service_role;

create or replace function public.messaging_set_mute(p_user_id uuid, p_conversation_id uuid, p_muted boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.conversation_participants set muted_at = case when p_muted then coalesce(muted_at, now()) else null end
    where conversation_id = p_conversation_id and member_id = p_user_id;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
revoke all on function public.messaging_set_mute(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.messaging_set_mute(uuid, uuid, boolean) to service_role;

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
  else
    delete from public.member_blocks where blocker_id = p_user_id and blocked_id = p_blocked_id;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then insert into public.audit_logs (actor_id, action, entity_type, entity_id) values (p_user_id, 'messaging.unblocked', 'member', p_blocked_id::text); end if;
  end if;
  return jsonb_build_object('outcome', case when p_blocked then 'blocked' else 'unblocked' end);
end;
$$;
revoke all on function public.messaging_set_block(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.messaging_set_block(uuid, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Unsend: the sender's own message, inside the configured window. The original is moved to evidence (kept per retention) and the visible row keeps only a tombstone.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.messaging_unsend(p_user_id uuid, p_message_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_msg public.messages;
begin
  select * into v_s from public.platform_settings where id = true;
  if v_s.messaging_enabled is not true then return jsonb_build_object('outcome', 'messaging_disabled'); end if;
  if not public.messaging_is_active_member(p_user_id) then raise exception 'not_a_member'; end if;

  select * into v_msg from public.messages where id = p_message_id for update;
  -- Someone else's message and a missing one are the same answer.
  if not found or v_msg.sender_id is distinct from p_user_id then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_msg.unsent_at is not null then return jsonb_build_object('outcome', 'unsent', 'messageId', v_msg.id, 'replay', true); end if;
  if v_msg.moderation_removed_at is not null then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_s.messaging_unsend_window_seconds <= 0 then return jsonb_build_object('outcome', 'unsend_disabled'); end if;
  if now() > v_msg.created_at + make_interval(secs => v_s.messaging_unsend_window_seconds) then return jsonb_build_object('outcome', 'window_expired'); end if;

  insert into public.message_unsent_evidence (message_id, body, share_type, share_ref) values (v_msg.id, v_msg.body, v_msg.share_type, v_msg.share_ref) on conflict do nothing;
  update public.messages set body = null, share_ref = null, unsent_at = now() where id = v_msg.id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id) values (p_user_id, 'messaging.unsent', 'message', v_msg.id::text);
  return jsonb_build_object('outcome', 'unsent', 'messageId', v_msg.id);
end;
$$;
revoke all on function public.messaging_unsend(uuid, uuid) from public, anon, authenticated;
grant execute on function public.messaging_unsend(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Report a message or a conversation. Creates a bounded moderation record with an evidence snapshot. The reporter is never revealed to the reported Member.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.messaging_report(p_user_id uuid, p_conversation_id uuid, p_message_id uuid, p_reason text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.platform_settings;
  v_conv public.conversations;
  v_msg public.messages;
  v_other uuid;
  v_reported uuid;
  v_scope text;
  v_evidence jsonb;
  v_ref_seq bigint;
  v_id uuid;
  v_note text;
begin
  select * into v_s from public.platform_settings where id = true;
  if v_s.messaging_enabled is not true then return jsonb_build_object('outcome', 'messaging_disabled'); end if;
  if not public.messaging_is_active_member(p_user_id) then raise exception 'not_a_member'; end if;
  if p_reason not in ('SPAM', 'HARASSMENT', 'THREAT', 'HATE', 'SEXUAL', 'SCAM', 'OTHER') then raise exception 'invalid_reason'; end if;
  v_note := nullif(left(public.messaging_normalize_text(p_note), 1000), '');

  select * into v_conv from public.conversations where id = p_conversation_id;
  if not found or (p_user_id is distinct from v_conv.member_low and p_user_id is distinct from v_conv.member_high) then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  v_other := case when v_conv.member_low = p_user_id then v_conv.member_high else v_conv.member_low end;
  v_reported := v_other;
  v_scope := 'CONVERSATION';
  v_ref_seq := v_conv.message_count;

  if p_message_id is not null then
    select * into v_msg from public.messages where id = p_message_id and conversation_id = v_conv.id;
    if not found then return jsonb_build_object('outcome', 'not_found'); end if;
    if v_msg.sender_id = p_user_id then return jsonb_build_object('outcome', 'own_message'); end if;
    v_scope := 'MESSAGE';
    v_reported := v_msg.sender_id;
    v_ref_seq := v_msg.seq;
  end if;

  -- Evidence: the reported message (its original content even if since unsent) plus up to five before it.
  select coalesce(jsonb_agg(jsonb_build_object(
      'seq', m.seq, 'at', m.created_at, 'from', case when m.sender_id = p_user_id then 'reporter' else 'reported' end, 'kind', m.kind,
      'body', coalesce(m.body, e.body), 'shareType', coalesce(m.share_type, e.share_type), 'shareRef', coalesce(m.share_ref, e.share_ref),
      'unsent', m.unsent_at is not null) order by m.seq), '[]'::jsonb)
    into v_evidence
    from (select * from public.messages where conversation_id = v_conv.id and seq <= v_ref_seq order by seq desc limit case when v_scope = 'MESSAGE' then 6 else 20 end) m
    left join public.message_unsent_evidence e on e.message_id = m.id;

  begin
    insert into public.message_reports (reporter_id, reported_member_id, conversation_id, message_id, scope, reason, note, evidence)
      values (p_user_id, v_reported, v_conv.id, p_message_id, v_scope, p_reason, v_note, v_evidence) returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('outcome', 'already_reported');
  end;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id) values (p_user_id, 'messaging.reported', 'message_report', v_id::text);
  return jsonb_build_object('outcome', 'reported', 'reportId', v_id);
end;
$$;
revoke all on function public.messaging_report(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.messaging_report(uuid, uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Super Admin: resolve a report (bounded moderation, audited), and the settings.
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
begin
  perform public.require_super_admin(p_admin_id);
  if p_action not in ('DISMISS', 'HIDE_MESSAGE', 'ACTION') then raise exception 'invalid_action'; end if;
  v_note := nullif(left(public.messaging_normalize_text(p_note), 1000), '');
  select * into v_report from public.message_reports where id = p_report_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_report.status <> 'OPEN' then return jsonb_build_object('outcome', 'already_resolved', 'status', v_report.status); end if;

  if p_action = 'HIDE_MESSAGE' then
    if v_report.message_id is null then return jsonb_build_object('outcome', 'no_message'); end if;
    -- The reported content stays in the report's own evidence; the conversation shows a tombstone.
    insert into public.message_unsent_evidence (message_id, body, share_type, share_ref)
      select id, body, share_type, share_ref from public.messages where id = v_report.message_id on conflict do nothing;
    update public.messages set body = null, share_ref = null, moderation_removed_at = now() where id = v_report.message_id;
  end if;

  update public.message_reports set status = case when p_action = 'DISMISS' then 'DISMISSED' else 'ACTIONED' end, resolved_by = p_admin_id, resolved_at = now(), resolution_note = v_note where id = p_report_id;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, reason) values (p_admin_id, 'messaging.report_' || lower(p_action), 'message_report', p_report_id::text, v_note);
  return jsonb_build_object('outcome', 'resolved');
end;
$$;
revoke all on function public.admin_messaging_resolve_report(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_messaging_resolve_report(uuid, uuid, text, text) to service_role;

-- Messaging policy in one audited call. `p_config` carries only the keys being changed; every key is validated against the same ranges as the table constraints (which remain the authority).
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
    'messaging_retention_deleted_account_days', 'messaging_retention_moderation_days'];
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
    messaging_retention_deleted_account_days = case when p_config ? 'messaging_retention_deleted_account_days' then (p_config ->> 'messaging_retention_deleted_account_days')::integer else messaging_retention_deleted_account_days end,
    messaging_retention_moderation_days = case when p_config ? 'messaging_retention_moderation_days' then (p_config ->> 'messaging_retention_moderation_days')::integer else messaging_retention_moderation_days end,
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
revoke all on function public.admin_set_messaging_config(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_set_messaging_config(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Retention: bounded, indexed, driven only by the settings. NULL durations delete nothing. NOT scheduled by this milestone — the owner and counsel set the durations first, then scheduling is
-- a separate, approved step. Returns how many rows each category removed (at most p_batch per category per call).
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
  v_deleted_account integer := 0;
  v_moderation integer := 0;
begin
  select * into v_s from public.platform_settings where id = true;
  if p_batch is null or p_batch < 1 then p_batch := 500; end if;

  if v_s.messaging_retention_messages_days is not null then
    delete from public.messages where id in (select id from public.messages where created_at < now() - make_interval(days => v_s.messaging_retention_messages_days) order by created_at limit p_batch);
    get diagnostics v_messages = row_count;
  end if;
  if v_s.messaging_retention_unsent_days is not null then
    delete from public.message_unsent_evidence where message_id in (select message_id from public.message_unsent_evidence where unsent_at < now() - make_interval(days => v_s.messaging_retention_unsent_days) order by unsent_at limit p_batch);
    get diagnostics v_unsent = row_count;
  end if;
  if v_s.messaging_retention_reported_days is not null then
    update public.message_reports set evidence = '[]'::jsonb
      where id in (select id from public.message_reports where evidence <> '[]'::jsonb and created_at < now() - make_interval(days => v_s.messaging_retention_reported_days) order by created_at limit p_batch);
    get diagnostics v_reported = row_count;
  end if;
  if v_s.messaging_retention_deleted_account_days is not null then
    delete from public.conversations where id in (
      select id from public.conversations where (member_low is null or member_high is null) and coalesce(last_message_at, created_at) < now() - make_interval(days => v_s.messaging_retention_deleted_account_days)
      order by coalesce(last_message_at, created_at) limit p_batch);
    get diagnostics v_deleted_account = row_count;
  end if;
  if v_s.messaging_retention_moderation_days is not null then
    delete from public.message_reports where id in (select id from public.message_reports where status <> 'OPEN' and resolved_at < now() - make_interval(days => v_s.messaging_retention_moderation_days) order by resolved_at limit p_batch);
    get diagnostics v_moderation = row_count;
  end if;
  return jsonb_build_object('messages', v_messages, 'unsentEvidence', v_unsent, 'reportedEvidence', v_reported, 'deletedAccountConversations', v_deleted_account, 'moderationRecords', v_moderation);
end;
$$;
revoke all on function public.messaging_purge_expired(integer) from public, anon, authenticated;
grant execute on function public.messaging_purge_expired(integer) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Reads for the Member's own inbox. These are the only functions exposed to the signed-in role, so (like every function exposed to client roles in this schema) they are SECURITY DEFINER; what keeps
-- them private is that EVERY row is selected through auth.uid() — the caller's own participation row and a conversation naming them — so a Member sees only their own, a Sponsor session (which is
-- never a participant) and any other Member get nothing, and the public has no EXECUTE at all. One query each, so the inbox and the unread badge never cost one request per conversation.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.messaging_inbox(p_limit integer default 30, p_before timestamptz default null)
returns table (
  conversation_id uuid, status text, opened_by uuid, counterpart_id uuid, last_message_at timestamptz, last_sender_id uuid, message_count bigint,
  last_read_seq bigint, muted boolean, preview_kind text, preview_body text, preview_share_type text, preview_removed boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.status, c.opened_by, case when c.member_low = auth.uid() then c.member_high else c.member_low end,
         c.last_message_at, c.last_sender_id, c.message_count, p.last_read_seq, (p.muted_at is not null),
         m.kind, m.body, m.share_type, (m.unsent_at is not null or m.moderation_removed_at is not null)
  from public.conversations c
  join public.conversation_participants p on p.conversation_id = c.id and p.member_id = auth.uid()
  left join lateral (select kind, body, share_type, unsent_at, moderation_removed_at from public.messages where conversation_id = c.id and seq = c.message_count) m on true
  where auth.uid() in (c.member_low, c.member_high) and c.last_message_at is not null and (p_before is null or c.last_message_at < p_before)
  order by c.last_message_at desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;
revoke all on function public.messaging_inbox(integer, timestamptz) from public, anon;
grant execute on function public.messaging_inbox(integer, timestamptz) to authenticated, service_role;

create or replace function public.messaging_unread_summary()
returns table (unread_conversations integer, pending_requests integer)
language sql
stable
security definer
set search_path = public
as $$
  select (count(*) filter (where c.status = 'ACTIVE' and c.last_sender_id is distinct from auth.uid() and c.message_count > p.last_read_seq))::integer,
         (count(*) filter (where c.status = 'PENDING' and c.opened_by is distinct from auth.uid()))::integer
  from public.conversation_participants p
  join public.conversations c on c.id = p.conversation_id
  where p.member_id = auth.uid();
$$;
revoke all on function public.messaging_unread_summary() from public, anon;
grant execute on function public.messaging_unread_summary() to authenticated, service_role;
