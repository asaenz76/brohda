/**
 * Brohda 2.1 M4 — the Post's two new readers make a CONSTANT number of database calls however many Members picked, commented or challenged: no per-comment, per-participant or per-challenge read.
 * Every `from()` / `rpc()` on the service client is counted, then the same readers run again with many more Members; the counts must be identical.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { getTestAdminClient } from "./helpers/test-env";

const counter = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/supabase/admin", async () => {
  const { getTestAdminClient: real } = await import("./helpers/test-env");
  const client = real();
  return {
    createAdminClient: () =>
      new Proxy(client, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== "function") return value;
          if (prop === "from" || prop === "rpc") {
            return (...args: unknown[]) => {
              counter.calls += 1;
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return value.bind(target);
        },
      }),
  };
});

import { seedGame, seedPick, seedUser } from "./helpers/game-seed";
import { callBS } from "@/lib/challenges/repository";
import { loadPostSocial } from "@/lib/challenges/post-social";
import { loadGameCallBsStatus } from "@/lib/challenges/game-status";
import { getSelectionLabel } from "@/lib/prediction-markets/selection-labels";
import { getMarketById } from "@/lib/prediction-markets/repository";

const admin = getTestAdminClient();

beforeEach(async () => {
  const { error } = await admin.from("platform_settings").update({ call_bs_enabled: true, pick_lock_minutes_before_kickoff: 10, call_bs_rate_limit_max_attempts: 1000 }).eq("id", true);
  if (error) throw error;
});

async function measure(opponents: number) {
  const g = await seedGame();
  const { data: fixture } = await admin.from("fixtures").select("scheduled_start_utc, home_team_name, away_team_name, sport").eq("id", g.fixtureId).single();
  const market = (await getMarketById(g.marketId))!;
  const labelFor = (o: "YES" | "NO") => getSelectionLabel({ ...market, homeTeamName: fixture!.home_team_name, awayTeamName: fixture!.away_team_name, sport: fixture!.sport }, o);
  const viewer = await seedUser("viewer");
  await seedPick(viewer, g.marketId, "YES");
  for (let i = 0; i < opponents; i += 1) {
    const other = await seedUser(`opp${i}`);
    const pickId = await seedPick(other, g.marketId, "NO");
    const r = await callBS(viewer, pickId);
    if (!r.ok) throw new Error(r.error);
  }

  counter.calls = 0;
  const social = await loadPostSocial({ marketId: g.marketId, viewerId: viewer, scheduledStartUtc: fixture!.scheduled_start_utc, lockMinutesBeforeKickoff: 10, labelFor });
  const socialCalls = counter.calls;
  counter.calls = 0;
  const status = await loadGameCallBsStatus({ viewerId: viewer, marketIds: [g.marketId], pastCutoff: false });
  const statusCalls = counter.calls;
  return { socialCalls, statusCalls, participants: Object.keys(social!.byUserId).length, items: status.items.length, more: status.more };
}

describe("the Post's social readers are batched", () => {
  it("make the same number of database calls for 1 opponent and for 12", async () => {
    const small = await measure(1);
    const large = await measure(12);
    if (process.env.SOCIAL_LOOP_PERF_OUT) appendFileSync(process.env.SOCIAL_LOOP_PERF_OUT, `1 opponent: ${JSON.stringify(small)}\n12 opponents: ${JSON.stringify(large)}\n`);
    expect(small.participants).toBe(2);
    expect(large.participants).toBe(13);
    expect(large.items + large.more).toBe(12);
    expect(large.socialCalls).toBe(small.socialCalls);
    expect(large.statusCalls).toBe(small.statusCalls);
    // The absolute numbers are small and fixed (participants, viewer challenges, blocks, profiles, head-to-head x2, settings...).
    expect(small.socialCalls).toBeLessThanOrEqual(10);
    expect(small.statusCalls).toBeLessThanOrEqual(8);
  }, 120_000);
});
