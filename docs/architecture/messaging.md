# Member Messaging (r78, owner decisions r80)

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

- **Block** (`member_blocks`) is a **relationship boundary between two Members** (decision 3 of the Milestone 2 owner decisions), not global moderation. While a block exists, in either direction:
  - **Messaging:** no DMs and no Message Requests. The blocked Member's answer is the single neutral "You can't message this Member" — it never says why — and no notification is produced. History is kept; the blocker must unblock before writing.
  - **Call BS:** neither Member can send the other a Call BS (`call_bs()` refuses with one neutral code for both directions, so it never reveals who blocked whom), an accept can no longer succeed (the Call BS ends as `RELATIONSHIP_BLOCKED`), blocking ends any still-pending Call BS between the pair the same way, and the Post's "Call BS" prompt is not offered between them. `RELATIONSHIP_BLOCKED` never counts as ignored (see `call-bs-challenges.md`).
  - **Comments and replies:** nobody's public comments are deleted or hidden for other Members. A **direct reply** between the pair is refused (`add_post_comment` raises one neutral code; top-level comments are untouched). The **blocker's own view** hides the blocked Member's comments: a comment others replied to stays as a placeholder (so their replies keep their context), one with no visible replies is left out. Being blocked changes nothing about what you see. There is no @mention engine, so there is nothing to suppress there (if one is added it must call `members_blocked`).
  - Block works from a Member's **profile** whether or not Messaging is on (`lib/actions/member-block.ts`), and from a conversation. Blocking asks first and says what it does.
  - The one question "is there a block between these two Members?" is answered by `public.members_blocked(a, b)`; every enforcement point uses it.
- **Mute**: per Member per conversation; messages still flow both ways, ordinary notifications are suppressed; the other Member cannot see it.
- **Report**: a message or a conversation. Creates a bounded moderation record with an evidence snapshot (the reported message and up to five before it; up to 20 for a conversation) so a later unsend cannot erase it. One report per reporter per message, one open conversation report per reporter. The reporter is never shown to the reported Member. When a Super Admin resolves it the **reporter** gets one generic notification (below).

## Unsend and the tombstone

A sender can delete their own message within `messaging_unsend_window_seconds` (default 900; 0 turns it off). The visible row keeps only a tombstone ("X deleted a message."); the original moves to `message_unsent_evidence`, which no Member-facing role can read. Retention of that evidence is its own setting.

## Sharing Brohda objects

A message stores only `(type, id)` — a live reference, never a copy — so the canonical object stays the source of truth and a removed object renders as "This isn't available." Rendering is done per viewer on the server:

- **Game Post / Market:** anything a Member can already open; the card links to the ordinary page, which enforces its own gate.
- **Pick:** only the sender's **own** Pick. **Owner decision (final):** sharing a Pick is explicit, sender-consented disclosure — the sender's deliberate Share action authorizes disclosure of that one Pick to the chosen conversation's recipient, and nothing else. The card shows only the context needed to understand it (Game, Market, side, result once graded). It never exposes unrelated prediction history, private account data, any future private Confidence ledger data, moderation data or anti-abuse data, and server authorization still applies (`senderMayShare`, re-checked on every send and on every render).
- **Call BS:** only one the sender is in. The other participant sees it fully; anyone else sees it only once it is `RESOLVED`, which is exactly the existing public-record rule.
- A shared Pick is attributed to the message's own `sender_id`, so a Pick can only ever be shown as its owner's.

A pasted Brohda Post/Market link becomes a card; any other link in text is plain text. Message text is rendered as text, never HTML, and URLs are **not** made clickable in V1 (no phishing surface, no previews).

## Configuration (no deploy to change policy)

All in `platform_settings`, edited on Settings → Brohda → Messaging through one audited function (`settings.messaging_updated`): the capability; maximum message length (default 1000, table ceiling 4000); requests before a reply (2); unsend window (900 s); repeat-message window (30 s); send / new-request / report rate limits (windows and caps); the open-conversation refresh interval (10 s); six retention durations and their master switch, the abuse-signal thresholds and the opt-in restriction rule, and the reporter-notification switch (policy defaults above). The only hard numbers are technical ceilings (4000 characters, range checks) mirrored from the table constraints.

## Delivery, query volume and egress

