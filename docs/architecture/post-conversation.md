# Post Conversation (Milestone R6)

**Status**: Implements `docs/BROHDA_2_0_MILESTONE_MAP.md` Milestone R6 in full. Records CURRENT STATE only. See `docs/architecture/post-foundation.md` (R3) for the canonical Post layer this domain attaches to, `docs/architecture/community-distribution.md` (R4) for the distribution layer this domain deliberately stays independent of, and `docs/architecture/pick-editing-and-locking.md` (R5) for the Pick layer this domain is also independent of.

## What this is

A canonical, shared Comment (+ one-level Reply) layer attached to the Post, not to any Community a user discovers it through, not to a Market, and not to a Pick. Brohda's interaction hierarchy is "Pick a side / Talk shit / Call BS / Put your money where your mouth is" — Comments implement "Talk shit." `talk_shit` is product copy, not a schema name; the domain object is `Comment`.

## Canonical ownership

`post_comments.post_id` (real, non-cascading FK → `posts.id`) is the *only* ownership relationship a Comment has. A reply's `parent_comment_id` references another Comment, and `add_post_comment()` enforces that the parent belongs to the *same* `post_id` — a cross-Post parent reference is structurally rejected (`parent_not_found`), not merely discouraged. No `community_id`, `market_id`, or `pick_id` column exists on `post_comments` at all — verified directly (`tests/integration/post-conversation.test.ts`'s "post_comments never stores a community_id" test inspects the live row's own columns, not just the TypeScript type).

## Threading model

One level of nesting only — a top-level Comment (`parent_comment_id is null`) may have replies, but a reply cannot itself be replied to (`nesting_too_deep`). This mirrors `pool_comments`' own proven nesting rule exactly (same rule, same rejection shape) rather than inventing arbitrary-depth threading Brohda's current product surface doesn't need.

## Shared Community conversation (the core invariant)

