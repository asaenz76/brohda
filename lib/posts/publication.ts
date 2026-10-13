import { errorMessage } from "@/lib/utils/error-message";
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOddsProvider } from "@/lib/sports-data/provider-registry";
import { SPORT_CONFIGS } from "@/lib/sports-data/sport-registry";
import { listActiveMarketsForFixture } from "@/lib/prediction-markets/repository";
import { ensurePostForFixture, getPostByFixtureId, publishPost } from "./repository";
import { getPostPublicationPolicy } from "./policy";

// Milestone R3 (docs/BROHDA_2_0_MILESTONE_MAP.md, Post Foundation) — the
// Post publication service, deliberately separate from R2's Market
// ingestion job. "Sports ingestion produces sports truth; Post publication
// decides social publication" (the milestone's own §10 framing): this
// module never calls into lib/prediction-markets/ingestion/* to trigger
// itself, and R2's ingestion job never calls into this one either — they
// are two independent jobs, run separately, each with its own policy,
// composed only by an operator choosing to run both (in either order).

export interface PostPublicationOutcome {
  fixtureId: string;
  postId: string;
  outcome: "published" | "created-unpublished" | "already-published" | "skipped-no-active-market";
}

/**
 * Not-yet-started Games of every sport that has a registered provider (retired soccer history is excluded by construction) that still NEED
 * publishing work. An NBA / NHL season has ~1,300 future Games, so the candidate set is decided in ONE set-based database call
 * (`fixtures_needing_publication`, migration 195) that returns only the remainder — not by paging every upcoming Game and then every Post and Market for
 * them on each run, which was ~100 API requests a tick for almost no new work. The rule is unchanged: work remains for a Game that is not yet published AND
 * either has an ACTIVE Market to publish with (or the policy does not require one), or has no Post row yet (the Post is still created unpublished, ready
 * the moment a Market appears — exactly what publishing has always done).
 */
async function listEligibleFixtureIds(requiresActiveMarket: boolean): Promise<string[]> {
  const admin = createAdminClient();
  const providers = SPORT_CONFIGS.filter((c) => getOddsProvider(c.provider) !== null).map((c) => c.provider);
  if (providers.length === 0) return [];
  const { data, error } = await admin.rpc("fixtures_needing_publication", { p_providers: providers, p_requires_active_market: requiresActiveMarket });
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

/**
 * Idempotent per fixture (§34): calling this repeatedly for the same
 * fixture never creates a second Post (ensurePostForFixture's own DB-level
 * guarantee) and never un-publishes an already-published one (publishPost
 * only ever sets `published_at` from null, never overwrites it).
 */
export async function ensureAndPublishPostForFixture(fixtureId: string, requiresActiveMarket: boolean): Promise<PostPublicationOutcome> {
  const existing = await getPostByFixtureId(fixtureId);
  if (existing?.publishedAt) {
    return { fixtureId, postId: existing.id, outcome: "already-published" };
  }

  if (requiresActiveMarket) {
    const activeMarkets = await listActiveMarketsForFixture(fixtureId);
    if (activeMarkets.length === 0) {
      // Still ensure the Post exists (so it's ready the moment a Market
      // does appear) — just don't publish it yet.
      const { id } = await ensurePostForFixture(fixtureId);
      return { fixtureId, postId: id, outcome: "skipped-no-active-market" };
    }
  }

  const { id } = await ensurePostForFixture(fixtureId);
  await publishPost(id);
  return { fixtureId, postId: id, outcome: "published" };
}

export interface PostPublicationSummary {
  ranAt: string;
  policyEnabled: boolean;
  fixturesExamined: number;
  outcomes: PostPublicationOutcome[];
  failures: Array<{ fixtureId: string; error: string }>;
}

/**
 * The publication job itself. Not wired to any scheduler by this milestone
 * — exposed as a callable function (this), a cron-compatible route
 * (app/api/cron/publish-posts/route.ts), and a manual script
 * (scripts/publish-posts.ts), matching the R2 ingestion job's own
 * three-caller/one-function precedent exactly.
 */
export async function runPostPublication(): Promise<PostPublicationSummary> {
  const policy = await getPostPublicationPolicy();
  if (!policy.enabled) {
    return { ranAt: new Date().toISOString(), policyEnabled: false, fixturesExamined: 0, outcomes: [], failures: [] };
  }

  const fixtureIds = await listEligibleFixtureIds(policy.requiresActiveMarket);
  const outcomes: PostPublicationOutcome[] = [];
  const failures: PostPublicationSummary["failures"] = [];

  for (const fixtureId of fixtureIds) {
    try {
      outcomes.push(await ensureAndPublishPostForFixture(fixtureId, policy.requiresActiveMarket));
    } catch (error) {
      failures.push({ fixtureId, error: errorMessage(error) });
    }
  }

  return { ranAt: new Date().toISOString(), policyEnabled: true, fixturesExamined: fixtureIds.length, outcomes, failures };
}
