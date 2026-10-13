import { errorMessage } from "@/lib/utils/error-message";
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureLeagueCommunity, ensureSportCommunity, ensureTeamCommunity } from "./repository";
import { resolveFixtureSportsEntities } from "./fixture-resolution";
import { getCommunityDistributionPolicy } from "./policy";
import type { CommunityDistributionPolicy } from "./types";
import { activeSportConfigs, getSportLabel } from "@/lib/sports-data/sport-registry";
import { fetchAllRows, fetchInChunks } from "@/lib/utils/batch";

// Milestone R4 (docs/BROHDA_2_0_MILESTONE_MAP.md, §13-17): the canonical
// many-to-many Post <-> Community distribution. Never copies a Post —
// every "distribution" is one row in `post_communities` referencing the
// same, single, canonical Post id.

export type DistributePostToCommunityOutcome = "created" | "existing";

/** Idempotent (§17): a unique_violation on the composite PK means this exact (post, community) pair already exists — a safe no-op, not an error. */
export async function distributePostToCommunity(postId: string, communityId: string): Promise<DistributePostToCommunityOutcome> {
  const admin = createAdminClient();
  // ON CONFLICT DO NOTHING rather than insert-and-catch-23505: the reconciliation re-asserts links that already exist, and a duplicate-key error is
  // logged by Postgres every time it happens. An already-existing pair comes back as zero inserted rows.
  const { data, error } = await admin
    .from("post_communities")
    .upsert({ post_id: postId, community_id: communityId }, { onConflict: "post_id,community_id", ignoreDuplicates: true })
    .select("post_id");
  if (error) throw error;
  return (data ?? []).length > 0 ? "created" : "existing";
}

export async function listCommunityIdsForPost(postId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("post_communities").select("community_id").eq("post_id", postId);
  if (error) throw error;
  return (data ?? []).map((row) => row.community_id);
}

