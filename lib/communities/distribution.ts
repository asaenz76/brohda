import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureLeagueCommunity, ensureSportCommunity, ensureTeamCommunity } from "./repository";
import { resolveFixtureSportsEntities } from "./fixture-resolution";
import { getCommunityDistributionPolicy } from "./policy";

// Milestone R4 (docs/BROHDA_2_0_MILESTONE_MAP.md, §13-17): the canonical
// many-to-many Post <-> Community distribution. Never copies a Post —
// every "distribution" is one row in `post_communities` referencing the
// same, single, canonical Post id.

export type DistributePostToCommunityOutcome = "created" | "existing";

/** Idempotent (§17): a unique_violation on the composite PK means this exact (post, community) pair already exists — a safe no-op, not an error. */
export async function distributePostToCommunity(postId: string, communityId: string): Promise<DistributePostToCommunityOutcome> {
  const admin = createAdminClient();
  const { error } = await admin.from("post_communities").insert({ post_id: postId, community_id: communityId });
  if (!error) return "created";
  if (error.code === "23505") return "existing";
  throw error;
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
export async function distributePostForFixture(postId: string, fixtureId: string): Promise<FixtureDistributionOutcome> {
  const policy = await getCommunityDistributionPolicy();
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
    const { id } = await ensureSportCommunity(entities.sportKey, humanizeSportKey(entities.sportKey));
    await distributePostToCommunity(postId, id);
    distributedCommunityIds.push(id);
  }

  return { distributedCommunityIds, skippedReasons };
}

export interface CommunityDistributionSummary {
  ranAt: string;
  policyEnabled: boolean;
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
  const { data: posts, error } = await admin.from("posts").select("id, fixture_id").not("published_at", "is", null);
  if (error) throw error;

  const outcomes: CommunityDistributionSummary["outcomes"] = [];
  const failures: CommunityDistributionSummary["failures"] = [];

  for (const post of posts ?? []) {
    try {
      const outcome = await distributePostForFixture(post.id, post.fixture_id);
      outcomes.push({ postId: post.id, ...outcome });
    } catch (err) {
      failures.push({ postId: post.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { ranAt: new Date().toISOString(), policyEnabled: true, postsExamined: (posts ?? []).length, outcomes, failures };
}
