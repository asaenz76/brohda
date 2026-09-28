import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card } from "@/components/ui/card";

afterEach(() => cleanup());

// Phase B (design-system redesign) — regression guard against the
// "comic panel" treatment (2px border + hard offset drop-shadow), the
// same removal as button.test.tsx's own guard, plus coverage for the new
// `variant` prop Phase C+ content work will rely on ("row"/"plain").
describe("Card", () => {
  it("no longer carries the retired comic-panel shadow/border treatment by default", () => {
    render(<Card data-testid="card">content</Card>);
    const card = screen.getByTestId("card");
    expect(card.className).not.toMatch(/shadow-\[/);
    expect(card.className).not.toMatch(/border-2\b/);
  });

  it("defaults to the bordered 'default' variant", () => {
    render(<Card data-testid="card">content</Card>);
    expect(screen.getByTestId("card")).toHaveAttribute("data-variant", "default");
  });

  it("'row' variant has no full border/radius, only a bottom divider", () => {
    render(
      <Card data-testid="card" variant="row">
        content
      </Card>,
    );
    const card = screen.getByTestId("card");
    expect(card).toHaveAttribute("data-variant", "row");
    expect(card.className).not.toMatch(/\brounded-lg\b/);
    expect(card.className).toMatch(/border-b/);
  });

  it("'plain' variant has no border at all", () => {
    render(
      <Card data-testid="card" variant="plain">
        content
      </Card>,
    );
    const card = screen.getByTestId("card");
    expect(card.className).not.toMatch(/\bborder\b/);
  });

  it("a caller-provided className still merges with the variant", () => {
    render(
      <Card data-testid="card" variant="plain" className="mt-4">
        content
      </Card>,
    );
    expect(screen.getByTestId("card")).toHaveClass("mt-4");
  });
});
