import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SiteFooter, FOOTER_LINKS } from "@/components/shell/SiteFooter";
import { LegalPage } from "@/components/legal/LegalPage";

afterEach(() => cleanup());

describe("SiteFooter", () => {
  it("links the public pages that live side by side — Rules, Terms, Privacy, Sponsorship — then the copyright", () => {
    render(<SiteFooter />);
    expect(FOOTER_LINKS.map((l) => [l.label, l.href])).toEqual([
      ["Rules", "/rules"],
      ["Terms", "/terms"],
      ["Privacy", "/privacy"],
      ["Sponsorship", "/sponsorship"],
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
    expect(screen.getByRole("link", { name: "Sponsorship" })).toHaveAttribute("href", "/sponsorship");
  });

  it("uses the SAME public header as Rules (logo, Log in, Create account) and no longer carries its own 'Back to brohda.' link", () => {
    render(
      <LegalPage title="Privacy Policy" effectiveDate="July 22, 2026">
        <p>body</p>
      </LegalPage>,
    );
    expect(screen.getByRole("link", { name: "brohda." })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/register");
    expect(screen.queryByText(/Back to brohda/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1); // one footer, not two
  });

  it("a signed-in visitor's header offers their own way back instead of Log in / Create account", () => {
    render(
      <LegalPage title="Terms of Service" effectiveDate="July 22, 2026" accountNav={<a href="/feed">Open brohda.</a>}>
        <p>body</p>
      </LegalPage>,
    );
    expect(screen.getByRole("link", { name: "Open brohda." })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Log in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Create account" })).not.toBeInTheDocument();
  });
});
