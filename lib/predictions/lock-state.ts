import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPickLockPolicy } from "@/lib/predictions/policy";
import { pickLockState } from "@/lib/predictions/lock";

/** The Pick lock for ONE Market's Game, for a page that renders a single Market (the Market page): closed already, or the instant it closes. Presentation only — the database decides every submit. */
export async function getMarketPickLock(marketId: string, now: Date = new Date()): Promise<{ closed: boolean; lockAt: string | null }> {
  const admin = createAdminClient();
  const { data: market } = await admin.from("markets").select("fixture_id").eq("id", marketId).maybeSingle();
  if (!market?.fixture_id) return { closed: false, lockAt: null };
  const [{ data: fixture }, policy] = await Promise.all([
    admin.from("fixtures").select("scheduled_start_utc, internal_status").eq("id", market.fixture_id).maybeSingle(),
    getPickLockPolicy(),
  ]);
  if (!fixture) return { closed: false, lockAt: null };
  return pickLockState({ internalStatus: fixture.internal_status, scheduledStartUtc: fixture.scheduled_start_utc }, policy.lockMinutesBeforeKickoff, now);
}
