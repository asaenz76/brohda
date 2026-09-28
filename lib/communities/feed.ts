import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Post } from "@/lib/posts/types";
import type { Community } from "./types";
import { listFollowedCommunityIds } from "./follows";
import { listCommunitiesByIds } from "./repository";
import { listCommunityIdsForPost } from "./distribution";
import { getPostPublicationPolicy } from "@/lib/posts/policy";
import { listActiveMarketsForFixtures } from "@/lib/prediction-markets/repository";
import { selectPrimaryMarket } from "@/lib/posts/primary-market";
import { getSelectionLabel } from "@/lib/prediction-markets/selection-labels";
import { getPickAggregatesForMarkets, listLatestUserPredictionsForMarkets } from "@/lib/predictions/repository";
import { computePickSentiment } from "@/lib/predictions/sentiment";
import { checkMarketEligibility, getPredictionPolicy } from "@/lib/predictions/policy";
import { copyForIneligible } from "@/lib/predictions/copy";
import { classifyFreshness } from "@/lib/prediction-markets/discovery/policy";
import { deriveConsumerStatus } from "@/lib/prediction-markets/discovery/status";
import { getFreshnessPolicy } from "@/lib/prediction-markets/discovery/policy";
import { getPostCommentCountsForPosts } from "@/lib/post-comments/repository";
import type { PredictionOutcome } from "@/lib/predictions/types";

// Milestone R4 (§21-22) established the canonical Post-centric discovery
// queries; Stage 4A (R13.10 remediation of the Stage 4 audit's P0 finding
// — "an ordinary user has no in-app way to discover a Post") replaces
// `getPersonalizedFeed`'s community-fan-out strategy with a genuine
// canonical social feed: EVERY user gets the active sports conversation
// (query published Posts directly, globally), and following a Community
// PERSONALIZES/PRIORITIZES that same result — it is never a prerequisite
// for a non-empty feed (§5 of the remediation brief). Neither function
// below clones a Post — both return the same canonical `posts` rows.

