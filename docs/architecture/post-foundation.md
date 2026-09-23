# Post Foundation (Milestone R3)

**Status**: Implements `docs/BROHDA_2_0_MILESTONE_MAP.md` Milestone R3 in full. Records CURRENT STATE only. See `docs/architecture/game-market-foundation.md` (R1) and `docs/architecture/sports-market-ingestion.md` (R2) for the Game/Market layer this domain sits on top of.

## Purpose

A Post is Brohda's own canonical **social** representation of a Game — the stable destination a user lands on to engage with a Game socially, independent of which specific sportsbook proposition happens to be current. It is never sports truth (`fixtures`), never a gradeable proposition (`markets`), never an opinion (`predictions`).

## Game / Post / Market separation

| | Owns | Driven by | Mutates when |
|---|---|---|---|
| **Game** (`fixtures`) | Sports truth: teams, kickoff, score, status | Provider sync (R2's ingestion cousin, fixture sync) | The real-world game changes |
| **Post** (`posts`) | Social/publication state: existence, visibility | Brohda's own publication policy | An operator/policy decides to publish |
| **Market** (`markets`) | One gradeable proposition | R2 ingestion | A genuinely new proposition appears (never in place) |

A Post references exactly one Game (`fixture_id`, real FK, unique) and never duplicates Game or Market data — team names, kickoff time, and score are read live from `fixtures` on every request; current Markets are read live from `markets` by fixture, never copied onto the Post row.

## Canonical Post invariant

`posts.fixture_id` is both a real foreign key (fixtures are verified never deleted — same reasoning as R1's `markets.fixture_id`) and `UNIQUE`, which is what makes "one canonical Post per Game" a database guarantee, not an application convention. A `before update` trigger (`posts_forbid_fixture_reassignment`) additionally makes a Post's Game association immutable once set, mirroring R1's `markets_forbid_identity_mutation` — defense in depth on top of the fact that no application code path ever attempts such a reassignment.

## Existence vs. publication

`posts.published_at` is a nullable timestamp, not a status enum: null means the Post row exists (created, perhaps by policy that decided not to show it yet) but is not publicly visible; non-null is the moment it became visible. This mirrors `predictions.graded_at`'s own established "nullable timestamp doubles as state + history" pattern. No `HIDDEN`/`ARCHIVED` state exists yet — there is no moderation or comment surface in R3 to hide content from, and the milestone explicitly warns against inventing archival behavior. A completed or cancelled Game's Post simply stays published forever; presentation reads the Game's own current status for that context (e.g. "This game was cancelled").

## Creation and publication (two separate operations)

- `ensurePostForFixture(fixtureId)` (`lib/posts/repository.ts`) — idempotent get-or-create. The DB's own unique constraint is the real concurrency guarantee; a `23505` conflict is caught and resolved to a plain select, matching the same idiom this codebase's `create_pool_entry` migration already documents for exactly this situation.
- `publishPost(id)` — sets `published_at` only if still null; calling it again is a no-op, never resetting the timestamp.

**Automatic publication** (`lib/posts/publication.ts`'s `runPostPublication`) is a job deliberately separate from R2's Market ingestion job — "sports ingestion produces sports truth; Post publication decides social publication" (the milestone's own framing). Neither job calls into the other; an operator composes them by running both, in either order. For each eligible upcoming `api_nfl` fixture: ensure a Post exists, then publish it only if `platform_settings.post_publication_requires_active_market` is satisfied (at least one currently-`ACTIVE` Market exists) — otherwise the Post exists but stays unpublished until a later run finds a Market. Exposed identically to R2's job: a callable function, a bearer-secret cron route (`app/api/cron/publish-posts/route.ts`), and a manual script (`pnpm publish-posts`) — no parallel logic, no dedicated admin dashboard (a script with the existing production-write-guard is judged sufficient operator control, matching R2's own accepted precedent).

## Primary Market selection

No stored `primary_market_id`. `selectPrimaryMarket` (`lib/posts/primary-market.ts`) is a pure function: given the Game's currently-`ACTIVE` Markets and a configurable ordered template list (`platform_settings.post_primary_market_template_priority`, default `{MONEYLINE, TOTAL, SPREAD}`), it returns the first Active market whose template appears earliest in that list. Recomputed on every read — this is exactly what makes "the primary Market can change without the Post's identity changing" true by construction rather than something that needs migrating: a line moving (R2 deactivating the old TOTAL row and activating a new one) simply changes what this function returns on the next read, with zero write to `posts` itself.

## Multiple Markets, zero Markets

A Post's detail surface queries `listActiveMarketsForFixture` (all currently-Active Markets for the Game, any template) — never assumes exactly one, never assumes all three templates exist (SPREAD remains unavailable per R2's own documented limitation). A Game with zero Active Markets is handled explicitly and safely: the Post still exists and renders ("No markets are available for this game yet."), it just has no interactive Pick surface until a Market appears.

## Existing Pick compatibility

Unchanged: a Pick (`predictions`) still references a Market's `id`, never a Post's. The Post detail page reuses `MarketPredictionCard` (extracted, byte-for-byte unchanged, from the Market detail page's own prior implementation) to present the primary Market's full interactive Pick flow — proving "Post provides context, Market defines the question, Pick answers the Market" end-to-end without introducing any new Pick storage or logic.

## Feed

**Finding**: `/feed` (`app/(app)/feed/page.tsx`) is entirely the **legacy pool product's** feed (pool cards, tier groups, a pool-participation "stories" row) — it has no relationship whatsoever to `markets`/`predictions`/Posts. The Prediction Network's actual discovery surface is `/markets` (`app/(app)/markets/page.tsx`, `getDiscoveryFeed`). This is worth recording explicitly: the task's own framing of "the existing feed" maps in intent to `/markets`, not literally to the route named `/feed`, which remains untouched (legacy pools are out of scope for every R0.5+ milestone).

**Change made**: none to `/markets`'s own rendering. Post is architecturally ready to become `/markets`'s canonical feed object (list Posts, not raw Markets), but actually migrating that page's rendering is a genuine UI-layer redesign — this milestone is explicitly architectural, not a frontend rewrite, and nothing about Post's existence breaks or contradicts `/markets`'s current Market-card rendering. This migration is recorded here as deferred future work, not silently skipped.

**Canonical feed object after R3**: still `MarketRecord` on `/markets`; `Post` on the new, minimal `/post/[id]` detail route that proves the architecture. No Community distribution was introduced.

## Post detail surface

Route: `app/(app)/post/[id]/page.tsx`. Presents: the Game (team names, competition, kickoff via the existing `LocalDateTime` component, live status/score read fresh from `fixtures`), the primary Market with full Pick interaction (`MarketPredictionCard`), and a plain list of links to any other currently-Active Markets for the same Game (routing to their own `/markets/[id]` pages rather than duplicating their interactive state). An unpublished or nonexistent Post renders the same honest not-found state as the Market detail page. No Comments, Community badges, Challenge controls, or monetary controls exist on this page.

**Live-verified** (2026-09-21, local Supabase, manual browser check — not part of the automated suite): seeded a real fixture with a MONEYLINE and a TOTAL Market and a published Post, logged in as a real test user, confirmed the page renders both Markets, submitted a real YES Pick through the reused component, confirmed it persisted and displayed correctly on reload, and confirmed the "more markets" link correctly reaches the unmodified `/markets/[id]` page. Test data was fully cleaned up afterward.

## Security

`posts` has zero INSERT/UPDATE/DELETE grant to `anon`/`authenticated` — identical posture to `markets`/`predictions`. Every write goes through the service-role admin client via `lib/posts/repository.ts`, matching this codebase's established convention (RLS restricts reads only; a Server Action's/job's own authorization, not an RLS write policy, gates mutation). `authenticated` may only `SELECT` rows where `published_at is not null`. No new RPC was introduced — plain service-role table access was judged sufficient for a domain this simple, matching R1/R2's own reasoning (and this codebase's specific documented history of RPC-grant-drift incidents motivating "skip RPCs when a table's writes are this simple").

## Configuration ownership

| Concern | Owner | Classification |
|---|---|---|
| Post represents one canonical Game; uniqueness; immutable Game association | Schema (DB constraint + trigger) | TRUE INVARIANT |
| Users cannot create canonical Posts | RLS/grants | TRUE INVARIANT |
| Market line/price movement never creates a new Post | Architecture (Post never references a Market) | TRUE INVARIANT |
| Automatic publication master switch | `platform_settings.post_publication_enabled` | CONFIGURABLE PRODUCT POLICY |
| Whether an active Market is required before auto-publishing | `platform_settings.post_publication_requires_active_market` | CONFIGURABLE PRODUCT POLICY |
| Primary-Market template preference | `platform_settings.post_primary_market_template_priority` | CONFIGURABLE PRODUCT/OPERATIONAL POLICY |
| Eligible sport/provider for automatic publication | Hard-coded (`api_nfl`) | Same genuine current-technical-scope limitation as R2 — only one sport/provider exists |

## Future Community distribution (R4) — kept possible, not implemented

No `community_id` (or any singular-ownership shortcut) was added to `posts`. The eventual `Post ↔ Community` relationship is many-to-many by the milestone map's own design (a Post must be reachable from the Giants community, the Rams community, the NFL community, and the public feed, without four copies) — R3 deliberately leaves `posts` with no foreign key toward any future Community concept at all, so that a join table (`post_communities` or equivalent) can be introduced in R4 purely additively.

## Future Comments (R6) — kept possible, not implemented

`posts.id` is a stable, permanent UUID suitable as a future `comments.post_id` target. No comment table, count, or UI was introduced in R3.

## Future Challenges (R7) / Money (R8-R10) — explicitly not on Post

No Challenge field, stake, wallet reference, or monetary state exists on `posts`. The hierarchy remains Post → Market → Pick → Challenge → Monetary Position; Challenges will attach to opposing Picks on a Market, never to a Post directly.
