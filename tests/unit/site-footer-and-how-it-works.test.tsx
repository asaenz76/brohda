import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SiteFooter, FOOTER_LINKS } from "@/components/shell/SiteFooter";
import { LegalPage } from "@/components/legal/LegalPage";
import HowItWorksPage, { metadata } from "@/app/how-it-works/page";

afterEach(() => cleanup());

describe("SiteFooter", () => {
  it("links the three public pages that live side by side, then the copyright", () => {
    render(<SiteFooter />);
    expect(FOOTER_LINKS.map((l) => l.href)).toEqual(["/how-it-works", "/terms", "/privacy"]);
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("navigation", { name: "About and legal" })).toBeInTheDocument();
    expect(footer).toHaveTextContent(`© ${new Date().getFullYear()} Brohda`);
  });
});

describe("LegalPage", () => {
  it("keeps the legal chrome for Terms/Privacy (effective date + contact) and adds the footer", () => {
    render(
      <LegalPage title="Terms of Service" effectiveDate="July 22, 2026">
        <p>body</p>
      </LegalPage>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeInTheDocument();
    expect(screen.getByText("Effective July 22, 2026")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "support@brohda.com" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How it works" })).toHaveAttribute("href", "/how-it-works");
  });

  it("an explainer has no effective date and no legal contact line", () => {
    render(
      <LegalPage title="Anything" closing={<p>custom closing</p>}>
        <p>body</p>
      </LegalPage>,
    );
    expect(screen.queryByText(/Effective/)).toBeNull();
    expect(screen.queryByText(/Questions about these terms/)).toBeNull();
    expect(screen.getByText("custom closing")).toBeInTheDocument();
  });
});

describe("How Brohda works (public page)", () => {
  it("explains the product in order: the games, how to play (pick, lock, talk, Call BS, results), your record, voids, money", () => {
    render(<HowItWorksPage />);
    expect(screen.getByRole("heading", { level: 1, name: "How Brohda works" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "The games",
      "How to play",
      "Your record",
      "When a game doesn't finish",
      "Money",
    ]);
    const steps = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(steps).toHaveLength(5);
    expect(steps[0]).toMatch(/^Pick a side\./);
    expect(steps[1]).toMatch(/^Change your mind, until it locks\./);
    expect(steps[2]).toMatch(/^Talk shit\./);
    expect(steps[3]).toMatch(/^Call BS\./);
    expect(steps[4]).toMatch(/^See who was right\./);
  });

  it("states the authorship rule: Brohda publishes every game, members never do", () => {
    const { container } = render(<HowItWorksPage />);
    expect(container.textContent).toMatch(/Every game on Brohda is published by Brohda/);
    expect(container.textContent).toMatch(/can.t create, edit or remove a game/);
  });

  it("describes configurable things instead of quoting numbers that can change, and is not promotional about money", () => {
    const { container } = render(<HowItWorksPage />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\$\s?\d|\d+\s?%|\b\d+\s*minutes?\b/i); // no dollar amounts, percentages or minute counts
    expect(text).not.toMatch(/\b(bet|bets|betting|wager|stake|payout|winnings|jackpot|odds|bankroll)\b/i);
    expect(text).toMatch(/optional/i);
    expect(text).toMatch(/never required/i);
  });

  it("is a public document: no composer, no account controls, lives with the Terms and Privacy chrome", () => {
    const { container } = render(<HowItWorksPage />);
    expect(container.querySelectorAll("textarea, form, input")).toHaveLength(0);
    expect(screen.getByRole("link", { name: "← Back to brohda." })).toHaveAttribute("href", "/");
    // The Terms are linked from the closing line and from the shared footer.
    expect(screen.getAllByRole("link", { name: "Terms" })).toHaveLength(2);
    expect(metadata.title).toBe("How brohda. works — brohda.");
  });
});