interface PostRow {
  id: string;
  fixture_id: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

function toPost(row: PostRow): Post {
  return { id: row.id, fixtureId: row.fixture_id, publishedAt: row.published_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Fetches published Posts by id, preserving the caller's given order (the order distribution/relevance already determined) and silently dropping any id that turns out unpublished or missing — the same "published-only" boundary lib/posts/repository.ts's getPublishedPostById enforces for a single Post. */
async function hydratePublishedPostsInOrder(postIds: string[]): Promise<Post[]> {
  if (postIds.length === 0) return [];
  const admin = createAdminClient();
  const { data, error } = await admin.from("posts").select("*").in("id", postIds).not("published_at", "is", null);
  if (error) throw error;
  const byId = new Map((data as PostRow[]).map((row) => [row.id, toPost(row)]));
  return postIds.map((id) => byId.get(id)).filter((post): post is Post => post !== undefined);
}

/**
 * "Give me published Posts distributed to Community X" (§21). Ordered by
 * distribution recency, deterministic, no duplicates (post_communities'
 * composite primary key already guarantees a Post appears at most once per
 * Community, so no in-memory dedup is needed here — only the social feed
 * below, which spans every Post regardless of Community, needs that).
 */
export async function getCommunityFeed(communityId: string, limit = 50): Promise<Post[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("post_communities").select("post_id").eq("community_id", communityId).order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return hydratePublishedPostsInOrder((data ?? []).map((row) => row.post_id));
}

// ---------------------------------------------------------------------
// Stage 4A canonical social feed
// ---------------------------------------------------------------------

export interface FeedPolicy {
  /**
   * platform_settings.feed_completed_game_retention_hours — column still
   * exists and remains admin-configurable, but is currently NOT consulted
   * by isFeedEligible below (Stage 4C real-production feedback: "once a
   * game has kicked off it should be off the board" — LIVE/HALFTIME/
   * EXTRA_TIME/PENALTIES/COMPLETED games were all being shown, which is
   * not what was wanted). Left in place rather than dropped via a
   * migration, in case a future milestone reintroduces a "recently
   * finished" view deliberately.
   */
  completedGameRetentionHours: number;
}

const DEFAULT_FEED_POLICY: FeedPolicy = { completedGameRetentionHours: 24 };

/** Fails open to DEFAULT_FEED_POLICY — this only narrows a browse surface's time window, never a write/eligibility gate, so an unreadable settings row should degrade to "show recent content" rather than an empty feed. */
export async function getFeedPolicy(): Promise<FeedPolicy> {
  const admin = createAdminClient();
  const { data } = await admin.from("platform_settings").select("feed_completed_game_retention_hours").eq("id", true).single();
  return { completedGameRetentionHours: data?.feed_completed_game_retention_hours ?? DEFAULT_FEED_POLICY.completedGameRetentionHours };
}

interface FeedFixtureRow {
  internal_status: string;
  scheduled_start_utc: string;
  updated_at: string;
  home_team_name: string;
  away_team_name: string;
  home_team_logo_url: string | null;
  away_team_logo_url: string | null;
  competition_name: string | null;
  home_score: number | null;
  away_score: number | null;
}

interface FeedPostRow extends PostRow {
  fixtures: FeedFixtureRow | null;
}

export interface FeedMarketSummary {
  id: string;
  question: string;
  yesLabel: string;
  noLabel: string;
  /**
   * Phase C (Brohda 2.0 redesign, spec §13-14 "do not fake sentiment") —
   * real Brohda Pick-share sentiment (lib/predictions/sentiment.ts),
   * NEVER provider/bookmaker price. Null exactly when totalPickCount is 0.
   */
  yesPercent: number | null;
  noPercent: number | null;
  totalPickCount: number;
  status: string;
  /** The viewer's own current Pick on this Market, if any — for "you picked X" display on the feed card. */
  viewerSelection: PredictionOutcome | null;
  /**
   * Whether the card should show interactive Pick buttons (true — either
   * no existing Pick, or an existing one still PENDING and unlocked) or a
   * read-only "You picked X" state (false — locked). Mirrors
   * MarketPredictionCard's own isEditable branch (PredictionActions vs
   * YourPredictionCard) for a single Market.
   */
  isEditable: boolean;
  /** Null when the viewer may submit/change a Pick right now; otherwise the consumer-facing reason a feed card's Pick control should show instead of live buttons — either why a NEW pick can't be made (copyForIneligible) or that an existing one is locked. */
  pickDisabledReason: string | null;
}

export interface FeedCommunityRef {
  id: string;
  slug: string;
  type: Community["type"];
  displayName: string;
}

export interface FeedItem {
  post: Post;
  homeTeamName: string;
  awayTeamName: string;
  homeTeamLogoUrl: string | null;
  awayTeamLogoUrl: string | null;
  competitionName: string | null;
  scheduledStartUtc: string;
  internalStatus: string;
  homeScore: number | null;
  awayScore: number | null;
  primaryMarket: FeedMarketSummary | null;
  communities: FeedCommunityRef[];
  /** Ranking metadata (§6 of the remediation brief), not a second copy of the Post — a Post distributed to several followed Communities is still exactly one FeedItem. */
  isFromFollowedCommunity: boolean;
  /** Phase C — non-tombstoned comment count, batched (lib/post-comments/repository.ts's getPostCommentCountsForPosts). */
  commentCount: number;
}

/**
 * "Appropriate current/relevant sports content" (§4), resolved by real
 * Stage 4C production feedback: only a Game that hasn't kicked off yet is
 * "on the board" — once it does (LIVE/HALFTIME/EXTRA_TIME/PENALTIES/
 * COMPLETED alike), it drops out of Discover. This is a technical
 * invariant now (a single, exact status check), not the multi-status/
 * retention-window policy Stage 4A originally shipped. The Post itself is
 * never deleted or made unreachable by this — only the Discover feed's own
 * listing query is affected; a direct link (notification, Community page,
 * shared URL) still opens it.
 */
function isFeedEligible(fixture: FeedFixtureRow | null): boolean {
  if (!fixture) return false;
  return fixture.internal_status === "NOT_STARTED";
}

/** Deterministic sort (§7): followed-Community relevance first, then soonest-kickoff-first, then a stable id tie-breaker. No engagement scoring, no ML. Every candidate is NOT_STARTED (see isFeedEligible), so there is no live/completed distinction left to order by. */
function compareFeedItems(a: FeedItem, b: FeedItem): number {
  if (a.isFromFollowedCommunity !== b.isFromFollowedCommunity) return a.isFromFollowedCommunity ? -1 : 1;

  const timeOrder = new Date(a.scheduledStartUtc).getTime() - new Date(b.scheduledStartUtc).getTime();
  if (timeOrder !== 0) return timeOrder;

  return a.post.id.localeCompare(b.post.id);
}

/**
 * The canonical Brohda social discovery feed (Stage 4A). Every eligible
 * published Post is a candidate — following Communities never gates
 * inclusion, only priority (§5-6). `userId` is optional so the same
 * function serves a hypothetical unauthenticated preview without a second
 * code path; every caller in this codebase today passes a real user id.
 */
export async function getSocialFeed(userId: string | null, limit = 50): Promise<FeedItem[]> {
  const admin = createAdminClient();
  const [followedCommunityIds, publicationPolicy, predictionPolicy, freshnessPolicy] = await Promise.all([
    userId ? listFollowedCommunityIds(userId) : Promise.resolve([]),
    getPostPublicationPolicy(),
    getPredictionPolicy(),
    getFreshnessPolicy(),
  ]);

  // Over-fetch: some published Posts will be filtered out by isFeedEligible
  // (already kicked off, postponed/stale/etc.), so a flat `limit` fetch
  // could under-fill the page. A generous cap (10x, bounded) absorbs that
  // without an unbounded scan — mirrors getPersonalizedFeed's own prior
  // 5x-overfetch precedent.
  const { data, error } = await admin
    .from("posts")
    .select("*, fixtures!inner(internal_status, scheduled_start_utc, updated_at, home_team_name, away_team_name, home_team_logo_url, away_team_logo_url, competition_name, home_score, away_score)")
    .not("published_at", "is", null)
    .order("published_at", { ascending: false })
    .limit(Math.min(limit * 10, 500));
  if (error) throw error;

  const rows = (data as unknown as FeedPostRow[]).filter((row) => isFeedEligible(row.fixtures));

  const postIds = rows.map((r) => r.id);
  const fixtureIds = [...new Set(rows.map((r) => r.fixture_id))];

  const [followedPostIds, activeMarkets, communitiesByPost, commentCounts] = await Promise.all([
    listPostIdsInCommunities(postIds, followedCommunityIds),
    listActiveMarketsForFixtures(fixtureIds),
    listCommunitiesForPosts(postIds),
    getPostCommentCountsForPosts(postIds),
  ]);

  const marketsByFixture = new Map<string, typeof activeMarkets>();
  for (const market of activeMarkets) {
    const bucket = marketsByFixture.get(market.fixtureId) ?? [];
    bucket.push(market);
    marketsByFixture.set(market.fixtureId, bucket);
  }

  // Resolve each row's primary Market up front (one pass, pure/in-memory)
  // so the two remaining batched reads below — Pick aggregates and the
  // viewer's own Picks — can be scoped to exactly the primary-market ids
  // actually needed, one query each, regardless of feed size.
  const primaryByFixture = new Map<string, ReturnType<typeof selectPrimaryMarket>>();
  for (const fixtureId of fixtureIds) {
    primaryByFixture.set(fixtureId, selectPrimaryMarket(marketsByFixture.get(fixtureId) ?? [], publicationPolicy.primaryMarketTemplatePriority));
  }
  const primaryMarketIds = [...primaryByFixture.values()].filter((m): m is NonNullable<typeof m> => m != null).map((m) => m.id);

  const [pickAggregates, viewerPredictions] = await Promise.all([
    getPickAggregatesForMarkets(primaryMarketIds),
    userId ? listLatestUserPredictionsForMarkets(userId, primaryMarketIds) : Promise.resolve(new Map()),
  ]);

  const now = new Date();

  const items: FeedItem[] = rows.map((row) => {
    const primary = primaryByFixture.get(row.fixture_id) ?? null;
    let primaryMarket: FeedMarketSummary | null = null;

    if (primary) {
      const sentiment = computePickSentiment(pickAggregates.get(primary.id));
      const viewerPrediction = viewerPredictions.get(primary.id);

      // Same eligibility decision MarketPredictionCard makes for a single
      // Market (lib/predictions/policy.ts's checkMarketEligibility), just
      // computed in-memory here for every feed item instead of one page
      // load per Market — no extra query, every input is already in scope.
      let pickDisabledReason: string | null = null;
      const isEditable = !viewerPrediction || (viewerPrediction.lockedAt === null && viewerPrediction.lifecycleState === "PENDING");
      if (isEditable) {
        const consumerStatus = deriveConsumerStatus(primary.status, primary.resolvedOutcome);
        const freshness = classifyFreshness(primary.lastSyncedAt, primary.yesPrice != null || primary.noPrice != null, freshnessPolicy);
        const eligibility = checkMarketEligibility(
          { consumerStatus, freshness, yesPrice: primary.yesPrice, noPrice: primary.noPrice, closesAt: primary.closesAt, now },
          predictionPolicy,
        );
        pickDisabledReason = eligibility.eligible ? null : copyForIneligible(eligibility.reason);
      } else {
        // Existing Pick, but locked — same copy PredictionActions itself
        // falls back to for a locked Pick (see that component's own
        // `locked` branch).
        pickDisabledReason = "Picks are locked for this game.";
      }

      primaryMarket = {
        id: primary.id,
        question: primary.question,
        yesLabel: getSelectionLabel(primary, "YES"),
        noLabel: getSelectionLabel(primary, "NO"),
        yesPercent: sentiment.yesPercent,
        noPercent: sentiment.noPercent,
        totalPickCount: sentiment.totalPickCount,
        status: primary.status,
        viewerSelection: viewerPrediction?.selectedOutcome ?? null,
        isEditable,
        pickDisabledReason,
      };
    }

    return {
      post: toPost(row),
      homeTeamName: row.fixtures!.home_team_name,
      awayTeamName: row.fixtures!.away_team_name,
      homeTeamLogoUrl: row.fixtures!.home_team_logo_url,
      awayTeamLogoUrl: row.fixtures!.away_team_logo_url,
      competitionName: row.fixtures!.competition_name,
      scheduledStartUtc: row.fixtures!.scheduled_start_utc,
      internalStatus: row.fixtures!.internal_status,
      homeScore: row.fixtures!.home_score,
      awayScore: row.fixtures!.away_score,
      primaryMarket,
      communities: communitiesByPost.get(row.id) ?? [],
      isFromFollowedCommunity: followedPostIds.has(row.id),
      commentCount: commentCounts.get(row.id) ?? 0,
    };
  });

  items.sort(compareFeedItems);
  return items.slice(0, limit);
}

async function listPostIdsInCommunities(postIds: string[], communityIds: string[]): Promise<Set<string>> {
  if (postIds.length === 0 || communityIds.length === 0) return new Set();
  const admin = createAdminClient();
  const { data, error } = await admin.from("post_communities").select("post_id").in("post_id", postIds).in("community_id", communityIds);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.post_id));
}

/** Batched "which Communities is each of these Posts in" — one post_communities query plus one communities query total, regardless of how many Posts/Communities are involved. */
async function listCommunitiesForPosts(postIds: string[]): Promise<Map<string, FeedCommunityRef[]>> {
  const result = new Map<string, FeedCommunityRef[]>();
  if (postIds.length === 0) return result;

  const admin = createAdminClient();
  const { data, error } = await admin.from("post_communities").select("post_id, community_id").in("post_id", postIds);
  if (error) throw error;

  const communityIds = [...new Set((data ?? []).map((row) => row.community_id))];
  const communities = await listCommunitiesByIds(communityIds);
  const displayNames = await resolveDisplayNames(communities);
  const communityById = new Map(communities.map((c) => [c.id, c]));

  for (const row of data ?? []) {
    const community = communityById.get(row.community_id);
    if (!community) continue;
    const ref: FeedCommunityRef = { id: community.id, slug: community.slug, type: community.type, displayName: displayNames.get(community.id) ?? "Community" };
    const bucket = result.get(row.post_id) ?? [];
    bucket.push(ref);
    result.set(row.post_id, bucket);
  }
  return result;
}

/**
 * Stage 4A remediation (Stage 4 audit §11 — "/post/[id] displays no
 * Community context"): the same Community-ref shape the feed card uses,
 * for a single Post. A canonical Post may belong to several Communities —
 * this deliberately returns all of them rather than picking one "owner",
 * matching the domain rule that Community is affinity/distribution, never
 * ownership (lib/communities/distribution.ts's own header comment).
 */
export async function getCommunityRefsForPost(postId: string): Promise<FeedCommunityRef[]> {
  const communityIds = await listCommunityIdsForPost(postId);
  if (communityIds.length === 0) return [];
  const communities = await listCommunitiesByIds(communityIds);
  const displayNames = await resolveDisplayNames(communities);
  return communities.map((c) => ({ id: c.id, slug: c.slug, type: c.type, displayName: displayNames.get(c.id) ?? "Community" }));
}

/** Batched display-name resolution (two queries total — one for team names, one for league names — instead of lib/communities/presentation.ts's getCommunityDisplayName's one-query-per-Community, which would otherwise re-run per row in a feed-sized list). SPORT Communities already carry their own stored name. */
async function resolveDisplayNames(communities: Community[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const admin = createAdminClient();

  const teamIds = communities.filter((c) => c.type === "TEAM" && c.teamId).map((c) => c.teamId as string);
  const leagueIds = communities.filter((c) => c.type === "LEAGUE" && c.leagueId).map((c) => c.leagueId as string);

  const [teamRows, leagueRows] = await Promise.all([
    teamIds.length > 0 ? admin.from("teams").select("id, name").in("id", teamIds) : Promise.resolve({ data: [], error: null }),
    leagueIds.length > 0 ? admin.from("leagues").select("id, name").in("id", leagueIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const teamNameById = new Map((teamRows.data ?? []).map((r) => [r.id, r.name as string]));
  const leagueNameById = new Map((leagueRows.data ?? []).map((r) => [r.id, r.name as string]));

  for (const community of communities) {
    if (community.type === "SPORT") names.set(community.id, community.displayName ?? community.sportKey ?? "Sport");
    else if (community.type === "TEAM") names.set(community.id, (community.teamId && teamNameById.get(community.teamId)) ?? "Team");
    else if (community.type === "LEAGUE") names.set(community.id, (community.leagueId && leagueNameById.get(community.leagueId)) ?? "League");
  }
  return names;
}
