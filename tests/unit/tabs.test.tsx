import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs";

afterEach(() => cleanup());

// Phase B (design-system redesign) — the restrained tab primitive built
// for Discovery (Sports | Leagues | Teams, Phase C) ahead of that phase
// actually existing. Not wired to any real route yet — this is purely a
// primitive-level accessibility/behavior check using representative
// fixture tabs.
function ThreeTabs() {
  return (
    <Tabs defaultValue="sports">
      <TabsList>
        <TabsTab value="sports">Sports</TabsTab>
        <TabsTab value="leagues">Leagues</TabsTab>
        <TabsTab value="teams">Teams</TabsTab>
      </TabsList>
      <TabsPanel value="sports">Sports panel</TabsPanel>
      <TabsPanel value="leagues">Leagues panel</TabsPanel>
      <TabsPanel value="teams">Teams panel</TabsPanel>
    </Tabs>
  );
}

describe("Tabs", () => {
  it("exposes each tab via the tab role with the correct accessible name", () => {
    render(<ThreeTabs />);
    expect(screen.getByRole("tab", { name: "Sports" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Leagues" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Teams" })).toBeInTheDocument();
  });

  it("marks exactly the default tab as selected on initial render", () => {
    render(<ThreeTabs />);
    expect(screen.getByRole("tab", { name: "Sports" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Leagues" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Teams" })).toHaveAttribute("aria-selected", "false");
  });

  it("only shows the panel matching the selected tab", () => {
    render(<ThreeTabs />);
    expect(screen.getByText("Sports panel")).toBeVisible();
    expect(screen.queryByText("Leagues panel")).not.toBeInTheDocument();
  });

  it("switches selection on click", () => {
    render(<ThreeTabs />);
    fireEvent.click(screen.getByRole("tab", { name: "Leagues" }));
    expect(screen.getByRole("tab", { name: "Leagues" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Leagues panel")).toBeVisible();
  });

  // A real ArrowRight keypress moving focus depends on @base-ui/react's own
  // internal composite-widget handling, which relies on layout
  // measurements jsdom doesn't provide — not something worth simulating
  // here (that's the primitive's own tested behavior, not this wrapper's).
  // What this wrapper IS responsible for is not breaking the roving-
  // tabindex contract browsers/screen readers rely on for arrow-key
  // support to work at all: exactly one tab in the tab-order at a time.
  it("keeps a roving-tabindex contract — only the selected tab is in the default tab order", () => {
    render(<ThreeTabs />);
    expect(screen.getByRole("tab", { name: "Sports" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Leagues" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tab", { name: "Teams" })).toHaveAttribute("tabindex", "-1");
  });
});
