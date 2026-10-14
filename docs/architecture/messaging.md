# Member Messaging (r78)

Private Member-to-Member messaging, tightly aligned with the product: it exists to deepen sports relationships — an argument, a challenge, a rematch — not to be a general-purpose messenger. **OFF by default** (`platform_settings.messaging_enabled`), fails closed.

## Permanent invariants (schema, not settings)

| Rule | Where it is enforced |
| --- | --- |
| Exactly two participants, both Members | `conversations.member_low < member_high`; a trigger refuses a participant row for anyone but those two and refuses ever re-pointing the pair (only → NULL, which is what removing an account does) |
| One conversation per unordered pair | unique index on `(member_low, member_high)`; A↔B and B↔A are the same row; a per-pair advisory lock serialises concurrent creation |
| No group chat | there is no group concept in any table or function |
| Text and structured Brohda-object shares only | `messages.kind in ('TEXT','SHARE')`; `share_type in ('POST','MARKET','PICK','CALL_BS')`; no image/media/file/voice column exists anywhere (guarded by a schema test) |
| No Sponsor | participants reference `user_profiles`, and a Sponsor login has no profile; every function also re-checks "active Member" |
| No edit, no reactions, no search, no broadcast | not built |

## Data model (migration 198)

`member_blocks`, `conversations`, `conversation_participants` (read cursor and mute, one row per Member), `messages`, `message_unsent_evidence`, `message_reports`; `notifications.conversation_id`; the settings below.

Indexes and why: `conversations_pair_unique` (the canonical pair); `conversations_low/high_activity_idx` (the inbox, newest first); `conversation_participants_member_idx` (everything starts from "my participations"); `messages (conversation_id, seq)` unique (thread order and the poll cursor); `messages_request_idx` (counting requests); `messages_created_idx` and `message_unsent_evidence_age_idx` (retention by age); `message_reports_queue_idx` (the moderation queue); `member_blocks_blocked_idx` ("has anyone I'm writing to blocked me?"); `notifications_conversation_unread_idx` (coalescing).

## Access model

