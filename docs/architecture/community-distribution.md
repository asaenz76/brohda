# Community + Post Distribution (Milestone R4)

**Status**: Implements `docs/BROHDA_2_0_MILESTONE_MAP.md` Milestone R4 in full. Records CURRENT STATE only. See `docs/architecture/post-foundation.md` (R3) for the Post layer this domain distributes.

## Purpose

A Community is an affinity/distribution object — it answers "which sports audience is this Post relevant to?" (a team, a league, a sport). It never owns a Post, never duplicates Post/Market/Pick state, and is not a discussion group, chat, or user-generated space.

## Community identity

`communities` references canonical internal sports identity — `teams.id` / `leagues.id` (both already exist, real UUIDs, `(provider, external_id)`-unique, auto-populated alongside every fixture sync) — rather than duplicating mutable display text. A renamed team (`teams.name` changes) never creates a duplicate Community: identity is `team_id`, immutable, enforced by both a unique index (`communities_subject_unique`, the same coalesce-nulls pattern as R1's `markets_sports_proposition_unique`) and a `before update` trigger (`forbid_community_subject_mutation`) preventing any rebind.

**Reported limitation**: no canonical `sports` relational entity exists anywhere in this codebase — `fixtures.sport` is a plain text column (verified values: `'football'`/retired `api_football`, `'american_football'`/current `api_nfl`). SPORT-type Communities therefore use a plain `sport_key` text identity instead of a foreign key. This is not a taxonomy invented for R4; it's the smallest safe representation of what actually exists, explicitly flagged rather than fixed by a speculative rewrite.

**Presentation**: TEAM/LEAGUE Communities never store their own name — `getCommunityDisplayName` joins live to `teams`/`leagues` on every read. Only SPORT stores a `display_name`, because nothing else can supply one.

## How Community following differs from everything else that looks similar

| | What it is | Who can see it | Effect |
|---|---|---|---|
| `follows` | User → User social graph | Owner + followee counts | Unrelated to Communities entirely — untouched by R4 |
| `team_follows` / `league_follows` | **Private notification preference** ("email me about this team") | Owner only | R0.5's own finding, **not reinterpreted** — still exactly what it was |
| `community_follows` (new) | Personalization/discovery signal ("show me this Community's Posts") | Owner only (RLS) | Feeds `getPersonalizedFeed`; carries **no** notification behavior |
| Declared fandom | Not implemented | — | Explicitly **not** created in R4 (§10) — following a Community is not a public "I am a fan" statement |
| `discovery_categories` | Admin-managed tag/filter list for `/markets` | Public (read), admin (write) | A different, pre-existing domain — coexists with Communities, not merged into them |

Following a Community and enabling notifications for a team are two independent user choices; R4 introduces no bridge between them.

## Post ↔ Community distribution

`post_communities` is a plain many-to-many join — no ownership direction, `(post_id, community_id)` as the composite primary key (the uniqueness enforcement itself: the same Post can never distribute into the same Community twice). A canonical Post is never copied — every Community that lists it points at the exact same `posts.id`, `markets` rows, and (once they exist) Picks/Comments/Challenges.

**Derivation** (`distributePostForFixture`): resolves a Post's Game to its home team, away team, league/competition, and sport via the fixture's own `(provider, external_id)` relationships to `teams`/`leagues` — never display-text or fuzzy matching. Each of the four targets is independently gated by policy and independently best-effort: an unresolvable team/league (a best-effort external id that was never populated) is skipped and recorded, never blocks the others.

**Idempotency and concurrency**: `ensureTeamCommunity`/`ensureLeagueCommunity`/`ensureSportCommunity` follow the exact get-or-create-with-23505-fallback idiom already established by `ensurePostForFixture` (R3); `distributePostToCommunity` does the same for the join row. Verified directly: three concurrent `distributePostForFixture` calls for the same Post produce exactly the same relation set as one call.

**Reconciliation/backfill** (`runCommunityDistribution`): examines every currently-*published* Post, not just newly-published ones — this is what makes it a genuine backfill mechanism as well as the ongoing distribution job. A Post published before its Community existed, or before this job ever ran, is picked up correctly on the next run. Exposed identically to R2/R3's own job pattern: a callable function, a bearer-secret cron route (`app/api/cron/distribute-posts/route.ts`), and a manual script (`pnpm distribute-posts`) — no scheduler wiring, no dedicated admin dashboard, matching the accepted R2/R3 precedent.

## Independence from Market/Game changes

Distribution is derived purely from the fixture's team/league/sport identity — never from anything Market-related. Verified directly: a Market price update, a TOTAL line move (R2's own deactivate-old/insert-new behavior), a Game score update, a kickoff-time change, and a Game cancellation all leave a Post's Community relations completely unchanged. Cancellation does not delete the Post or its distribution — matching R3's own "durable social history" principle.

