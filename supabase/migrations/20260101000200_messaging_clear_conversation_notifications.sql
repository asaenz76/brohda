-- r81 — Opening a conversation clears THAT conversation's Messaging notifications.
--
-- Until now messaging_mark_read only moved the read cursor, so the Notifications bubble for "New message", "Message request accepted" and "New message request" stayed until the Member pressed "mark all
-- read". The same function (still service-role only, still one indexed write per open) now also marks the caller's own unread Messaging notifications for that one conversation as read. Nothing else is
-- touched: other conversations' notifications and every non-Messaging notification are unchanged.
create or replace function public.messaging_mark_read(p_user_id uuid, p_conversation_id uuid, p_seq bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.conversation_participants p
    set last_read_seq = greatest(p.last_read_seq, least(coalesce(p_seq, 0), c.message_count))
    from public.conversations c
    where c.id = p.conversation_id and p.conversation_id = p_conversation_id and p.member_id = p_user_id;

  -- Only if the caller really is a participant (the update above matched them); uses notifications_conversation_unread_idx.
  if exists (select 1 from public.conversation_participants where conversation_id = p_conversation_id and member_id = p_user_id) then
    update public.notifications
      set read_at = now()
      where user_id = p_user_id and conversation_id = p_conversation_id and read_at is null
        and type in ('MESSAGE_RECEIVED', 'MESSAGE_REQUEST_RECEIVED', 'MESSAGE_REQUEST_ACCEPTED');
  end if;
end;
$$;
revoke all on function public.messaging_mark_read(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.messaging_mark_read(uuid, uuid, bigint) to service_role;
