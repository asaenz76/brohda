import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UserIdentity, CompactUserIdentity } from "@/components/identity/UserIdentity";

afterEach(() => cleanup());

// Phase B (design-system redesign) — locks the spec's own canonical
// examples verbatim: "André / @asaenz / 67% prediction accuracy · 42
// predicted" (full) and "André · 67% · 42 predicted" (compact), plus the
// locked public-terminology rule (spec §3/§12): "predicted", never
// "decided" — this file is the one place that formats the count, so a
// leak here would leak everywhere these primitives get adopted.
describe("UserIdentity", () => {
  it("renders the exact full-treatment canonical example", () => {
    render(
      <UserIdentity
        displayName="André"
        username="asaenz"
        avatarUrl={null}
        reputation={{ accuracy: 0.67, decided: 42, void: 0 }}
      />,
    );
    expect(screen.getByText("André")).toBeInTheDocument();
    expect(screen.getByText("@asaenz")).toBeInTheDocument();
    expect(screen.getByText("67% prediction accuracy · 42 predicted")).toBeInTheDocument();
  });

  it('never renders the word "decided" anywhere in the DOM', () => {
    const { container } = render(
      <UserIdentity
        displayName="André"
        username="asaenz"
        avatarUrl={null}
        reputation={{ accuracy: 0.67, decided: 42, void: 3 }}
      />,
    );
    expect(container.textContent?.toLowerCase()).not.toContain("decided");
  });

  it('"N predicted" includes VOID picks (decided + void), matching lib/reputation\'s own convention', () => {
    render(
      <UserIdentity
        displayName="André"
        username="asaenz"
        avatarUrl={null}
        reputation={{ accuracy: 0.5, decided: 10, void: 2 }}
      />,
    );
    expect(screen.getByText("50% prediction accuracy · 12 predicted")).toBeInTheDocument();
  });

  it("never fabricates a percentage when accuracy is null but predictedCount > 0 (all-VOID history)", () => {
    render(
      <UserIdentity
        displayName="André"
        username="asaenz"
        avatarUrl={null}
        reputation={{ accuracy: null, decided: 0, void: 4 }}
      />,
    );
    expect(screen.getByText("no graded predictions yet · 4 predicted")).toBeInTheDocument();
    expect(screen.queryByText(/0%/)).toBeNull();
  });

  it("omits the reputation line entirely when there is truly zero history", () => {
    render(<UserIdentity displayName="André" username="asaenz" avatarUrl={null} reputation={{ accuracy: null, decided: 0, void: 0 }} />);
    expect(screen.queryByText(/predicted/)).toBeNull();
  });

  it("omits the handle line when username is null", () => {
    render(<UserIdentity displayName="André" username={null} avatarUrl={null} />);
    expect(screen.queryByText(/^@/)).toBeNull();
  });

  it("wraps in a link to the profile when href is provided", () => {
    render(<UserIdentity displayName="André" username="asaenz" avatarUrl={null} href="/profile/asaenz" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/profile/asaenz");
  });

  it("renders as plain (non-link) content when href is omitted", () => {
    render(<UserIdentity displayName="André" username="asaenz" avatarUrl={null} />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("CompactUserIdentity", () => {
  it("renders the exact compact-treatment canonical example", () => {
    render(<CompactUserIdentity displayName="André" avatarUrl={null} reputation={{ accuracy: 0.67, decided: 42, void: 0 }} />);
    expect(screen.getByText("André")).toBeInTheDocument();
    expect(screen.getByText(/· 67% · 42 predicted/)).toBeInTheDocument();
  });

  it('never renders the word "decided"', () => {
    const { container } = render(<CompactUserIdentity displayName="André" avatarUrl={null} reputation={{ accuracy: 0.51, decided: 186, void: 0 }} />);
    expect(container.textContent?.toLowerCase()).not.toContain("decided");
  });

  it('shows "unranked" rather than a fabricated percentage when accuracy is null but there is some (void-only) history', () => {
    render(<CompactUserIdentity displayName="André" avatarUrl={null} reputation={{ accuracy: null, decided: 0, void: 1 }} />);
    expect(screen.getByText(/· unranked · 1 predicted/)).toBeInTheDocument();
  });

  it("renders an avatar (Phase G addition — the original avatar-less compact treatment had no real caller)", () => {
    render(<CompactUserIdentity displayName="André" avatarUrl={null} reputation={null} />);
    expect(screen.getByRole("img", { name: "André" })).toBeInTheDocument();
  });
});