A Post distributed to multiple Communities (R4's `post_communities`) has **exactly one** `post_comments` row set, keyed only by `post_id`. Nothing in `lib/post-comments/` reads or writes `post_communities`, `communities`, or any community-scoped table — verified by inspection (no such reference exists in the R6 code) and by a direct integration test: a Post distributed to a Team (Giants), a Team (Rams), a League (NFL), and the fixture's Sport community all resolve to the *same* `getPostConversation(postId)` result, and `post_comments` has exactly one row for that `post_id` regardless of how many Communities the Post reaches. `community_id` is deliberately never stored on Comment, even though a future analytics "which Community did this comment happen in" concept is plausible — that is out of scope, and storing it now would risk the exact fragmentation this milestone was told to prevent.

## Comment lifecycle: soft-delete, not hard-delete

This is the one deliberate, load-bearing divergence from `pool_comments`' own precedent. `delete_pool_comment` hard-deletes with `on delete cascade` to replies — verified directly by reading its migrations and by a smoke test showing an entire reply thread disappears when its root is removed. R6's own task text repeatedly warned against exactly that ("do NOT cascade-delete an entire conversation... unless that is explicitly intended product behavior"), so `remove_post_comment()` instead sets `post_comments.deleted_at` and leaves the row (`id`, `post_id`, `parent_comment_id`, `user_id`, `created_at`) intact — only `body`'s *presentation* changes, to `"[comment deleted]"` (`components/posts/PostConversation.tsx`), while the real `body` stays in the database for moderation/audit purposes. A reply beneath a removed comment remains fully valid, visible, and repliable-to (verified: a new reply can still be added to an already-tombstoned parent). No cascade removes a reply when its parent is removed — verified directly.

**Editing** was not implemented. Nothing in this milestone's task made it a requirement ("not automatic just because social networks have it"), and the simpler of the two offered models — immutable-plus-delete-only — was chosen: no `edited_at` column, no edit RPC, no edit UI. Deleting and re-posting is the only way to change a Comment's text.

## Eligibility

A Comment may be created or read only when its Post is published (`posts.published_at is not null`) — enforced both in the RLS `select` policy and, independently, inside `add_post_comment()` itself (since that RPC runs as `service_role` and bypasses RLS). No other condition gates eligibility: **Game status is never consulted.** `add_post_comment()` and the RLS policy check `posts.published_at` only — a Comment can be created and read while the Game is `LIVE`, `COMPLETED`, `POSTPONED`, `SUSPENDED`, `ABANDONED`, `CANCELLED`, or `AWARDED`, verified directly for every one of those statuses. This is the opposite default from R5's Pick eligibility (which requires `NOT_STARTED`) — deliberately: sports conversation is often *more* valuable during and after a Game, and R6 was explicitly told not to copy R5's conservative Pick-status rule into Comments just because it was the most recent precedent.

## Market and Pick independence

Comment creation and visibility do not consult `markets` or `predictions` at all. A Market's price/line moving, a Pick being created, edited, or permanently locked (`rejected_locked`) — none of it touches `post_comments` or is touched by it; verified directly, including a locked-Pick scenario (a Pick `set_pick` rejects as `rejected_locked` on the same Post where a Comment is created successfully immediately after). Comments do not lock at T-10 cutoff, T-5 Market lock, or kickoff.

## Comment count

`getPostCommentCount(postId)` (`lib/post-comments/repository.ts`) is computed live — `count(*) where post_id = $1 and deleted_at is null` — never a denormalized counter column, unlike `pools.comment_count`. This is the second deliberate divergence from the `pool_comments` pattern: R6's own instruction preferred deriving state correctly over caching it, and nothing about Post-conversation volume demonstrates the kind of performance need that would justify a cache that can drift. **Semantics**: top-level and reply rows both count; a removed (tombstoned) Comment does *not* count, but a live reply beneath a removed parent still does (verified directly) — "how many things can I currently read" is the definition, not "how many things were ever created."

## Notifications

Exactly one notification event exists: a reply notifies the parent Comment's author (`POST_COMMENT_REPLY`, `lib/notifications/post-comments.ts`). No "someone commented on a Post you participated in" broadcast exists — commenting does not notify every other participant, only a direct reply notifies its direct parent's author. Self-replies are suppressed (`parentCommentUserId === replierUserId` short-circuits before any insert — verified). The recipient is always derived server-side by re-reading the parent Comment's stored `user_id` (`lib/actions/post-comments.ts`) — never accepted from the client — and the notification carries a real, non-cascading `notifications.post_id → posts(id)` FK (added by this milestone's migration, mirroring `notifications.pool_id`'s own existing convention exactly), so it always resolves to the canonical Post, never a Community copy.

## Rate limiting

Reuses the existing generic primitive (`lib/rate-limit/check.ts` → `check_and_increment_rate_limit`), namespaced `post_comment:${userId}` — no second rate-limiting mechanism was invented. Unlike `lib/rate-limit/comments.ts` (hard-coded `60s` / `10` attempts for pool comments), the post-comment window and cap are configurable (`platform_settings.post_comment_rate_limit_window_seconds` / `post_comment_rate_limit_max_attempts`, both read live on every call by `lib/rate-limit/post-comments.ts`) — deliberately *not* retrofitted onto the legacy pool limiter, only done this way for the new domain, per this milestone's own instruction.

## Moderation

Minimum viable integrity, reusing the exact authorization shape `delete_pool_comment` already established: a normal user may remove their own Comment; `is_admin_or_above()` (the same role-check helper, not a new capability-policy entry) additionally lets platform staff remove anyone's. No Community-moderator role, no moderator hierarchy, no automated/AI moderation, no strikes or appeals system was introduced — Communities remain affinity/distribution objects, not user-owned moderated spaces; moderation authority stays platform-level, matching R4's own explicit position.

## Reactions/likes: not implemented

Audited and deliberately not built. The roadmap names this milestone "Post Conversation," not "Post Engagement," and Brohda's own interaction hierarchy treats "Talk shit" (Comments) as required while a generic reaction/like is not part of it — Call BS (R7) is the intended structured-disagreement primitive, not a thumbs-up. `pool_likes` was read for precedent but not copied. No `post_comment_likes` table, RPC, or UI exists.

## UI

`components/posts/PostConversation.tsx`, mounted inline on `app/(app)/post/[id]/page.tsx` below the existing Game/Markets content — the same page, not a redesign. Composer, top-level list, one level of inline replies, delete affordance for the caller's own Comments (and any Comment, for a moderator). No mention engine, no rich text, no media, no polls. Community pages (`app/(app)/community/[slug]/page.tsx`) were not touched by this milestone — they still show at most a Post card, never an embedded conversation thread — and `/markets` was not touched either. Legacy `/feed` and `pool_comments`/`CommentSheet.tsx` are untouched and remain fully separate.

## Security

| Concern | Enforcement |
|---|---|
| Create own Comment/Reply | `add_post_comment`, `service_role`-only execute grant; called via `lib/actions/post-comments.ts`'s `requireUser()`-scoped Server Action, author always server-derived |
| Read a Post's conversation | RLS `select` (published Posts only) to `authenticated`; `getPostConversation()`'s own service-role query re-asserts the same publication check independently |
| Remove another user's Comment | `remove_post_comment` rejects (`not_authorized`) unless caller is the author or `is_admin_or_above()` |
| Change author/Post/parent after creation | No `authenticated` UPDATE grant on `post_comments` at all; verified directly that a direct client `update` attempt on `post_id`/`user_id` is rejected and the row is unchanged |
| Set moderation/deletion state directly | Same — no `authenticated` UPDATE grant; only `remove_post_comment` (service-role RPC) can set `deleted_at` |
| Call `add_post_comment`/`remove_post_comment` directly | Revoked from `public`/`anon`/`authenticated`; granted to `service_role` only — verified directly for both functions |
| Forge a notification recipient | Recipient is always re-read server-side from the parent Comment's stored `user_id`, never accepted from the client |

`post_comments` was added to `tests/integration/table-privilege-hygiene.test.ts`'s `REPRESENTATIVE_TABLES`.

## Pagination

`getPostConversation(postId, limit = 100)`: top-level Comments are fetched bounded and ordered ascending by `created_at` (oldest first — no algorithmic ranking, no "Top comments"), then every reply whose parent is in that returned page is fetched in one second query, then one batched author lookup. Never an unbounded query. Verified directly: a page never returns duplicate top-level Comments, and replies stay correctly associated with their own top-level Comment even when the top-level page is smaller than the full Comment set.

## Configuration ownership

| Concern | Owner | Classification |
|---|---|---|
| Comment belongs to one Post; reply's parent belongs to the same Post; author/Post/parent immutable; Community distribution never duplicates conversation; a user cannot mutate another user's Comment; moderation authority is privileged | Schema (constraints/RLS/grants) | TRUE INVARIANT |
| Comment max length (product-enforced) | `platform_settings.post_comment_max_length` (default 500), read live in `add_post_comment()` | CONFIGURABLE PRODUCT POLICY |
| Comment body hard technical ceiling (2000 chars) | `post_comments.body` CHECK constraint | TRUE INVARIANT (defense in depth beneath the configurable policy above) |
| Rate-limit window/attempt cap | `platform_settings.post_comment_rate_limit_window_seconds` / `post_comment_rate_limit_max_attempts`, read live | CONFIGURABLE OPERATIONAL POLICY |
| Comment/Reply feature enablement | Not built — no kill switch exists; out of this milestone's demonstrated need | — |
| Comment text, deletion state, timestamps | Row state | USER/OBJECT STATE |
| Post publication state | `posts.published_at` (R3) | USER/OBJECT STATE (upstream domain) |

## Legacy pool separation

`pool_comments`, `pool_likes`, `lib/actions/comments.ts`, `lib/rate-limit/comments.ts`, `CommentSheet.tsx`, and every pool-comment migration are completely untouched by this milestone. No pool comment was migrated into `post_comments`, and no code path reads across the two tables. They remain two structurally independent domains that happen to share a proven pattern, not a shared implementation.

## Open decisions

None newly introduced by this milestone. R5's two carried-forward open decisions (postponed-but-rescheduled Pick eligibility; `SUSPENDED`/`ABANDONED`/`AWARDED` grading policy) remain exactly as R5 left them — R6 does not touch Pick eligibility at all, and deliberately does not let Comment eligibility inherit or reinforce R5's conservative Pick-status rule; the two domains' eligibility rules are intentionally different (Post-publication-only vs. Game-status-gated) and R6 does not make R5's rule more permanent by echoing it.
