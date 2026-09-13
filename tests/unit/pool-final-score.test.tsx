import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PoolFinalScore } from "@/components/pools/PoolFinalScore";

afterEach(() => cleanup());

describe("PoolFinalScore", () => {
  it("renders both team names and the final score", () => {
    render(
      <PoolFinalScore
        homeTeamName="Buffalo Bills"
        homeTeamLogoUrl={null}
        awayTeamName="Kansas City Chiefs"
        awayTeamLogoUrl={null}
        homeScore={20}
        awayScore={27}
      />,
    );
    expect(screen.getByText("Buffalo Bills")).toBeInTheDocument();
    expect(screen.getByText("Kansas City Chiefs")).toBeInTheDocument();
    expect(screen.getByText("20–27")).toBeInTheDocument();
  });

  it("does not repeat a FINAL label — that's PoolStatus's job", () => {
    render(
      <PoolFinalScore
        homeTeamName="Home"
        homeTeamLogoUrl={null}
        awayTeamName="Away"
        awayTeamLogoUrl={null}
        homeScore={10}
        awayScore={3}
      />,
    );
    expect(screen.queryByText("FINAL")).not.toBeInTheDocument();
  });

  it("defaults a null score to 0", () => {
    render(
      <PoolFinalScore
        homeTeamName="Home"
        homeTeamLogoUrl={null}
        awayTeamName="Away"
        awayTeamLogoUrl={null}
        homeScore={null}
        awayScore={null}
      />,
    );
    expect(screen.getByText("0–0")).toBeInTheDocument();
  });
});
