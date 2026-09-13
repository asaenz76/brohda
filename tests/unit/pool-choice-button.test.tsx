import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PoolChoiceButton } from "@/components/pools/PoolChoiceButton";

afterEach(() => cleanup());

// Info/action separation: percentage and estimated payout used to render
// inline on this button (see the retired PoolOptionButton). That data now
// lives in CommunitySplit and the post-selection entry flow — this button
// only ever carries the choice label and selected state.
describe("PoolChoiceButton", () => {
  it("renders the option label as a real, accessible button", () => {
    render(
      <PoolChoiceButton label="Team Alpha" logoUrl={null} isCurrentUserChoice={false} disabled={false} onSelect={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Team Alpha" })).toBeInTheDocument();
  });

  it("never renders percentage or payout text", () => {
    render(
      <PoolChoiceButton label="Team Alpha" logoUrl={null} isCurrentUserChoice={false} disabled={false} onSelect={vi.fn()} />,
    );
    expect(screen.queryByText(/Picked by/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Est\. payout/)).not.toBeInTheDocument();
  });

  it("marks the current user's choice with aria-pressed", () => {
    render(
      <PoolChoiceButton label="Team Alpha" logoUrl={null} isCurrentUserChoice disabled={false} onSelect={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Team Alpha" })).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onSelect when clicked", () => {
    const onSelect = vi.fn();
    render(
      <PoolChoiceButton label="Team Alpha" logoUrl={null} isCurrentUserChoice={false} disabled={false} onSelect={onSelect} />,
    );
    screen.getByRole("button", { name: "Team Alpha" }).click();
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("does not call onSelect when disabled", () => {
    const onSelect = vi.fn();
    render(
      <PoolChoiceButton label="Team Alpha" logoUrl={null} isCurrentUserChoice={false} disabled onSelect={onSelect} />,
    );
    screen.getByRole("button", { name: "Team Alpha" }).click();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
