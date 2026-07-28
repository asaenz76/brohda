import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";
import type { PoolLiveStats } from "@/lib/pools/fetch";

afterEach(() => cleanup());

// Captures the broadcast callback the component registers, so the test can
// simulate a realtime event arriving without a real websocket connection.
let broadcastCallback: (() => void) | null = null;

const fakeChannel = {
  on: (_type: string, _filter: unknown, callback: () => void) => {
    broadcastCallback = callback;
    return fakeChannel;
  },
  subscribe: () => fakeChannel,
};

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: () => fakeChannel,
    removeChannel: () => {},
  }),
}));

const getPoolLiveStatsAction = vi.fn<(poolId: string) => Promise<PoolLiveStats | null>>();
vi.mock("@/lib/actions/pools", () => ({
  getPoolLiveStatsAction: (poolId: string) => getPoolLiveStatsAction(poolId),
}));

// Imported after the mocks above so SocialPoolCard picks up the mocked modules.
const { SocialPoolCard } = await import("@/components/pools/SocialPoolCard");

function buildViewModel(overrides: Partial<SocialPoolCardViewModel> = {}): SocialPoolCardViewModel {
  return {
    poolId: "pool-1",
    status: "OPEN_POST_VOTE",
    visibility: "VISIBLE_TO_ALL_MEMBERS",
    postedAt: new Date().toISOString(),
    fixture: {
      competitionName: null,
      competitionCountry: null,
      competitionLogoUrl: null,
      round: null,
      kickoffAt: new Date(Date.now() + 60_000).toISOString(),
      homeTeamName: "",
      homeTeamLogoUrl: null,
      awayTeamName: "",
      awayTeamLogoUrl: null,
      status: "NOT_STARTED",
      elapsedMinutes: null,
      homeScore: null,
      awayScore: null,
    },
    question: "Who wins?",
    title: null,
    poolType: "CUSTOM",
    ruleLabel: "Custom Poll",
    comboLegs: null,
    entryFee: 1000,
    houseFeeBasisPoints: 1000,
    minTotalEntries: 10,
    locksAt: new Date(Date.now() + 60_000).toISOString(),
    totalEntries: 2,
    grossPool: 2000,
    estimatedNetPrizePool: 1800,
    options: [
      { optionId: "a", label: "Alpha", teamLogoUrl: null, percentage: 50, estimatedPayout: 1800, isCurrentUserChoice: true },
      { optionId: "b", label: "Beta", teamLogoUrl: null, percentage: 50, estimatedPayout: 1800, isCurrentUserChoice: false },
    ],
    currentUser: {
      hasEntered: true,
      selectedOptionId: "a",
      entryCount: 1,
      entryAmount: 1000,
      estimatedPayout: 1800,
      finalPayout: null,
      refundedAmount: null,
    },
    socialProof: { participantCount: 2, visibleParticipants: [] },
    likeCount: 0,
    isLikedByCurrentUser: false,
    commentCount: 0,
    notice: null,
    ...overrides,
  };
}

describe("SocialPoolCard live payout updates", () => {
  it("applies a live broadcast update, then a fresh SSR viewModel supersedes it (no stale override)", async () => {
    broadcastCallback = null;
    getPoolLiveStatsAction.mockResolvedValue({
      totalEntries: 3,
      grossPool: 3000,
      options: {
        a: { percentage: 33, estimatedPayout: 900 },
        b: { percentage: 67, estimatedPayout: 447 },
      },
    });

    const { rerender } = render(
      <SocialPoolCard viewModel={buildViewModel()} balanceCents={5000} paymentMethods={[]} viewer={{ id: "u1", isModerator: false }} />,
    );

    expect(screen.getAllByText("Picked by 50%").length).toBeGreaterThan(0);

    // Simulate a realtime broadcast arriving.
    expect(broadcastCallback).not.toBeNull();
    broadcastCallback!();

    await waitFor(() => expect(screen.getAllByText("Picked by 33%").length).toBeGreaterThan(0));
    expect(screen.getByText("Est. payout $9.00")).toBeInTheDocument();

    // A fresh SSR render (different totalEntries/grossPool) must win over
    // the stale live-broadcast override, not be masked by it.
    const freshViewModel = buildViewModel({
      totalEntries: 4,
      grossPool: 4000,
      options: [
        { optionId: "a", label: "Alpha", teamLogoUrl: null, percentage: 25, estimatedPayout: 900, isCurrentUserChoice: true },
        { optionId: "b", label: "Beta", teamLogoUrl: null, percentage: 75, estimatedPayout: 300, isCurrentUserChoice: false },
      ],
    });

    rerender(
      <SocialPoolCard viewModel={freshViewModel} balanceCents={5000} paymentMethods={[]} viewer={{ id: "u1", isModerator: false }} />,
    );

    expect(screen.getAllByText("Picked by 25%").length).toBeGreaterThan(0);
    expect(screen.queryByText("Picked by 33%")).not.toBeInTheDocument();
  });
});

