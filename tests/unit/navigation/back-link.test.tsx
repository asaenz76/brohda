import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { back: vi.fn(), replace: vi.fn(), push: vi.fn() };
let pathname = "/feed";
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => pathname }));

// The tracker keeps module-level state, so every test gets a fresh copy of it.
async function load() {
  vi.resetModules();
  const { InAppHistoryTracker } = await import("@/components/shell/InAppHistoryTracker");
  const { BackLink } = await import("@/components/shell/BackLink");
  return { InAppHistoryTracker, BackLink };
}

beforeEach(() => {
  Object.values(router).forEach((fn) => fn.mockReset());
  pathname = "/feed";
});
afterEach(() => cleanup());

describe("BackLink", () => {
  it("is a real, labelled link to its fallback, with visible text (not just an arrow)", async () => {
    const { BackLink } = await load();
    render(<BackLink fallbackHref="/post/p1" />);
    const link = screen.getByRole("link", { name: "Back" });
    expect(link).toHaveAttribute("href", "/post/p1");
    expect(link).toHaveTextContent("Back");
  });

  it("with an in-app previous page it uses real history (router.back), never a hard-coded destination", async () => {
    const { BackLink, InAppHistoryTracker } = await load();
    const { rerender } = render(<InAppHistoryTracker />);
    pathname = "/post/p1";
    rerender(<InAppHistoryTracker />);
    pathname = "/markets/m1";
    rerender(<InAppHistoryTracker />);
    render(<BackLink fallbackHref="/post/p1" />);
    fireEvent.click(screen.getByRole("link", { name: "Back" }));
    expect(router.back).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("with no in-app previous page (a deep link) it replaces the entry with its fallback and never goes back", async () => {
    const { BackLink, InAppHistoryTracker } = await load();
    pathname = "/markets/m1";
    render(<InAppHistoryTracker />);
    render(<BackLink fallbackHref="/post/p1" />);
    fireEvent.click(screen.getByRole("link", { name: "Back" }));
    expect(router.replace).toHaveBeenCalledWith("/post/p1");
    expect(router.back).not.toHaveBeenCalled();
  });

  it("a modified click (new tab) is left to the browser", async () => {
    const { BackLink } = await load();
    render(<BackLink fallbackHref="/post/p1" />);
    fireEvent.click(screen.getByRole("link", { name: "Back" }), { metaKey: true });
    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