No custom sockets and no cron. The conversation view does **one** small cursor query per tick (`seq > cursor` plus anything unsent since the last look), only while the tab is visible, and an idle tab slows to six times the configured interval and snaps back on news, visibility or send. The inbox is one function call (scoped to the caller by `auth.uid()`) plus one profile lookup; the unread badge is one indexed query per page load, and only while Messaging is on (the shell's cheap check reads a single boolean and is de-duplicated within a render). Nothing re-walks history. Read state is one cursor row per Member per conversation, never a write per message.

## Notifications

Reuses the existing notification table and center (`MESSAGE_REQUEST_RECEIVED`, `MESSAGE_REQUEST_ACCEPTED`, `MESSAGE_RECEIVED`), with the conversation as the link. A burst of messages coalesces into one unread notification per conversation; the request cap bounds request notifications; blocks and mutes suppress them; the text carries the sender's name, never message content.

## Account closure (the one source of truth)

`user_profiles.account_closed_at` (migration 199) is set **once, by `close_own_account()`**, and never changed or cleared (a trigger refuses). It is the only thing retention treats as "this account was closed". `is_active = false` cannot be used: an admin deactivation clears it too. Retention never infers closure from a missing profile, inactivity, an old conversation or email state, and the schema has no backfill because no Messaging data pre-dates the marker.

## Retention

All durations are in `platform_settings` and editable on Settings → Brohda → Messaging without a deploy. The model is semantic, not a pile of integers:

| Policy | Setting | Default | Meaning |
| --- | --- | --- | --- |
| Ordinary messages | `messaging_retention_messages_days` | **NULL** | NULL = **no age-based purge** while the accounts and conversation remain active. A number is an explicit, owner-approved choice. |
| Unsent / moderator-removed originals | `messaging_retention_unsent_days` | 30 | Counted from when the message was unsent. Never applied to a message on an **open report** or under a hold. |
| Report evidence | `messaging_retention_reported_days` | 180 | Counted from **case closure** (`resolved_at`). An open report is never purged. |
| Content after account closure | `messaging_retention_closed_account_days` | 30 | Counted from `account_closed_at`. Only unprotected messages go; the emptied conversation shell goes too unless it still holds a protected message. |
| Resolved report record | `messaging_retention_moderation_days` | NULL | The decision record itself (not the evidence). NULL keeps it. |
| Messaging security metadata | `messaging_retention_audit_days` | 365 | Resolved abuse signals, ended restrictions, released holds. **`audit_logs` is append-only by design and is never touched** — audit entries carry ids and actions only, never content. |
| **Master switch** | `messaging_retention_purge_enabled` | **OFF** | With it off, `messaging_purge_expired` returns `{enabled:false}` and deletes nothing, whatever the durations say. |

`messaging_purge_expired(batch)` does the work in bounded, indexed batches; `lib/messaging/retention.ts` loops it a bounded number of rounds per tick, and the existing `prune-provider-request-log` cron route (the one housekeeping job — no new external scheduler entry) calls it in its own failure domain. Scheduling is therefore wired, and **safe by construction**: nothing is deleted until the owner turns the master switch on.

### Retention holds

A hold preserves **only what it names** — there is no Member-wide or conversation-wide hold (the schema refuses one):

- `MESSAGE` — one message (and its unsent original);
- `REPORT` — one report: its record, its evidence and the message it names;
- `CONVERSATION_RANGE` — a bounded run (at most 200) of messages in one conversation.

Reasons: `ABUSE_INVESTIGATION`, `MODERATION_CASE`, `LEGAL_OBLIGATION`. A note is required; placing and releasing are Super Admin only (`admin_messaging_place_hold` / `admin_messaging_release_hold`) and audited (`messaging.hold_placed` / `messaging.hold_released`). An **unresolved report** protects its message implicitly, with no hold needed. Holds are managed on Admin → Moderation.

## Abuse signals

Rate limits stay the primary automated prevention. On top, **bounded, auditable signals** are raised by database triggers (so detection can never be skipped by a code path, and a failure in detection can never break the action that triggered it):

| Signal | About | Counts | May restrict? |
| --- | --- | --- | --- |
| `EXCESSIVE_REQUESTS` | the sender | request messages in the window | yes (opt-in) |
| `REPEATED_DECLINES` | the requester | their requests declined in the window | yes (opt-in) |
| `DUPLICATE_BURST` | the sender | identical texts across conversations | yes (opt-in) |
| `RAPID_MESSAGING` | the sender | messages in a short window | yes (opt-in) |
| `REPEATED_BLOCKS` | the blocked Member | distinct Members who blocked them | **never** |
| `REPEATED_REPORTS` | the reported Member | distinct Members who reported them | **never** |
| `COORDINATED_TARGETING` | the targeted Member | distinct Members requesting them | **never** |

Thresholds and the look-back window are settings. A signal is **one OPEN row per Member and type** (idempotent), holds counts and the rule that fired — **never message content, an IP, a device or a score** (a shared network or device is not proof of abuse and is not collected). Responses: **flag** (default — appears on Admin → Moderation for a person to review, dismiss or mark actioned) or, only when the explicit switch `messaging_abuse_restrict_enabled` (OFF by default) is on and the signal is about the Member's *own sending behaviour*, a **temporary restriction on opening NEW Message Requests** (1–168 hours, schema-capped at 7 days; existing accepted conversations are never affected; a Super Admin can lift it; enforced in the send/share actions with a neutral message). Signals about what *other* Members did (blocks, reports, coordination) can never restrict anyone, so a mass-report cannot silence a Member. Nothing here bans or deletes anyone, and there is no ban action to call. Every signal, restriction, resolution and lift is audited.

## Reporter outcome notifications

When a Super Admin resolves a report the reporter gets one notification (`MESSAGE_REPORT_OUTCOME`, through the existing notification table and center, switchable with `messaging_report_outcome_notifications_enabled`): "We reviewed your report and did not find a violation under the current rules." for a dismissal, or "We reviewed your report and action was taken." otherwise. Nothing else is ever put in it — not the other Member, what was done to them, the moderator's note, any score, or any other reporter — and it has no link.

## Privacy and moderation access

Participants read their own conversations. There is **no** Super Admin UI to browse messages. Super Admin sees reports and their bounded evidence at Admin → Moderation (hide a message, dismiss, mark actioned; each audited, with the report's evidence kept). Raw access exists only at the infrastructure level (anyone holding the database service key), which is outside the product. Message bodies are never logged; audit entries carry ids and actions only.

## Not built (by design)

Group chat, images, video, voice, files, broadcasts, reactions, message editing, search, Stories, Friends/Followers, link previews; any Confidence, Rewards or Rivalry dependency; device / IP signals (none are collected); automatic bans or deletions of any kind; a manual restriction tool (restrictions come only from an approved, switched-on rule). Closed-account and report-outcome handling are done (above); a block does not hide a Member's public comments from anyone but the blocker.
