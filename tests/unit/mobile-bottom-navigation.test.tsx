import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileBottomNavigation } from "@/components/MobileBottomNavigation";

afterEach(() => cleanup());

let currentPathname = "/feed";
vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
}));

const profile = { displayName: "André", avatarUrl: null };

function activeLabel(): string | null {
  const active = screen.getAllByRole("link").find((el) => el.getAttribute("aria-current") === "page");
  return active?.textContent ?? null;
}

// Phase B (design-system redesign) — the primary nav is now exactly the
// spec's locked target IA: Home / Discovery / Notifications / Profile.
// These tests lock that shape in, plus the accessibility contract
// (aria-current) and the documented temporary route mappings, so a future
// phase can't silently regress the nav back toward the old 6-item set
// while repurposing these same routes for real.
describe("MobileBottomNavigation", () => {
  it("renders exactly the 4 target destinations, nothing else", () => {
    currentPathname = "/feed";
    render(<MobileBottomNavigation profile={profile} />);
    // Profile's link also contains the Avatar fallback's initials text
    // node ("AN" for "André") alongside the "Profile" label — check
    // presence/order via individual role queries rather than an exact
    // full-textContent match, which the initials would otherwise break.
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(4);
    expect(links[0]).toHaveTextContent("Home");
    expect(links[1]).toHaveTextContent("Discovery");
    expect(links[2]).toHaveTextContent("Notifications");
    expect(links[3]).toHaveTextContent("Profile");
  });

  it("never renders Search, Leaderboard, or a Create action", () => {
    currentPathname = "/feed";
    render(<MobileBottomNavigation profile={profile} />);
    expect(screen.queryByRole("link", { name: /search/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /leaderboard/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /create/i })).toBeNull();
  });

  it("Home is temporarily mapped to /feed", () => {
    render(<MobileBottomNavigation profile={profile} />);
    expect(screen.getByRole("link", { name: /home/i })).toHaveAttribute("href", "/feed");
  });

  it("Discovery is temporarily mapped to /markets", () => {
    render(<MobileBottomNavigation profile={profile} />);
    expect(screen.getByRole("link", { name: /discovery/i })).toHaveAttribute("href", "/markets");
  });

  it("Notifications is temporarily mapped to /activity", () => {
    render(<MobileBottomNavigation profile={profile} />);
    expect(screen.getByRole("link", { name: /notifications/i })).toHaveAttribute("href", "/activity");
  });

  it("marks exactly one destination active via aria-current, matching the current path", () => {
    currentPathname = "/markets";
    render(<MobileBottomNavigation profile={profile} />);
    expect(activeLabel()).toBe("Discovery");
    const activeCount = screen.getAllByRole("link").filter((el) => el.getAttribute("aria-current") === "page").length;
    expect(activeCount).toBe(1);
  });

  it("hides Discovery when showSocialPredictionNav is false, keeping Home/Notifications/Profile", () => {
    currentPathname = "/feed";
    render(<MobileBottomNavigation profile={profile} showSocialPredictionNav={false} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveTextContent("Home");
    expect(links[1]).toHaveTextContent("Notifications");
    expect(links[2]).toHaveTextContent("Profile");
  });

  it("shows an unread badge on Notifications only when count > 0", () => {
    currentPathname = "/feed";
    const { rerender } = render(<MobileBottomNavigation profile={profile} unreadNotificationCount={0} />);
    expect(screen.getByRole("link", { name: /notifications/i }).textContent).not.toMatch(/unread/);

    rerender(<MobileBottomNavigation profile={profile} unreadNotificationCount={3} />);
    expect(screen.getByRole("link", { name: /notifications/i }).textContent).toMatch(/3 unread/);
  });

  it("caps the visible unread badge at 9+", () => {
    currentPathname = "/feed";
    render(<MobileBottomNavigation profile={profile} unreadNotificationCount={42} />);
    expect(screen.getByText("9+")).toBeInTheDocument();
  });
});
