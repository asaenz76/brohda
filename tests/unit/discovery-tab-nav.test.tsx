import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscoveryTabNav } from "@/components/discovery/DiscoveryTabNav";

afterEach(() => cleanup());

const push = vi.fn();
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

// Phase D (Brohda 2.0 redesign, spec §2, §29) — exactly the 3 locked
// Discovery tabs, URL-driven, with the same accessibility contract Phase
// B's Tabs primitive already guarantees.
describe("DiscoveryTabNav", () => {
  it("renders exactly the 3 locked tabs, nothing else", () => {
    render(<DiscoveryTabNav active="sports" />);
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Sports", "Leagues", "Teams"]);
  });

  it("marks exactly the active tab as selected", () => {
    render(<DiscoveryTabNav active="leagues" />);
    expect(screen.getByRole("tab", { name: "Sports" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Leagues" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Teams" })).toHaveAttribute("aria-selected", "false");
  });

  it("navigates to the corresponding ?tab= URL when a tab is clicked", () => {
    render(<DiscoveryTabNav active="sports" />);
    fireEvent.click(screen.getByRole("tab", { name: "Teams" }));
    expect(push).toHaveBeenCalledWith("/discovery?tab=teams");
  });

  it("also calls router.refresh() — a search-param-only push can otherwise be served stale from the Client Router Cache", () => {
    render(<DiscoveryTabNav active="sports" />);
    fireEvent.click(screen.getByRole("tab", { name: "Teams" }));
    expect(refresh).toHaveBeenCalled();
  });

  it("keeps a roving-tabindex contract — only the active tab is in the default tab order", () => {
    render(<DiscoveryTabNav active="teams" />);
    expect(screen.getByRole("tab", { name: "Sports" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tab", { name: "Leagues" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tab", { name: "Teams" })).toHaveAttribute("tabindex", "0");
  });
});
