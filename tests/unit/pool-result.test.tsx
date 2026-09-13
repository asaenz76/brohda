import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SocialPoolCardViewModel } from "@/lib/pools/view-model";
import { PoolResult } from "@/components/pools/PoolResult";

afterEach(() => cleanup());

function buildViewModel(overrides: Partial<SocialPoolCardViewModel> = {}): SocialPoolCardViewModel {
  return {
    poolId: "pool-1",
    status: "SETTLED_WON",
    visibility: "VISIBLE_TO_ALL_MEMBERS",
    postedAt: new Date().toISOString(),
    fixture: {
      sport: "american_football",
      competitionName: "NFL",
      competitionCountry: null,
      competitionLogoUrl: null,
      round: null,
      kickoffAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      homeTeamName: "Buffalo Bills",
      homeTeamLogoUrl: null,
      awayTeamName: "Kansas City Chiefs",
      awayTeamLogoUrl: null,
      status: "COMPLETED",
      elapsedMinutes: null,
      homeScore: 20,
      awayScore: 27,
      homeTeamFollow: null,
      awayTeamFollow: null,
      leagueFollow: null,
    },
    question: "Will Kansas City Chiefs win by 4+ points?",
    title: null,
    poolType: "TEMPLATE_GRADED",
    ruleLabel: "Auto-graded from the fixture result",
    comboLegs: null,
    entryFee: 1000,
    houseFeeBasisPoints: 500,
    minTotalEntries: 10,
    locksAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    totalEntries: 40,
    grossPool: 40000,
    estimatedNetPrizePool: 38000,
    options: [
      { optionId: "yes", label: "Yes", teamLogoUrl: null, percentage: 60, estimatedPayout: 1583, isCurrentUserChoice: true },
      { optionId: "no", label: "No", teamLogoUrl: null, percentage: 40, estimatedPayout: 2375, isCurrentUserChoice: false },
    ],
    currentUser: {
      hasEntered: true,
      selectedOptionId: "yes",
      entryCount: 1,
      entryAmount: 1000,
      estimatedPayout: 1583,
      finalPayout: 1583,
      refundedAmount: null,
    },
    socialProof: { participantCount: 40, visibleParticipants: [] },
    likeCount: 0,
    isLikedByCurrentUser: false,
    commentCount: 0,
    notice: { type: "SETTLED_WON", message: "You won $15.83" },
    ...overrides,
  };
}

describe("PoolResult", () => {
  it("shows the final score, the viewer's pick, and the win notice", () => {
    render(<PoolResult viewModel={buildViewModel()} />);
    expect(screen.getByText("20–27")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("You won $15.83")).toBeInTheDocument();
  });

  it("omits the pick line for a viewer who never entered", () => {
    const viewModel = buildViewModel({
      status: "SETTLED_LOST",
      currentUser: {
        hasEntered: false,
        selectedOptionId: null,
        entryCount: 0,
        entryAmount: 0,
        estimatedPayout: null,
        finalPayout: null,
        refundedAmount: null,
      },
      notice: null,
    });
    render(<PoolResult viewModel={viewModel} />);
    expect(screen.queryByText(/Your pick/)).not.toBeInTheDocument();
  });

  it("omits the final score for a fixtureless CUSTOM pool", () => {
    const viewModel = buildViewModel({
      poolType: "CUSTOM",
      fixture: { ...buildViewModel().fixture, homeTeamName: "", awayTeamName: "" },
    });
    render(<PoolResult viewModel={viewModel} />);
    expect(screen.queryByText("20–27")).not.toBeInTheDocument();
    expect(screen.queryByText("Buffalo Bills")).not.toBeInTheDocument();
  });
});
