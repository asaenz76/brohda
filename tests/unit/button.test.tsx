import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";

afterEach(() => cleanup());

describe("Button", () => {
  it("does not apply w-full by default", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).not.toHaveClass("w-full");
  });

  it("applies w-full when fullWidth is set, alongside the normal variant/size classes", () => {
    render(
      <Button fullWidth size="lg">
        Click me
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Click me" });
    expect(button).toHaveClass("w-full");
    expect(button).toHaveClass("h-9"); // size="lg" still applied
  });

  it("still merges a caller-provided className with fullWidth", () => {
    render(
      <Button fullWidth className="mt-4">
        Click me
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Click me" });
    expect(button).toHaveClass("w-full");
    expect(button).toHaveClass("mt-4");
  });

  // Phase B (design-system redesign) — regression guard against the
  // "comic panel" treatment (2px border + hard offset drop-shadow)
  // identified in Phase A as the single biggest blocker to a restrained,
  // Mastodon-inspired visual language, and removed in Phase B. Checks the
  // className string directly rather than a computed style, since jsdom
  // doesn't apply Tailwind's own CSS.
  it("no longer carries the retired comic-panel shadow/border treatment on any real variant", () => {
    for (const variant of ["default", "outline", "secondary", "destructive"] as const) {
      const { unmount } = render(<Button variant={variant}>Click me</Button>);
      const button = screen.getByRole("button", { name: "Click me" });
      expect(button.className).not.toMatch(/shadow-\[/);
      expect(button.className).not.toMatch(/border-2\b/);
      unmount();
    }
  });
});
