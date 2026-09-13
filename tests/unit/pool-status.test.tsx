import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PoolStatus } from "@/components/pools/PoolStatus";

afterEach(() => cleanup());

// PoolStatus is a true status primitive — it renders exactly the pool's
// categorical state, nothing else. Visibility/posted-time/entered/
// countdown all moved out (PoolMetadata / PoolSummary) so this component
// can't drift back into a metadata dumping ground.
describe("PoolStatus", () => {
  it.each([
    ["OPEN_PRE_VOTE", "Open"],
    ["OPEN_POST_VOTE", "Open"],
    ["LOCKED", "Locked"],
    ["LIVE", "Live"],
    ["READY_FOR_REVIEW", "Under Review"],
    ["SETTLED_WON", "Final"],
    ["SETTLED_LOST", "Final"],
    ["VOIDED", "Voided"],
    ["POSTPONED_NOTICE", "Postponed"],
    ["CANCELLED_NOTICE", "Cancelled"],
    ["SUSPENDED_NOTICE", "Suspended"],
  ] as const)("renders %s as %s", (status, label) => {
    render(<PoolStatus status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("never renders visibility, posted-time, or countdown text", () => {
    render(<PoolStatus status="OPEN_PRE_VOTE" />);
    expect(screen.queryByText(/Public|Private|Posted|Locks in/)).not.toBeInTheDocument();
  });
});
