import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as summaryModule from "@/components/confidence/ConfidenceBalance";
import { ConfidenceSummary, confidenceSummaryLabel } from "@/components/confidence/ConfidenceBalance";
import { LeftNav } from "@/components/shell/LeftNav";
import { MobileNav } from "@/components/shell/MobileNav";

afterEach(() => cleanup());
vi.mock("next/navigation", () => ({ usePathname: () => "/feed", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/shell/LogoutRow", () => ({ LogoutRow: () => <button type="button">Log out</button> }));

const figures = { total: 50, available: 32, reserved: 18 };
const text = (el: Element) => el.textContent?.replace(/\s+/g, " ").trim() ?? "";

describe("the shell Confidence summary", () => {
  it("has one accessible label that says all three figures in the product's vocabulary", () => {
    expect(confidenceSummaryLabel(figures)).toBe("Confidence: 50 total, 32 available, 18 reserved behind your picks");
    expect(confidenceSummaryLabel({ total: 1234, available: 1000, reserved: 234 })).toBe("Confidence: 1,234 total, 1,000 available, 234 reserved behind your picks");
  });

  it.each(["rail", "banner"] as const)("%s: a titled block that is one link to the Confidence page, with total, available and reserved all visible", (variant) => {
    render(<ConfidenceSummary {...figures} variant={variant} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/profile/confidence");
    expect(link).toHaveAttribute("aria-label", "Confidence: 50 total, 32 available, 18 reserved behind your picks. Open Confidence history");
    expect(link).toHaveAttribute("data-slot", "shell-confidence");
    expect(text(link)).toMatch(/^Confidence/);
    expect(text(link)).toMatch(/50 total/);
    expect(text(link)).toMatch(/32 available/);
    expect(text(link)).toMatch(/18 reserved behind your picks/);
  });

  it("the phone banner keeps the product's order — total first, then available · reserved behind your picks — and is tall enough to tap", () => {
    render(<ConfidenceSummary {...figures} variant="banner" />);
    const link = screen.getByRole("link");
    expect(text(link)).toMatch(/^Confidence\s*50 total\s*32 available\s*·\s*18 reserved behind your picks/);
    expect(link.className).toContain("min-h-14");
  });

  it.each([
    ["A — nothing reserved", { total: 50, available: 50, reserved: 0 }, /50 total/, /50 available/, /0 reserved behind your picks/],
    ["B — some reserved", { total: 50, available: 32, reserved: 18 }, /50 total/, /32 available/, /18 reserved behind your picks/],
    ["C — nothing available", { total: 18, available: 0, reserved: 18 }, /18 total/, /0 available/, /18 reserved behind your picks/],
  ])("%s: all three figures are always shown, including zero", (_name, f, total, available, reserved) => {
    for (const variant of ["rail", "banner"] as const) {
      render(<ConfidenceSummary {...f} variant={variant} />);
      const content = text(screen.getByRole("link"));
      expect(content).toMatch(total);
      expect(content).toMatch(available);
      expect(content).toMatch(reserved);
      cleanup();
    }
  });

  it("uses an icon for the flame (not a native emoji) and no money formatting or wallet language", () => {
    for (const variant of ["rail", "banner"] as const) {
      const { container } = render(<ConfidenceSummary {...figures} variant={variant} />);
      expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(4);
      expect(container.textContent).not.toMatch(/🔥|\$|wallet|usdt|cash|funds?\b|bankroll|payout|deposit|withdraw|escrow|wager|\bbet\b/i);
      expect(screen.getByRole("link").getAttribute("aria-label")).not.toMatch(/\$|wallet|usdt|cash|funds?\b|bankroll|payout|deposit|withdraw|escrow|wager|\bbet\b/i);
      cleanup();
    }
  });

  it("lets 'reserved behind your picks' wrap on a narrow rail instead of cutting it off: only the flame, the number and the first word are glued together", () => {
    const { container } = render(<ConfidenceSummary {...figures} />);
    const glued = [...container.querySelectorAll(".whitespace-nowrap")].map((e) => text(e));
    expect(glued).toContain("50 total");
    expect(glued).toContain("18 reserved");
    expect(glued.some((g) => /behind/.test(g))).toBe(false);
    expect(container.querySelector(".truncate")).toBeNull();
  });

  it("the old standalone phone chip (just the flame and the total) no longer exists", () => {
    expect(Object.keys(summaryModule)).not.toContain("ConfidenceBalance");
  });
});

describe("LeftNav", () => {
  const base = { profileSlug: "me", showSocialNav: true, unreadNotificationCount: 0, isAdmin: false } as const;

  it("puts the Confidence block in the lower section, in the slot the Wallet balance used to own: after the primary links, before Settings", () => {
    render(<LeftNav {...base} showWallet={false} confidence={figures} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const order = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(order.indexOf("/profile/confidence")).toBe(order.indexOf("/profile") + 1);
    expect(order.indexOf("/profile/confidence")).toBeLessThan(order.indexOf("/profile/edit"));
  });

  it("there is exactly one Confidence summary in the rail, and it is the full one", () => {
    render(<LeftNav {...base} showWallet={false} confidence={figures} />);
    const all = document.querySelectorAll('[data-slot="shell-confidence"]');
    expect(all).toHaveLength(1);
    expect(all[0]).toHaveAttribute("data-variant", "rail");
  });

  it("shows nothing about Confidence when there is no Confidence (off, Sponsor, signed out) and leaves no gap", () => {
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

  it("a Member who still has money in the system keeps a plain Wallet link BELOW the utilities — no amount, no icon next to Confidence, nothing competing", () => {
    render(<LeftNav {...base} showWallet confidence={figures} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const order = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(order.indexOf("/wallet")).toBeGreaterThan(order.indexOf("/rules"));
    expect(text(nav.querySelector('a[href="/wallet"]')!)).toBe("Wallet");
    expect(text(screen.getByRole("link", { name: /^Confidence:/ }))).not.toMatch(/\$|wallet/i);
  });
});

describe("MobileNav (the phone)", () => {
  it("the Menu holds no second Confidence summary — the one on the page is the only one", async () => {
    render(<MobileNav profileSlug="me" showSocialNav showWallet={false} unreadNotificationCount={0} isAdmin={false} profile={{ displayName: "Me", avatarUrl: null }} />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const sheet = await screen.findByTestId("auth-mobile-menu");
    expect(within(sheet).queryByRole("link", { name: /Confidence/ })).toBeNull();
    expect(sheet.querySelector('[data-slot="shell-confidence"]')).toBeNull();
  });
});
