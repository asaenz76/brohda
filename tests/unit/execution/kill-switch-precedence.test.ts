import { describe, expect, it } from "vitest";
import { pickHighestPrecedenceSwitch } from "@/lib/execution/kill-switches";
import type { ExecutionKillSwitch, KillSwitchScope } from "@/lib/execution/types";

// Milestone 5.5 (STEP 6) — deterministic, documented kill-switch
// precedence: GLOBAL > PROVIDER > JURISDICTION > USER > MARKET > COHORT.
// Pure, no I/O.

function fakeSwitch(scope: KillSwitchScope, target: string | null = null): ExecutionKillSwitch {
  return {
    id: `${scope}-${target ?? "global"}`,
    scope,
    target,
    enabled: true,
    reason: "test",
    note: null,
    createdBy: "00000000-0000-0000-0000-000000000000",
    createdAt: new Date().toISOString(),
    expiresAt: null,
    disabledBy: null,
    disabledAt: null,
  };
}

describe("pickHighestPrecedenceSwitch", () => {
  it("returns null when no switches match", () => {
    expect(pickHighestPrecedenceSwitch([])).toBeNull();
  });

  it("GLOBAL outranks every other scope", () => {
    const switches = [fakeSwitch("MARKET", "m1"), fakeSwitch("USER", "u1"), fakeSwitch("GLOBAL")];
    expect(pickHighestPrecedenceSwitch(switches)?.scope).toBe("GLOBAL");
  });

  it("PROVIDER outranks JURISDICTION/USER/MARKET/COHORT", () => {
    const switches = [fakeSwitch("COHORT", "c1"), fakeSwitch("MARKET", "m1"), fakeSwitch("PROVIDER", "polymarket")];
    expect(pickHighestPrecedenceSwitch(switches)?.scope).toBe("PROVIDER");
  });

  it("USER outranks MARKET and COHORT", () => {
    const switches = [fakeSwitch("COHORT", "c1"), fakeSwitch("MARKET", "m1"), fakeSwitch("USER", "u1")];
    expect(pickHighestPrecedenceSwitch(switches)?.scope).toBe("USER");
  });

  it("MARKET outranks COHORT", () => {
    const switches = [fakeSwitch("COHORT", "c1"), fakeSwitch("MARKET", "m1")];
    expect(pickHighestPrecedenceSwitch(switches)?.scope).toBe("MARKET");
  });

  it("COHORT is the lowest precedence, chosen only when nothing broader matches", () => {
    const switches = [fakeSwitch("COHORT", "c1")];
    expect(pickHighestPrecedenceSwitch(switches)?.scope).toBe("COHORT");
  });
});
