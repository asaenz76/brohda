import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SiteFooter, FOOTER_LINKS } from "@/components/shell/SiteFooter";
import { LegalPage } from "@/components/legal/LegalPage";

afterEach(() => cleanup());

describe("SiteFooter", () => {
  it("links the three public pages that live side by side — Rules, Terms, Privacy — then the copyright", () => {
    render(<SiteFooter />);
    expect(FOOTER_LINKS.map((l) => [l.label, l.href])).toEqual([
      ["Rules", "/rules"],
      ["Terms", "/terms"],
      ["Privacy", "/privacy"],
    ]);
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("navigation", { name: "About and legal" })).toBeInTheDocument();
    expect(footer).toHaveTextContent(`© ${new Date().getFullYear()} Brohda`);
  });
});

describe("LegalPage", () => {
  it("keeps the legal chrome for Terms/Privacy (effective date + contact) and ends with the shared footer", () => {
    render(
      <LegalPage title="Terms of Service" effectiveDate="July 22, 2026">
        <p>body</p>
      </LegalPage>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeInTheDocument();
    expect(screen.getByText("Effective July 22, 2026")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "support@brohda.com" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rules" })).toHaveAttribute("href", "/rules");
  });
});
