import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BalancePill } from "@/components/BalancePill";

afterEach(() => cleanup());

describe("BalancePill", () => {
  it("shows the available amount and links to the wallet", () => {
    render(<BalancePill availableCents={80000} heldCents={0} />);
    const link = screen.getByRole("link", { name: "Wallet: $800.00 available" });
    expect(link).toHaveAttribute("href", "/wallet");
    expect(link).toHaveTextContent("$800.00");
  });

  it("notes money on hold without folding it into the headline number", () => {
    render(<BalancePill availableCents={80000} heldCents={20000} />);
    const link = screen.getByRole("link", { name: "Wallet: $800.00 available, $200.00 on hold" });
    expect(link).toHaveAttribute("title", "$800.00 available, $200.00 on hold");
    expect(link).toHaveTextContent("$800.00");
    expect(link).toHaveTextContent("$200.00 on hold");
  });

  it("says nothing about holds when nothing is held", () => {
    render(<BalancePill availableCents={5000} heldCents={0} />);
    expect(screen.getByRole("link")).not.toHaveTextContent(/on hold/i);
  });

  it("never shows the total as the headline when everything is on hold", () => {
    render(<BalancePill availableCents={0} heldCents={10000} />);
    expect(screen.getByRole("link", { name: "Wallet: $0.00 available, $100.00 on hold" })).toBeInTheDocument();
  });
});
