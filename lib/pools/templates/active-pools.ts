import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { ACTIVE_CONFLICT_STATUSES, type ActivePoolSummary } from "./recommendations";

/** Every pool on this fixture still competing for liquidity (DRAFT through
 * AWAITING_RESULT — see ACTIVE_CONFLICT_STATUSES for why terminal/review
 * statuses are excluded). Used to compute publishing warnings and
 * recommendation scores; never used for anything settlement-related.
 *
 * excludeTierGroupId excludes every sibling pool sharing that tier-group id
 * (not just one pool by id) — a fee-tier batch is the same question by
 * design, so tiers 2+ would otherwise always trip EXACT_DUPLICATE against
 * tier 1. Excluding the whole group (not blanket-overriding warnings for
 * every tier after the first) keeps this guardrail live against a genuine
 * unrelated duplicate published mid-batch. */
export async function getActivePoolSummariesForFixture(
  adminClient: ReturnType<typeof createAdminClient>,
  fixtureId: string,
  excludePoolId?: string,
  excludeTierGroupId?: string | null,
): Promise<ActivePoolSummary[]> {
  let query = adminClient
    .from("pools")
    .select("id, pool_type, template_id, template_config, tier_group_id")
    .eq("fixture_id", fixtureId)
    .in("status", ACTIVE_CONFLICT_STATUSES);
  if (excludePoolId) {
    query = query.neq("id", excludePoolId);
  }
  if (excludeTierGroupId) {
    query = query.or(`tier_group_id.is.null,tier_group_id.neq.${excludeTierGroupId}`);
  }

  const { data } = await query;
  return (data ?? []).map((row) => ({
    poolType: row.pool_type as string,
    templateId: row.template_id as string | null,
    templateConfig: row.template_config as Record<string, unknown> | null,
  }));
}
