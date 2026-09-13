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
});