Every write is a SECURITY DEFINER function callable only by the service role; the server actions call them with the **authenticated Member's own id** (never a client value). The browser's role can only SELECT, through RLS limiting it to the caller's own conversations and messages. The other side's mute and read state, unsent and reported content and all moderation records are in tables with no Member-facing grant at all. A conversation that is not yours is indistinguishable from one that does not exist. Counterpart names are read with a narrow server-side loader (a Member's session can read only their own `user_profiles` row), only for ids that came out of the Member's own conversations or the one Member they chose to message.

## Message Requests

A message to a Member with no accepted conversation is a **request** (`messages.is_request`). The model, reported explicitly because the spec left the exact number open:

- Each pre-acceptance message is one request. A sender can have `messaging_max_unanswered_requests` (default **2**) requests outstanding or declined to the same Member; the next is refused (`request_limit`). Text and shared objects count alike, so sending a Game instead of text is no bypass.
- The recipient must **Accept** explicitly; replying never accepts by accident, and while a request is pending the recipient is told to accept first. Accept is idempotent and notifies the requester once.
- **Decline** is silent toward the sender (it still reads as a request they sent) and **still counts**, so the sender cannot ask indefinitely. A declined conversation is re-opened by a further request (up to the cap), never recreated; participants cannot delete conversations, so delete-and-recreate cannot reset anything. Unsending a request does not give it back.
- If the Member who declined later writes first, that opens the conversation on their terms.
- Rate limits sit in front of this: new requests are limited per Member across all recipients (`messaging_request_rate_*`).

## Block, Mute, Report

- **Block** (`member_blocks`): the blocked Member cannot send (the answer is the single neutral "You can't message this Member" — it never says why) or open a request, and no notification is produced. History is kept. The blocker must unblock before writing. Block is **Messaging-only**: whether it should also cover Call BS or comments is a separate product decision and was not assumed.
- **Mute**: per Member per conversation; messages still flow both ways, ordinary notifications are suppressed; the other Member cannot see it.
- **Report**: a message or a conversation. Creates a bounded moderation record with an evidence snapshot (the reported message and up to five before it; up to 20 for a conversation) so a later unsend cannot erase it. One report per reporter per message, one open conversation report per reporter. The reporter is never shown to the reported Member.

## Unsend and the tombstone

A sender can delete their own message within `messaging_unsend_window_seconds` (default 900; 0 turns it off). The visible row keeps only a tombstone ("X deleted a message."); the original moves to `message_unsent_evidence`, which no Member-facing role can read. Retention of that evidence is its own setting.

## Sharing Brohda objects

A message stores only `(type, id)` — a live reference, never a copy — so the canonical object stays the source of truth and a removed object renders as "This isn't available." Rendering is done per viewer on the server:

- **Game Post / Market:** anything a Member can already open; the card links to the ordinary page, which enforces its own gate.
- **Pick:** only the sender's **own** Pick, shown as an explicit disclosure the sender chose to make (Game, Market, side, result once graded). *Decision to confirm with the owner:* Picks are private by RLS, so sharing is the sender's own consent to reveal that one Pick; nothing else about it is shown (there is no Confidence or money on a Pick yet).
- **Call BS:** only one the sender is in. The other participant sees it fully; anyone else sees it only once it is `RESOLVED`, which is exactly the existing public-record rule.
- A shared Pick is attributed to the message's own `sender_id`, so a Pick can only ever be shown as its owner's.

A pasted Brohda Post/Market link becomes a card; any other link in text is plain text. Message text is rendered as text, never HTML, and URLs are **not** made clickable in V1 (no phishing surface, no previews).

## Configuration (no deploy to change policy)

All in `platform_settings`, edited on Settings → Brohda → Messaging through one audited function (`settings.messaging_updated`): the capability; maximum message length (default 1000, table ceiling 4000); requests before a reply (2); unsend window (900 s); repeat-message window (30 s); send / new-request / report rate limits (windows and caps); the open-conversation refresh interval (10 s); and five retention durations (default blank = keep). The only hard numbers are technical ceilings (4000 characters, range checks) mirrored from the table constraints.

## Delivery, query volume and egress

No custom sockets and no cron. The conversation view does **one** small cursor query per tick (`seq > cursor` plus anything unsent since the last look), only while the tab is visible, and an idle tab slows to six times the configured interval and snaps back on news, visibility or send. The inbox is one function call (scoped to the caller by `auth.uid()`) plus one profile lookup; the unread badge is one indexed query per page load, and only while Messaging is on (the shell's cheap check reads a single boolean and is de-duplicated within a render). Nothing re-walks history. Read state is one cursor row per Member per conversation, never a write per message.

## Notifications

Reuses the existing notification table and center (`MESSAGE_REQUEST_RECEIVED`, `MESSAGE_REQUEST_ACCEPTED`, `MESSAGE_RECEIVED`), with the conversation as the link. A burst of messages coalesces into one unread notification per conversation; the request cap bounds request notifications; blocks and mutes suppress them; the text carries the sender's name, never message content.

## Retention (built, not scheduled)

`messaging_purge_expired(batch)` removes, per its own setting and in bounded indexed batches: ordinary messages, unsent-message originals, report evidence, conversations of removed accounts, and resolved moderation records. Every duration defaults to NULL = keep, and **nothing schedules the function** — the owner and counsel set durations first, then scheduling is a separate approved step. Known gap: closing an account (`close_own_account`) deactivates and scrubs the profile but leaves the row, and the schema has no closure marker, so the "removed account" sweep recognises only a deleted profile, not a closed one.

## Privacy and moderation access

Participants read their own conversations. There is **no** Super Admin UI to browse messages. Super Admin sees reports and their bounded evidence at Admin → Moderation (hide a message, dismiss, mark actioned; each audited, with the report's evidence kept). Raw access exists only at the infrastructure level (anyone holding the database service key), which is outside the product. Message bodies are never logged; audit entries carry ids and actions only.

## Not built (by design, this milestone)

Group chat, images, video, voice, files, broadcasts, reactions, message editing, search, Stories, Friends/Followers, link previews; any Confidence, Rewards or Rivalry dependency; abuse signalling beyond rate limits, the request cap, the repeat-message rule and report de-duplication (flagging on repeated declines or blocks, account-age and device/network signals are designed for but not built); outcome notifications to reporters; a block that also covers Call BS or comments.
