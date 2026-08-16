import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminNav } from "@/components/AdminNav";

afterEach(() => cleanup());

let currentPathname = "/admin/events";
vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
}));

// Phase 4.1 §14/§15/§16: Data must read as active for every route Phase 4
// conceptually reassigned to it (competitions + its Workspace sub-routes,
// plus /admin/data itself), and never for anything else. Checks the
// underlying aria-current="page" attribute rather than CSS classes — the
// visible signal a screen reader (and the border-color styling) both key
// off of.
function activeLabel(): string | null {
  const active = screen.getAllByRole("link").find((el) => el.getAttribute("aria-current") === "page");
  return active?.textContent ?? null;
}

describe("AdminNav active-tab highlighting", () => {
  it("/admin/events -> Events active", () => {
    currentPathname = "/admin/events";
    render(<AdminNav role="super_admin" />);
    expect(activeLabel()).toBe("Events");
  });

  it("/admin/pools -> Pools active", () => {
    currentPathname = "/admin/pools";
    render(<AdminNav role="super_admin" />);
    expect(activeLabel()).toBe("Pools");
  });

  it("/admin/competitions -> Data active", () => {
    currentPathname = "/admin/competitions";
    render(<AdminNav role="super_admin" />);
    expect(activeLabel()).toBe("Data");
  });

  it("/admin/competitions/[id] (Competition Workspace) -> Data active", () => {
    currentPathname = "/admin/competitions/11111111-1111-1111-1111-111111111111";
    render(<AdminNav role="super_admin" />);
    expect(activeLabel()).toBe("Data");
  });

  it("/admin/competitions/[id]/synchronization (a Workspace sub-route) -> Data active", () => {
    currentPathname = "/admin/competitions/11111111-1111-1111-1111-111111111111/synchronization";
    render(<AdminNav role="super_admin" />);
    expect(activeLabel()).toBe("Data");
  });

  it("/admin/data/fixtures -> Data active", () => {
    currentPathname = "/admin/data/fixtures";
    render(<AdminNav role="super_admin" />);
    expect(activeLabel()).toBe("Data");
  });

  it("/admin/data/nfl -> Data active", () => {
    currentPathname = "/admin/data/nfl";
    render(<AdminNav role="super_admin" />);
    expect(activeLabel()).toBe("Data");
  });

  it("never highlights more than one tab at once", () => {
    currentPathname = "/admin/competitions/11111111-1111-1111-1111-111111111111/health";
    render(<AdminNav role="super_admin" />);
    const activeCount = screen.getAllByRole("link").filter((el) => el.getAttribute("aria-current") === "page").length;
    expect(activeCount).toBe(1);
  });

  it("an unrelated route (Users) does not activate Data", () => {
    currentPathname = "/admin/users";
    render(<AdminNav role="super_admin" />);
    expect(activeLabel()).toBe("Users");
  });
});
