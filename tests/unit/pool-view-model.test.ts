import { describe, expect, it } from "vitest";
import { buildPoolCardViewModel, computeOptionStats, type BuildViewModelInput } from "@/lib/pools/view-model";

describe("computeOptionStats", () => {
  it("nulls both percentage and payout when distribution isn't visible (gated entry_count)", () => {
    const [stats] = computeOptionStats([{ id: "a", entry_count: null }], 10, 1800);
    expect(stats.percentage).toBeNull();
    expect(stats.estimatedPayout).toBeNull();
  });

  it("shows 0% but a null payout for an option with zero entries (division-by-zero guarded)", () => {
    const [stats] = computeOptionStats([{ id: "a", entry_count: 0 }], 10, 1800);
    expect(stats.percentage).toBe(0);
    expect(stats.estimatedPayout).toBeNull();
  });

  it("computes percentage and the house-fee-adjusted 'if this wins' payout for a normal case", () => {
    const [alpha, beta] = computeOptionStats(
      [
        { id: "alpha", entry_count: 3 },
        { id: "beta", entry_count: 7 },
      ],
      10,
      1800, // e.g. gross 2000 at a 10% house fee -> net prize pool 1800
    );

    expect(alpha.percentage).toBe(30);
    expect(alpha.estimatedPayout).toBe(600); // floor(1800 / 3)

    expect(beta.percentage).toBe(70);
    expect(beta.estimatedPayout).toBe(257); // floor(1800 / 7) = 257.14...
  });

  it("nulls percentage when there are zero total entries across the pool", () => {
    const [stats] = computeOptionStats([{ id: "a", entry_count: 0 }], 0, 0);
    expect(stats.percentage).toBeNull();
    expect(stats.estimatedPayout).toBeNull();
  });

  it("preserves option order and IDs", () => {
    const stats = computeOptionStats(
      [
        { id: "x", entry_count: 1 },
        { id: "y", entry_count: 1 },
        { id: "z", entry_count: 1 },
      ],
      3,
      300,
    );
    expect(stats.map((s) => s.optionId)).toEqual(["x", "y", "z"]);
  });
});

function buildInput(overrides: Partial<BuildViewModelInput> = {}): BuildViewModelInput {
  return {
    pool: {
      id: "pool-1",
      question: "Will they all score?",
      title: "2026 FIFA World Cup Final",
      pool_type: "COMBO",
      entry_fee: 1000,
      house_fee_bps: 1000,
      min_total_entries: 10,
      locks_at: new Date(Date.now() + 60_000).toISOString(),
      status: "OPEN",
      created_at: new Date().toISOString(),
      void_reason: null,
      visibility: "VISIBLE_TO_ALL_MEMBERS",
      like_count: 0,
      comment_count: 0,
    },
    fixture: {
      competition_name: null,
      competition_country: null,
      competition_logo_url: null,
      round: null,
      scheduled_start_utc: new Date(Date.now() + 60_000).toISOString(),
      home_team_name: "",
      home_team_logo_url: null,
      away_team_name: "",
      away_team_logo_url: null,
      internal_status: "NOT_STARTED",
      elapsed_minutes: null,
      home_score: null,
      away_score: null,
    },
    options: [
      { id: "yes", label: "Yes", logo_url: null, entry_count: 0, total_entry_amount: 0, is_winning_option: false },
      { id: "no", label: "No", logo_url: null, entry_count: 0, total_entry_amount: 0, is_winning_option: false },
    ],
    currentUserEntry: null,
    totals: { total_entries: 0, gross_pool: 0 },
    participants: [],
    participantCount: 0,
    finalPayout: null,
    isLikedByCurrentUser: false,
    ...overrides,
  };
}

describe("buildPoolCardViewModel comboLegs", () => {
  it("surfaces each condition's id/label for a COMBO pool, read-only (no selection state of its own)", () => {
    const viewModel = buildPoolCardViewModel(
      buildInput({
        comboLegs: [
          { id: "leg-1", label: "Mbappé 1+ goals" },
          { id: "leg-2", label: "Bellingham 1+ goals" },
        ],
      }),
    );

    expect(viewModel.comboLegs).toEqual([
      { id: "leg-1", label: "Mbappé 1+ goals" },
      { id: "leg-2", label: "Bellingham 1+ goals" },
    ]);
  });

  it("is null for a non-COMBO pool even if leg rows were somehow passed in", () => {
    const viewModel = buildPoolCardViewModel(
      buildInput({
        pool: { ...buildInput().pool, pool_type: "CUSTOM" },
        comboLegs: [{ id: "leg-1", label: "Shouldn't render" }],
      }),
    );

    expect(viewModel.comboLegs).toBeNull();
  });

  it("defaults to an empty array for a COMBO pool with no legs passed", () => {
    const viewModel = buildPoolCardViewModel(buildInput());
    expect(viewModel.comboLegs).toEqual([]);
  });
});