## Community feed and personalized discovery

- `getCommunityFeed(communityId)`: published Posts distributed to one Community, ordered by distribution recency. No in-memory dedup needed — the composite primary key already guarantees a Post appears at most once per Community.
- `getPersonalizedFeed(userId)`: published Posts across every Community the user follows, **deduplicated** — a Post distributed to two followed Communities appears exactly once (first-seen-wins over the recency-ordered relation stream), verified directly with a two-Community-membership scenario. No ranking algorithm — deterministic recency order only, matching the milestone's own "data model and query capability, not an algorithmic feed" instruction.

Both queries enforce "published only" as an explicit application-level filter (`hydratePublishedPostsInOrder`), mirroring `getPublishedPostById`'s own convention — an unpublished Post distributed to a Community (a real, tested scenario: distribution and publication are independent operations) never leaks through either feed.

## Global/public visibility vs. Community distribution

No `GLOBAL` Community was created. Public/global visibility is exactly what R3 already established: a *published* Post (`published_at is not null`), full stop — a separate concern from which Communities that same Post happens to also be distributed into. A Post can be globally visible (via `/post/[id]`) and simultaneously distributed to zero, one, or several Communities.

## `/feed` and `/markets`

Unchanged. `/feed` remains the legacy pool product's own feed (R3's finding, reconfirmed, not touched). `/markets` remains the Prediction Network's existing Market-card discovery surface, also unchanged — R4 proves Post-centric, Community-filtered discovery via the query layer (`getCommunityFeed`/`getPersonalizedFeed`) and the new `/community/[slug]` surface, without redesigning either existing route.

## Community detail surface

Route: `app/(app)/community/[slug]/page.tsx`. Presents Community identity (type + live-derived display name), a follow/unfollow control (`CommunityFollowButton` → `lib/actions/communities.ts`'s Server Actions, each scoped to the caller's own id via `requireUser()` — a user can never modify another user's follow), and the Community's distributed Posts (each linking to its one canonical `/post/[id]` — entering through a Community never creates or routes to a copy). No Comments, no chat, no user-created Posts, no moderators, no roles.

## Community-specific Pick sentiment — explicitly not built

R4 does not compute "78% of Giants Community picked Giants" or any similar statistic. Per the milestone's own instruction, doing so requires a defensible definition of Community *population* (who counts as "belonging to" a Community), and a follow relationship is only one candidate signal among several possible future ones (declared fandom being another, not implemented). The data model — `community_follows` as one clean, independently-queryable signal — is deliberately left in a shape that makes this computation possible later without any schema change, but nothing here fabricates the statistic from an ambiguous population definition today.

## Security

| Table | Client write | Client read | Write path |
|---|---|---|---|
| `communities` | None (`service_role` only) | `authenticated`, all rows | `lib/communities/repository.ts` |
| `post_communities` | None | None (no direct grant) | `lib/communities/distribution.ts` |
| `community_follows` | None | `authenticated`, own rows only | `lib/actions/communities.ts` (Server Actions, `requireUser()`-scoped) |

No new RPC was introduced — plain service-role table access, matching R1/R2/R3's own reasoning (and this codebase's documented history of RPC-grant-drift incidents motivating "skip RPCs when a table's writes are this simple"). All three new tables were added to `table-privilege-hygiene.test.ts`'s `REPRESENTATIVE_TABLES`.

## Configuration ownership

| Concern | Owner | Classification |
|---|---|---|
| One Community per canonical sports subject; immutable subject; distribution never duplicates a Post; normal users cannot create Communities or distribute Posts; a user can modify only their own follow | Schema (constraints/triggers) + RLS/grants | TRUE INVARIANT |
| Automatic distribution master switch | `platform_settings.community_distribution_enabled` | CONFIGURABLE PRODUCT POLICY |
| Per-type (team/league/sport) distribution enablement | `platform_settings.community_{team,league,sport}_distribution_enabled` | CONFIGURABLE PRODUCT POLICY |
| A Community's own active/inactive state | `communities.active` (object state, not global policy) | USER/OBJECT STATE |
| Eligible sport/provider for distribution | Hard-coded (`api_nfl`) | Same genuine current-technical-scope limitation as R2/R3 |

## Future readiness

`comments.post_id`/`challenges` can attach to the same canonical `posts.id` unaffected by anything in R4. Pick editing (R5) is untouched — Picks remain Market-scoped. No wallet, reservation, or monetary concept was introduced.
