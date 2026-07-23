import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PasswordInput } from "@/components/ui/password-input";

afterEach(() => cleanup());

describe("PasswordInput", () => {
  it("renders masked by default and reveals the value when the eye toggle is clicked", () => {
    render(<PasswordInput name="password" defaultValue="hunter2" />);

    const input = screen.getByDisplayValue("hunter2");
    expect(input).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input).toHaveAttribute("type", "text");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input).toHaveAttribute("type", "password");
  });
});
