# Social Discovery Feed (Milestone R13.10, Stage 4A)

**Status**: Implements the Stage 4A remediation brief in full. Records CURRENT STATE only. See `docs/architecture/post-foundation.md` (Post identity), `community-distribution.md` (Community/distribution), and `pick-editing-and-locking.md` (Pick eligibility, unaffected by this work).

## Why this exists

The Stage 4 pre-exposure audit (R13.10) found a P0 launch blocker: once `social_prediction_enabled` is flipped on, an ordinary user has authenticated access to `/markets`, `/post/[id]`, `/community/[slug]`, etc. but **no in-app way to ever reach any of them** — no feed, no Community index, no search coverage. This document records the fix.

## Route and legacy-collision decision

The canonical feed is served at the existing `/markets` route (component: `app/(app)/markets/page.tsx`), retaining its existing nav slot (`MobileBottomNavigation`'s "Discover" tab, formerly labeled "Markets") rather than adding a new route. Two things made this the smallest coherent change, not a guess:

1. **No collision with the legacy money-pools product.** `/feed` (the legacy pools feed) is completely untouched — this route is a different one, already gated by `requireSocialPredictionAccess()`, and only becomes reachable per-user once that policy is enabled for them.
2. **No collision with real production traffic.** `/markets` previously rendered Milestone 2's own Market-only browse engine (`getDiscoveryFeed`, `discovery_categories`, category tabs) — but that engine was never reachable by an ordinary user in production (same gate, `social_prediction_enabled` has been `false` since it shipped). Evolving its content therefore breaks nothing live. That engine (`lib/prediction-markets/discovery/repository.ts`, the `discovery_categories`/`discovery_category_provider_mappings`/`discovery_sort_policy` tables, and their admin CRUD) is **not deleted** — it's simply no longer this route's data source, and remains reachable as a deep link at `/markets/[id]` (Market detail, unchanged) and covered by its own existing tests (`tests/integration/discovery-categories.test.ts`).

## Feed architecture

`lib/communities/feed.ts`'s `getSocialFeed(userId, limit)` replaces the prior `getPersonalizedFeed` (which required at least one Community follow and returned `[]` otherwise — exactly the defect this milestone fixes). The query strategy inverts the old one:

- **Old**: start from the user's followed Community ids, fan out to `post_communities`, hydrate Posts. A zero-follow user had no starting point, hence `[]`.
- **New**: start from every eligible published Post, globally — a Community follow is never a prerequisite. Followed-Community membership is looked up separately, purely as ranking metadata (`isFromFollowedCommunity`).

**Eligibility** (`isFeedEligible`): a technical invariant (fixed set of "this game is live/ongoing" fixture statuses — `NOT_STARTED`/`LIVE`/`HALFTIME`/`EXTRA_TIME`/`PENALTIES`, always eligible) combined with one piece of mutable product policy (`platform_settings.feed_completed_game_retention_hours`, default 24 — how long a `COMPLETED` game's Post stays visible). `POSTPONED`/`SUSPENDED`/`ABANDONED`/`CANCELLED`/`AWARDED`/`UNKNOWN` are never feed-eligible — the same non-standard statuses the R5 Pick-eligibility decision (see `pick-editing-and-locking.md`) treats as "uncertain, not a normal live game."

**Ordering** (`compareFeedItems`), deterministic, no ML, no engagement scoring: (1) followed-Community relevance first, (2) soonest-kickoff-first for live/upcoming games or most-recently-finished-first for completed ones, (3) Post id as a stable tie-breaker.

**Deduplication**: a Post distributed to several Communities the user follows appears exactly once — the feed query selects distinct `posts` rows directly (never fans out per-Community), and `isFromFollowedCommunity` / the `communities` list are metadata attached to that one row, never a reason to duplicate it.

**Community badges**: `getCommunityRefsForPost`/`listCommunitiesForPosts` batch-resolve every Post's Communities in (at most) three queries total regardless of feed size — never one query per Post or per Community.

## What did NOT change

- Pick eligibility/locking/grading (`set_pick`, `runGradingJob`) — entirely unaffected by this milestone; the feed is a read-only discovery surface.
- `call_bs_enabled`/`monetary_p2p_enabled` — both remain `false`; no Call BS or monetary UI is reachable from the feed (verified — `MarketParticipants`'s money/challenge actions are gated by those flags server-side, independent of feed/route changes).
- `social_prediction_enabled` — remains `false` through this entire milestone; this document describes what becomes reachable once a future, separately-authorized activation flips it, not anything live today.
