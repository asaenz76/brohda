/**
 * The Rules page quotes the cutoff, the platform fee and the stake limits from
 * the live settings. This pins that the loader returns exactly what is stored
 * (so the page can never drift from the product), against the real local DB.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTestAdminClient } from "./helpers/test-env";

vi.mock("server-only", () => ({}));

import { getRulesPolicy } from "@/lib/rules/policy";
import { describeLockWindow, describeStakeLimits, formatFeePercent } from "@/lib/rules/format";

const admin = getTestAdminClient();

async function settings() {
  const { data, error } = await admin
    .from("platform_settings")
    .select("pick_lock_minutes_before_kickoff, p2p_fee_bps, monetary_p2p_min_stake_cents, monetary_p2p_max_stake_cents, monetary_p2p_enabled, call_bs_enabled")
    .eq("id", true)
    .single();
  if (error) throw error;
  return data;
}

let original: Awaited<ReturnType<typeof settings>> | null = null;

afterEach(async () => {
  if (original) {
    await admin
      .from("platform_settings")
      .update({ pick_lock_minutes_before_kickoff: original.pick_lock_minutes_before_kickoff, p2p_fee_bps: original.p2p_fee_bps, monetary_p2p_min_stake_cents: original.monetary_p2p_min_stake_cents, monetary_p2p_max_stake_cents: original.monetary_p2p_max_stake_cents })
      .eq("id", true);
    original = null;
  }
});

describe("getRulesPolicy", () => {
  it("returns exactly the stored cutoff, fee, stake limits and switches", async () => {
    const stored = await settings();
    const policy = await getRulesPolicy();
    expect(policy).toEqual({
      lockMinutesBeforeKickoff: stored.pick_lock_minutes_before_kickoff,
      feeBps: stored.p2p_fee_bps,
      minStakeCents: Number(stored.monetary_p2p_min_stake_cents),
      maxStakeCents: Number(stored.monetary_p2p_max_stake_cents),
      monetaryEnabled: stored.monetary_p2p_enabled,
      callBsEnabled: stored.call_bs_enabled,
    });
  });

  it("follows a settings change immediately — the page can't keep a stale number", async () => {
    original = await settings();
    await admin.from("platform_settings").update({ pick_lock_minutes_before_kickoff: 25, p2p_fee_bps: 250, monetary_p2p_min_stake_cents: 500, monetary_p2p_max_stake_cents: 25_000 }).eq("id", true);
    const policy = await getRulesPolicy();
    expect(describeLockWindow(policy.lockMinutesBeforeKickoff)).toBe("25 minutes before kickoff");
    expect(formatFeePercent(policy.feeBps)).toBe("2.5%");
    expect(describeStakeLimits(policy.minStakeCents, policy.maxStakeCents)).toBe("between $5 and $250");
  });
});
