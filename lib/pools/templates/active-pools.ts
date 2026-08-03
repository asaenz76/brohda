import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { ACTIVE_CONFLICT_STATUSES, type ActivePoolSummary } from "./recommendations";

/** Every pool on this fixture still competing for liquidity (DRAFT through
 * AWAITING_RESULT — see ACTIVE_CONFLICT_STATUSES for why terminal/review
 * statuses are excluded). Used to compute publishing warnings and
 * recommendation scores; never used for anything settlement-related. */
export async function getActivePoolSummariesForFixture(
  adminClient: ReturnType<typeof createAdminClient>,
  fixtureId: string,
  excludePoolId?: string,
): Promise<ActivePoolSummary[]> {
  let query = adminClient
    .from("pools")
    .select("id, pool_type, template_id, template_config")
    .eq("fixture_id", fixtureId)
    .in("status", ACTIVE_CONFLICT_STATUSES);
  if (excludePoolId) {
    query = query.neq("id", excludePoolId);
  }

  const { data } = await query;
  return (data ?? []).map((row) => ({
    poolType: row.pool_type as string,
    templateId: row.template_id as string | null,
    templateConfig: row.template_config as Record<string, unknown> | null,
  }));
}
