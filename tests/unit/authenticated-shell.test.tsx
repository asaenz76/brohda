import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let currentPathname = "/feed";
vi.mock("next/navigation", () => ({ usePathname: () => currentPathname, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
// Log out is a server action; the shell only needs it importable.
vi.mock("@/lib/actions/auth", () => ({ logoutAction: vi.fn() }));

import { LeftNav } from "@/components/shell/LeftNav";
import { MobileNav } from "@/components/shell/MobileNav";
import { ColumnHeader } from "@/components/shell/ColumnHeader";
import { activeNavKey, MOBILE_NAV, PRIMARY_NAV } from "@/components/shell/nav";

afterEach(() => cleanup());

const navProps = {
  profileSlug: "andre",
  showSocialNav: true,
  showWallet: true,
  unreadNotificationCount: 0,
  availableCents: 80_000,
  heldCents: 20_000,
  isAdmin: false,
};
const profile = { displayName: "André", avatarUrl: null };

const activeLabels = () =>
  screen
    .getAllByRole("link")
    .filter((el) => el.getAttribute("aria-current") === "page")
    .map((el) => el.textContent?.replace(/\s+/g, " ").trim());

describe("activeNavKey", () => {
  it.each([
    ["/feed", "home"],
    ["/discovery", "discovery"],
    ["/community/some-team", "discovery"],
    ["/notifications", "notifications"],
    ["/activity", "notifications"],
    ["/search", "search"],
    ["/wallet", "wallet"],
    ["/profile", "profile"],
    ["/profile/edit", "settings"],
    ["/profile/andre", "profile"],
    ["/profile/andre/followers", "profile"],
  ])("%s -> %s", (path, key) => {
    expect(activeNavKey(path, "andre")).toBe(key);
  });

  it("someone else's profile does not light up Profile — it isn't your page", () => {
    expect(activeNavKey("/profile/carlos", "andre")).toBeNull();
    expect(activeNavKey("/profile/andrew", "andre")).toBeNull(); // not a prefix match on the name
  });

  it("a Post or Market detail belongs to no nav entry", () => {
    expect(activeNavKey("/post/abc", "andre")).toBeNull();
    expect(activeNavKey("/markets/abc", "andre")).toBeNull();
  });
});

describe("LeftNav (desktop rail)", () => {
  it("lists Home, Discovery, Notifications, Search, Profile in order — with Wallet below as a utility, never among them", () => {
    render(<LeftNav {...navProps} />);
    expect(PRIMARY_NAV.map((i) => i.label)).toEqual(["Home", "Discovery", "Notifications", "Search", "Profile"]);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/feed", "/discovery", "/notifications", "/search", "/profile", "/wallet", "/profile/edit", "/rules"]);
    expect(links.find((l) => l.getAttribute("href") === "/wallet")).toHaveAttribute("aria-label", "Wallet: $800.00 available, $200.00 on hold");
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it.each([
    ["/feed", "Home"],
    ["/discovery", "Discovery"],
    ["/notifications", "Notifications"],
    ["/search", "Search"],
    ["/profile", "Profile"],
    ["/wallet", "Wallet$800.00"],
    ["/profile/edit", "Settings"],
  ])("marks exactly one entry as the current page on %s", (path, label) => {
    currentPathname = path;
    render(<LeftNav {...navProps} />);
    expect(activeLabels()).toEqual([label]);
  });

  it("shows no active entry on a Post, and none for someone else's profile", () => {
    currentPathname = "/post/abc";
    render(<LeftNav {...navProps} />);
    expect(activeLabels()).toEqual([]);
    cleanup();
    currentPathname = "/profile/carlos";
    render(<LeftNav {...navProps} />);
    expect(activeLabels()).toEqual([]);
  });

  it("hides Discovery only when the social product is off, and shows Admin only to admins", () => {
    currentPathname = "/feed";
    render(<LeftNav {...navProps} showSocialNav={false} />);
    expect(screen.queryByRole("link", { name: /discovery/i })).toBeNull();
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
    cleanup();
    render(<LeftNav {...navProps} isAdmin />);
    expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute("href", "/admin/users");
  });

  it("shows an unread count that's readable without colour, and nothing when there are none", () => {
    render(<LeftNav {...navProps} unreadNotificationCount={3} />);
    expect(screen.getByRole("link", { name: /Notifications/ })).toHaveTextContent("(3 unread)");
    cleanup();
    render(<LeftNav {...navProps} unreadNotificationCount={0} />);
    expect(screen.getByRole("link", { name: /Notifications/ })).not.toHaveTextContent("unread");
  });

  it("has no composer or create entry of any kind", () => {
    const { container } = render(<LeftNav {...navProps} />);
    expect(container.textContent).not.toMatch(/create|new (post|game)|compose|publish/i);
  });

  it("wallet shows the available amount, not the total", () => {
    render(<LeftNav {...navProps} />);
    const wallet = screen.getByRole("link", { name: /^Wallet:/ });
    expect(wallet).toHaveTextContent("$800.00");
    expect(wallet).not.toHaveTextContent("$1,000.00");
    expect(wallet).toHaveAttribute("title", "$800.00 available, $200.00 on hold");
  });
});

describe("Wallet entry follows the consumer money capability", () => {
  it("rail: with the wallet hidden there is no Wallet link, no balance and no money text — and the rest of the lower section is intact", () => {
    currentPathname = "/feed";
    const { container } = render(<LeftNav {...navProps} showWallet={false} />);
    expect(screen.queryByRole("link", { name: /wallet/i })).toBeNull();
    expect(container.textContent).not.toMatch(/\$|wallet|balance|on hold/i);
    expect(screen.getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/feed", "/discovery", "/notifications", "/search", "/profile", "/profile/edit", "/rules"]);
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("phone Menu: with the wallet hidden the sheet has Search, Settings, Rules and Log out — no Wallet", async () => {
    currentPathname = "/feed";
    render(<MobileNav {...navProps} showWallet={false} profile={profile} />);
    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const sheet = await screen.findByTestId("auth-mobile-menu");
    expect(within(sheet).queryByRole("link", { name: /wallet/i })).toBeNull();
    expect(within(sheet).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/search", "/profile/edit", "/rules"]);
    expect(sheet.textContent).not.toMatch(/\$|wallet/i);
  });
});

describe("MobileNav (bottom bar)", () => {
  it("is Home, Discovery, Notifications, Profile and a Menu — nothing else, no account actions", () => {
    currentPathname = "/feed";
    render(<MobileNav {...navProps} profile={profile} />);
    expect(MOBILE_NAV.map((i) => i.label)).toEqual(["Home", "Discovery", "Notifications", "Profile"]);
    const bar = screen.getByTestId("auth-bottom-nav");
    expect(within(bar).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual(["/feed", "/discovery", "/notifications", "/profile"]);
    expect(within(bar).getByRole("button", { name: "Menu" })).toBeInTheDocument();
    expect(bar.textContent).not.toMatch(/create account|log in|create|new post/i);
    expect(bar.className).toContain("env(safe-area-inset-bottom)");
    expect(bar.className).toContain("md:hidden");
  });

  it("marks the current destination with aria-current", () => {
    currentPathname = "/notifications";
    render(<MobileNav {...navProps} profile={profile} />);
    expect(activeLabels()).toEqual(["Notifications"]);
  });

  it("the Menu sheet holds Search, Wallet and Log out; Escape closes it and returns focus; links close it", async () => {
    currentPathname = "/feed";
    render(<MobileNav {...navProps} profile={profile} />);
    const menuButton = screen.getByRole("button", { name: "Menu" });
    fireEvent.click(menuButton);
    const sheet = await screen.findByTestId("auth-mobile-menu");
    expect(within(sheet).getByRole("link", { name: "Search" })).toHaveAttribute("href", "/search");
    expect(within(sheet).getByRole("link", { name: /^Wallet:/ })).toHaveAttribute("href", "/wallet");
    expect(within(sheet).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/profile/edit");
    expect(within(sheet).getByRole("link", { name: "Rules" })).toHaveAttribute("href", "/rules");
    expect(within(sheet).getByRole("button", { name: "Log out" })).toBeInTheDocument();
    expect(sheet.textContent).not.toMatch(/create|new post|publish/i);

    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("auth-mobile-menu")).toBeNull());
    await waitFor(() => expect(menuButton).toHaveFocus());

    fireEvent.click(menuButton);
    const reopened = await screen.findByTestId("auth-mobile-menu");
    fireEvent.click(within(reopened).getByRole("link", { name: "Search" }));
    await waitFor(() => expect(screen.queryByTestId("auth-mobile-menu")).toBeNull());
  });
});

describe("ColumnHeader", () => {
  it("renders the page title as the h1 and sticks to the top", () => {
    render(<ColumnHeader title="Home" />);
    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="column-header"]')?.className).toContain("sticky");
  });

  it("offers a labelled way back on a detail page, and slots in a tab row without doubling the border", () => {
    const { container } = render(
      <ColumnHeader title="Post" backHref="/feed" backLabel="Back to Home">
        <div role="tablist" aria-label="x" />
      </ColumnHeader>,
    );
    expect(screen.getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/feed");
    expect(container.querySelector('[data-slot="column-header"]')?.className).not.toMatch(/(^|\s)border-b(\s|$)/);
  });
});