function humanizeSportKey(sportKey: string): string {
  return sportKey
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export interface FixtureDistributionOutcome {
  distributedCommunityIds: string[];
  skippedReasons: string[];
}

/**
 * Derives and distributes a Post's Game-relevant Communities (§14-15):
 * home team, away team, league/competition, sport — each individually
 * gated by configurable policy, each individually best-effort (an
 * unresolvable entity is skipped and recorded, never blocks the others).
 * Fully idempotent and safe to call repeatedly for the same Post (§16,
 * §43) — re-running finds every Community/relation already ensured and
 * does nothing further.
 */
export async function distributePostForFixture(
  postId: string,
  fixtureId: string,
  // The batch job reads the policy once per run and passes it in; a single caller may omit it.
  knownPolicy?: CommunityDistributionPolicy,
): Promise<FixtureDistributionOutcome> {
  const policy = knownPolicy ?? (await getCommunityDistributionPolicy());
  const entities = await resolveFixtureSportsEntities(fixtureId);
  if (!entities) return { distributedCommunityIds: [], skippedReasons: ["fixture-not-found"] };

  const distributedCommunityIds: string[] = [];
  const skippedReasons: string[] = [];

  if (policy.teamEnabled) {
    for (const [label, teamId] of [
      ["home-team", entities.homeTeamId],
      ["away-team", entities.awayTeamId],
    ] as const) {
      if (!teamId) {
        skippedReasons.push(`${label}-unresolved`);
        continue;
      }
      const { id } = await ensureTeamCommunity(teamId);
      await distributePostToCommunity(postId, id);
      distributedCommunityIds.push(id);
    }
  }

  if (policy.leagueEnabled) {
    if (!entities.leagueId) {
      skippedReasons.push("league-unresolved");
    } else {
      const { id } = await ensureLeagueCommunity(entities.leagueId);
      await distributePostToCommunity(postId, id);
      distributedCommunityIds.push(id);
    }
  }

  if (policy.sportEnabled) {
    // The sport's display name comes from the shared sport registry; an unknown key (retired history) falls back to a humanised key.
    const { id } = await ensureSportCommunity(entities.sportKey, getSportLabel(entities.sportKey) ?? humanizeSportKey(entities.sportKey));
    await distributePostToCommunity(postId, id);
    distributedCommunityIds.push(id);
  }

  return { distributedCommunityIds, skippedReasons };
}


/**
 * Every ACTIVE sport's Communities exist as soon as its Teams and League are synced — not only after a Team's first published Game Post. Without
 * this a member could not find or follow, say, the Ducks until Anaheim had a Game with a Market. Idempotent and set-based (one read of the sport's
 * Teams, one read of which already have a Community; only the missing ones are created), and it honours the same distribution policy flags as the
 * Post distribution itself. Returns how many Communities it created.
 */
export async function ensureCommunitiesForActiveSports(
  policy: { teamEnabled: boolean; leagueEnabled: boolean; sportEnabled: boolean },
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const admin = createAdminClient();
  let created = 0;
  for (const config of activeSportConfigs(env)) {
    if (policy.teamEnabled) {
      const teams = await fetchAllRows((from, to) => admin.from("teams").select("id").eq("provider", config.provider).order("id").range(from, to));
      const ids = teams.map((t) => t.id as string);
      const have = new Set((await fetchInChunks<{ team_id: string }>(ids, (chunk) => admin.from("communities").select("team_id").eq("type", "TEAM").in("team_id", chunk))).map((c) => c.team_id));
      for (const id of ids.filter((teamId) => !have.has(teamId))) if ((await ensureTeamCommunity(id)).outcome === "created") created++;
    }
    if (policy.leagueEnabled) {
      const leagues = await fetchAllRows((from, to) => admin.from("leagues").select("id").eq("provider", config.provider).order("id").range(from, to));
      const ids = leagues.map((l) => l.id as string);
      const have = new Set((await fetchInChunks<{ league_id: string }>(ids, (chunk) => admin.from("communities").select("league_id").eq("type", "LEAGUE").in("league_id", chunk))).map((c) => c.league_id));
      for (const id of ids.filter((leagueId) => !have.has(leagueId))) if ((await ensureLeagueCommunity(id)).outcome === "created") created++;
    }
    if (policy.sportEnabled && (await ensureSportCommunity(config.sport, config.sportLabel)).outcome === "created") created++;
  }
  return created;
}

/**
 * How many Community links a fully distributed Post carries under this policy: home + away team, the league, the sport — each only when its own
 * flag is on. This is the single definition of "complete", used to leave finished Posts alone.
 */
export function expectedCommunityLinksPerPost(policy: Pick<CommunityDistributionPolicy, "teamEnabled" | "leagueEnabled" | "sportEnabled">): number {
  return (policy.teamEnabled ? 2 : 0) + (policy.leagueEnabled ? 1 : 0) + (policy.sportEnabled ? 1 : 0);
}

export interface CommunityDistributionSummary {
  ranAt: string;
  policyEnabled: boolean;
  /** Communities created this run for teams / leagues / sports that had none (see ensureCommunitiesForActiveSports). */
  communitiesEnsured?: number;
  /** Published Posts in total (every one is reconciled, but only the incomplete ones cost any work). */
  postsPublished?: number;
  /** Published Posts that still lacked some expected Community link and so were worked on this run. */
  postsExamined: number;
  outcomes: Array<{ postId: string } & FixtureDistributionOutcome>;
  failures: Array<{ postId: string; error: string }>;
}

/**
 * The reconciliation job (§43): examines every PUBLISHED Post, not just
 * newly-published ones — this is what makes it a genuine backfill/
 * reconciliation mechanism (a Post published before a Community existed,
 * or before this job ever ran, is picked up correctly on the next run) as
 * well as the ongoing distribution mechanism, with the same idempotent
 * function either way. Not wired to any scheduler by this milestone,
 * exposed identically to R2/R3's own job pattern: a callable function,
 * a bearer-secret cron route, and a manual script.
 */
export async function runCommunityDistribution(): Promise<CommunityDistributionSummary> {
  const policy = await getCommunityDistributionPolicy();
  if (!policy.enabled) {
    return { ranAt: new Date().toISOString(), policyEnabled: false, postsExamined: 0, outcomes: [], failures: [] };
  }

  const admin = createAdminClient();
  const outcomes: CommunityDistributionSummary["outcomes"] = [];
  const failures: CommunityDistributionSummary["failures"] = [];

  // Own failure domain: a problem creating Communities never blocks distributing Posts (and is reported, so job health reads degraded).
  let communitiesEnsured = 0;
  try {
    communitiesEnsured = await ensureCommunitiesForActiveSports(policy);
  } catch (err) {
    failures.push({ postId: "(ensure communities)", error: errorMessage(err) });
  }

  // Every published Post is still reconciled — but "reconciled" now means the database tells us which ones are missing a link, so a complete Post
  // costs nothing. (Walking every Post on every run took ~14 API requests per Post, every run, for the whole season.)
  const { data: incomplete, error } = await admin.rpc("posts_needing_distribution", { p_expected_links: expectedCommunityLinksPerPost(policy) });
  if (error) throw error;
  const { count: postsPublished } = await admin.from("posts").select("id", { count: "exact", head: true }).not("published_at", "is", null);

  for (const post of incomplete ?? []) {
    try {
      const outcome = await distributePostForFixture(post.id, post.fixture_id, policy);
      outcomes.push({ postId: post.id, ...outcome });
    } catch (err) {
      failures.push({ postId: post.id, error: errorMessage(err) });
    }
  }

  return { ranAt: new Date().toISOString(), policyEnabled: true, communitiesEnsured, postsPublished: postsPublished ?? undefined, postsExamined: (incomplete ?? []).length, outcomes, failures };
}
