import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PoolSummary } from "@/components/pools/PoolSummary";

afterEach(() => cleanup());

const baseProps = {
  participantCount: 40,
  grossPool: 40000,
  locksAt: new Date(Date.now() + 60_000).toISOString(),
};

describe("PoolSummary", () => {
  it("shows entered count and pot as icon-led stats", () => {
    render(<PoolSummary {...baseProps} isLocked={false} isResolved={false} />);
    expect(screen.getByText(/40 entered/)).toBeInTheDocument();
    expect(screen.getByText(/\$400\.00 pot/)).toBeInTheDocument();
  });

  it("shows a live countdown while open", () => {
    render(<PoolSummary {...baseProps} isLocked={false} isResolved={false} />);
    expect(screen.getByText(/Locks in/)).toBeInTheDocument();
  });

  it("shows 'Choices Locked' while locked", () => {
    render(<PoolSummary {...baseProps} isLocked isResolved={false} />);
    expect(screen.getByText("Choices Locked")).toBeInTheDocument();
  });

  it("hides the countdown entirely once resolved", () => {
    render(<PoolSummary {...baseProps} isLocked={false} isResolved />);
    expect(screen.queryByText(/Locks in/)).not.toBeInTheDocument();
    expect(screen.queryByText("Choices Locked")).not.toBeInTheDocument();
  });

  it("never renders visibility, posted-time, or a personal 'You're in' pill", () => {
    render(<PoolSummary {...baseProps} isLocked={false} isResolved={false} />);
    expect(screen.queryByText(/Public|Private|Posted|You're in/)).not.toBeInTheDocument();
  });
});
