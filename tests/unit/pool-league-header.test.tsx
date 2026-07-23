import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PoolLeagueHeader } from "@/components/pools/PoolLeagueHeader";

afterEach(() => cleanup());

const baseProps = {
  competitionName: null,
  competitionCountry: null,
  competitionLogoUrl: null,
  visibility: "VISIBLE_TO_ALL_MEMBERS" as const,
  createdAt: new Date().toISOString(),
  locksAt: new Date(Date.now() + 60_000).toISOString(),
  isLocked: false,
  isResolved: false,
};

describe("PoolLeagueHeader fallback label (no competition, no fixture)", () => {
  it("shows 'Custom Poll' for CUSTOM pools", () => {
    render(<PoolLeagueHeader {...baseProps} poolType="CUSTOM" />);
    expect(screen.getByText("Custom Poll")).toBeInTheDocument();
  });

  it("shows 'Combo' (not 'Combo Poll') for COMBO pools", () => {
    render(<PoolLeagueHeader {...baseProps} poolType="COMBO" />);
    expect(screen.getByText("Combo")).toBeInTheDocument();
    expect(screen.queryByText("Combo Poll")).not.toBeInTheDocument();
  });

  it("prefers the real competition name when one exists, regardless of poolType", () => {
    render(
      <PoolLeagueHeader {...baseProps} poolType="WHO_WILL_ADVANCE" competitionName="Premier League" />,
    );
    expect(screen.getByText("Premier League")).toBeInTheDocument();
  });

  it("prefixes the competition name with its country when one is known", () => {
    render(
      <PoolLeagueHeader
        {...baseProps}
        poolType="WHO_WILL_ADVANCE"
        competitionName="1st Division"
        competitionCountry="Albania"
      />,
    );
    expect(screen.getByText("Albania | 1st Division")).toBeInTheDocument();
  });

  it("falls back to the bare competition name when country is unknown", () => {
    render(
      <PoolLeagueHeader
        {...baseProps}
        poolType="WHO_WILL_ADVANCE"
        competitionName="Premier League"
        competitionCountry={null}
      />,
    );
    expect(screen.getByText("Premier League")).toBeInTheDocument();
  });
});

// Reproduces a bug found live: every non-open pool (settled, voided,
// ready for review, ...) was labeled "Choices Locked" here regardless of
// its actual state, since the caller passed isLocked = "anything that
// isn't open" instead of "genuinely locked/live." A SETTLED or VOIDED pool
// already has its own accurate copy from PoolStatusNotice below this
// header — this line must stay silent for those, not contradict it.
describe("PoolLeagueHeader locked/countdown line", () => {
  it("shows 'Choices Locked' while genuinely locked", () => {
    render(<PoolLeagueHeader {...baseProps} poolType="CUSTOM" isLocked isResolved={false} />);
    expect(screen.getByText("Choices Locked")).toBeInTheDocument();
  });

  it("shows a countdown while still open", () => {
    render(<PoolLeagueHeader {...baseProps} poolType="CUSTOM" isLocked={false} isResolved={false} />);
    expect(screen.getByText(/Locks in/)).toBeInTheDocument();
  });

  it("shows neither 'Choices Locked' nor a countdown once resolved (settled/voided/etc.)", () => {
    render(<PoolLeagueHeader {...baseProps} poolType="CUSTOM" isLocked={false} isResolved />);
    expect(screen.queryByText("Choices Locked")).not.toBeInTheDocument();
    expect(screen.queryByText(/Locks in/)).not.toBeInTheDocument();
  });
});