describe("SocialPoolCard volume display", () => {
  it("shows total volume before entry even when per-option distribution is still gated, and live-updates it", async () => {
    broadcastCallback = null;
    getPoolLiveStatsAction.mockResolvedValue({
      totalEntries: 5,
      grossPool: 5000,
      options: {
        a: { percentage: null, estimatedPayout: null },
        b: { percentage: null, estimatedPayout: null },
      },
    });

    // A pre-entry viewer on a pool an admin explicitly restricted (e.g.
    // NEVER_SHOW / SHOW_AFTER_ENTRY): percentages/payouts are null (gated),
    // but grossPool is a true aggregate and always visible regardless.
    const viewModel = buildViewModel({
      status: "OPEN_PRE_VOTE",
      totalEntries: 2,
      grossPool: 2000,
      options: [
        { optionId: "a", label: "Alpha", teamLogoUrl: null, percentage: null, estimatedPayout: null, isCurrentUserChoice: false },
        { optionId: "b", label: "Beta", teamLogoUrl: null, percentage: null, estimatedPayout: null, isCurrentUserChoice: false },
      ],
      currentUser: {
        hasEntered: false,
        selectedOptionId: null,
        entryCount: 0,
        entryAmount: 0,
        estimatedPayout: null,
        finalPayout: null,
        refundedAmount: null,
      },
    });

    render(<SocialPoolCard viewModel={viewModel} balanceCents={5000} paymentMethods={[]} viewer={{ id: "u1", isModerator: false }} />);

    expect(screen.getByText("$20.00 volume")).toBeInTheDocument();
    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();

    // Pre-entry viewers must still subscribe so volume stays live, even
    // though the per-option distribution remains hidden to them.
    expect(broadcastCallback).not.toBeNull();
    broadcastCallback!();

    await waitFor(() => expect(screen.getByText("$50.00 volume")).toBeInTheDocument());
    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument();
  });
});

describe("SocialPoolCard combo conditions", () => {
  it("shows each condition as plain read-only text, not a selectable control, alongside the Yes/No options", () => {
    const viewModel = buildViewModel({
      poolType: "COMBO",
      ruleLabel: "All Conditions Must be met for Yes",
      comboLegs: [
        { id: "leg-1", label: "Mbappé 1+ goals" },
        { id: "leg-2", label: "Bellingham 1+ goals" },
      ],
      options: [
        { optionId: "a", label: "Yes", teamLogoUrl: null, percentage: 50, estimatedPayout: 1800, isCurrentUserChoice: false },
        { optionId: "b", label: "No", teamLogoUrl: null, percentage: 50, estimatedPayout: 1800, isCurrentUserChoice: false },
      ],
    });

    render(<SocialPoolCard viewModel={viewModel} balanceCents={5000} paymentMethods={[]} viewer={{ id: "u1", isModerator: false }} />);

    expect(screen.getByText("Mbappé 1+ goals")).toBeInTheDocument();
    expect(screen.getByText("Bellingham 1+ goals")).toBeInTheDocument();
    // Conditions are plain list text — no button/checkbox role, unlike the
    // Yes/No options right below them.
    expect(screen.queryByRole("button", { name: /Mbappé/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Yes/ })).toBeInTheDocument();
  });

  it("renders nothing extra for a non-COMBO pool (comboLegs null)", () => {
    const viewModel = buildViewModel({ poolType: "CUSTOM", comboLegs: null });

    render(<SocialPoolCard viewModel={viewModel} balanceCents={5000} paymentMethods={[]} viewer={{ id: "u1", isModerator: false }} />);

    expect(screen.queryByText("Mbappé 1+ goals")).not.toBeInTheDocument();
  });
});

describe("SocialPoolCard pre-entry distribution (default SHOW_BEFORE_ENTRY)", () => {
  it("shows per-option percentage, payout, and the distribution bar before the viewer has entered", () => {
    const viewModel = buildViewModel({
      status: "OPEN_PRE_VOTE",
      totalEntries: 2,
      grossPool: 2000,
      options: [
        { optionId: "a", label: "Alpha", teamLogoUrl: null, percentage: 50, estimatedPayout: 900, isCurrentUserChoice: false },
        { optionId: "b", label: "Beta", teamLogoUrl: null, percentage: 50, estimatedPayout: 900, isCurrentUserChoice: false },
      ],
      currentUser: {
        hasEntered: false,
        selectedOptionId: null,
        entryCount: 0,
        entryAmount: 0,
        estimatedPayout: null,
        finalPayout: null,
        refundedAmount: null,
      },
    });

    render(<SocialPoolCard viewModel={viewModel} balanceCents={5000} paymentMethods={[]} viewer={{ id: "u1", isModerator: false }} />);

    expect(screen.getAllByText("Picked by 50%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Est. payout $9.00").length).toBeGreaterThan(0);
    // PoolDistributionBar's combined "Community sentiment: Alpha 50%  |  Beta 50%" summary line.
    expect(screen.getByText(/Alpha 50%/)).toBeInTheDocument();
  });
});
