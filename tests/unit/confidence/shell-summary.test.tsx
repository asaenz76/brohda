import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfidenceBalance, ConfidenceSummary, confidenceSummaryLabel } from "@/components/confidence/ConfidenceBalance";
import { LeftNav } from "@/components/shell/LeftNav";

afterEach(() => cleanup());
vi.mock("next/navigation", () => ({ usePathname: () => "/feed", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/shell/LogoutRow", () => ({ LogoutRow: () => <button type="button">Log out</button> }));

const figures = { total: 50, available: 32, reserved: 18 };

describe("the shell Confidence summary", () => {
  it("has one accessible label that says all three figures in the product's vocabulary", () => {
    expect(confidenceSummaryLabel(figures)).toBe("Confidence: 50 total, 32 available, 18 reserved behind your picks");
    expect(confidenceSummaryLabel({ total: 1234, available: 1000, reserved: 234 })).toBe("Confidence: 1,234 total, 1,000 available, 234 reserved behind your picks");
  });

  it("is a titled block linking to the Confidence page, with total, available and reserved visible", () => {
    render(<ConfidenceSummary {...figures} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/profile/confidence");
    expect(link).toHaveAttribute("aria-label", "Confidence: 50 total, 32 available, 18 reserved behind your picks. Open your Confidence history");
    expect(link.textContent).toMatch(/Confidence/);
    expect(link.textContent).toMatch(/50\s*total/);
    expect(link.textContent).toMatch(/32\s*available/);
    expect(link.textContent).toMatch(/18\s*reserved behind your picks/);
  });

  it("shows reserved even when it is zero, so the three figures are always the same three", () => {
    render(<ConfidenceSummary total={50} available={50} reserved={0} />);
    expect(screen.getByRole("link").textContent).toMatch(/0\s*reserved behind your picks/);
  });

  it("uses an icon for the flame (not a native emoji) and no money formatting or wallet language", () => {
    const { container } = render(<ConfidenceSummary {...figures} stacked />);
    expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(4);
    expect(container.textContent).not.toMatch(/🔥|\$|wallet|USDT/i);
  });

  it("the phone chip shows the flame and the total, and carries the same full label", () => {
    render(<ConfidenceBalance {...figures} />);
    const link = screen.getByRole("link");
    expect(link.textContent?.trim()).toBe("50");
    expect(link).toHaveAttribute("aria-label", expect.stringMatching(/^Confidence: 50 total, 32 available, 18 reserved behind your picks/));
  });
});

describe("LeftNav", () => {
  const base = { profileSlug: "me", showSocialNav: true, unreadNotificationCount: 0, availableCents: 0, heldCents: 0, isAdmin: false } as const;

  it("puts the Confidence block in the lower utility section, before Wallet, Settings and Rules", () => {
    render(<LeftNav {...base} showWallet confidence={figures} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const order = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    const confidenceAt = order.indexOf("/profile/confidence");
    expect(confidenceAt).toBeGreaterThan(order.indexOf("/profile") === -1 ? -1 : 0);
    expect(confidenceAt).toBeLessThan(order.indexOf("/wallet"));
    expect(order.indexOf("/wallet")).toBeLessThan(order.indexOf("/profile/edit"));
  });

  it("shows nothing about Confidence when there is no Confidence (off, Sponsor, signed out)", () => {
    render(<LeftNav {...base} showWallet={false} confidence={null} />);
    expect(document.querySelector('[data-slot="shell-confidence"]')).toBeNull();
    expect(screen.queryByText(/Confidence/)).toBeNull();
  });

  it("never replaces or hides Settings, Rules or Log out", () => {
    render(<LeftNav {...base} showWallet={false} confidence={figures} />);
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Rules")).toBeInTheDocument();
    expect(screen.getByText("Log out")).toBeInTheDocument();
  });
});
