import { describe, expect, it } from "vitest";
import { activeNavKey, LEADERBOARD_NAV, MOBILE_NAV, PRIMARY_NAV, railNav, visibleNav } from "@/components/shell/nav";

describe("the Leaderboard navigation entry", () => {
  it("does not exist while the weekly leaderboard is off: the rail is exactly what it was", () => {
    expect(railNav(true, false).map((i) => i.key)).toEqual(visibleNav(PRIMARY_NAV, true).map((i) => i.key));
    expect(railNav(true, false, false).some((i) => i.key === "leaderboard")).toBe(false);
    expect(railNav(true, true, false).some((i) => i.key === "leaderboard")).toBe(false);
    expect(PRIMARY_NAV.some((i) => i.key === "leaderboard")).toBe(false);
    expect(MOBILE_NAV.some((i) => i.key === "leaderboard")).toBe(false); // the four-item bottom bar never changes
  });

  it("appears right after Discovery when on, with Messages still after Notifications", () => {
    expect(railNav(true, false, true).map((i) => i.key)).toEqual(["home", "discovery", "leaderboard", "notifications", "search", "profile"]);
    expect(railNav(true, true, true).map((i) => i.key)).toEqual(["home", "discovery", "leaderboard", "notifications", "messages", "search", "profile"]);
    expect(railNav(false, false, true).map((i) => i.key)).toEqual(["home", "leaderboard", "notifications", "search", "profile"]);
  });

  it("points at /leaderboard and lights up on it", () => {
    expect(LEADERBOARD_NAV.href).toBe("/leaderboard");
    expect(LEADERBOARD_NAV.label).toBe("Leaderboard");
    expect(activeNavKey("/leaderboard", null)).toBe("leaderboard");
    expect(activeNavKey("/feed", null)).toBe("home");
  });
});
