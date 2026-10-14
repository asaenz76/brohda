import { describe, expect, it } from "vitest";
import { activeNavKey, railNav, visibleNav, PRIMARY_NAV, MOBILE_NAV } from "@/components/shell/nav";

describe("Messages in the navigation", () => {
  it("is absent while Messaging is off, so nothing about the rail or the phone bar changes", () => {
    expect(railNav(true, false).map((i) => i.key)).toEqual(visibleNav(PRIMARY_NAV, true).map((i) => i.key));
    expect(railNav(true, false).some((i) => i.key === "messages")).toBe(false);
    expect(MOBILE_NAV.some((i) => i.key === "messages")).toBe(false); // phones reach it from the Menu, so the five-slot bar is untouched
  });

  it("sits right after Notifications when Messaging is on", () => {
    const keys = railNav(true, true).map((i) => i.key);
    expect(keys.indexOf("messages")).toBe(keys.indexOf("notifications") + 1);
    expect(railNav(false, true).map((i) => i.key)).toContain("messages"); // messaging does not depend on the social-predictions gate
  });

  it("lights up for every Messages route and nothing else", () => {
    for (const p of ["/messages", "/messages/abc", "/messages/with/xyz"]) expect(activeNavKey(p, null)).toBe("messages");
    expect(activeNavKey("/notifications", null)).toBe("notifications");
    expect(activeNavKey("/feed", null)).toBe("home");
  });
});
