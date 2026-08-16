import { describe, expect, it, vi } from "vitest";

// Phase 4 spec §18: /admin/fixtures is now a pure redirect. Everyday
// browsing goes to /admin/events; the two genuinely different concerns
// that used to live at this route (fixture-ID lookup, archived-fixtures
// management) go to /admin/data/fixtures instead, so any old bookmark or
// deep link still lands somewhere useful rather than a dead route.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`redirect:${target}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new RedirectSignal(target);
  },
}));

const { default: AdminFixturesRedirectPage } = await import("@/app/(admin)/admin/fixtures/page");

async function redirectTargetFor(params: Record<string, string | undefined>): Promise<string> {
  try {
    await AdminFixturesRedirectPage({ searchParams: Promise.resolve(params) });
  } catch (e) {
    if (e instanceof RedirectSignal) return e.target;
    throw e;
  }
  throw new Error("expected a redirect");
}

describe("/admin/fixtures redirect", () => {
  it("redirects the general case to /admin/events", async () => {
    expect(await redirectTargetFor({})).toBe("/admin/events");
  });

  it("preserves range/from/to/competition params into the /admin/events redirect", async () => {
    const target = await redirectTargetFor({ range: "custom", from: "2026-08-01", to: "2026-08-03", competition: "39" });
    const url = new URL(target, "http://localhost");
    expect(url.pathname).toBe("/admin/events");
    expect(url.searchParams.get("range")).toBe("custom");
    expect(url.searchParams.get("from")).toBe("2026-08-01");
    expect(url.searchParams.get("to")).toBe("2026-08-03");
    expect(url.searchParams.get("competition")).toBe("39");
  });

  it("redirects ?mode=fixture-id to /admin/data/fixtures", async () => {
    expect(await redirectTargetFor({ mode: "fixture-id" })).toBe("/admin/data/fixtures");
  });

  it("redirects ?archived=1 to /admin/data/fixtures?archived=1", async () => {
    expect(await redirectTargetFor({ archived: "1" })).toBe("/admin/data/fixtures?archived=1");
  });
});
