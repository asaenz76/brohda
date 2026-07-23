import { describe, expect, it } from "vitest";
import { needsProfileCompletionRedirect } from "@/lib/auth/profile-gate";

describe("needsProfileCompletionRedirect", () => {
  it("redirects when username is null and the path isn't /profile", () => {
    expect(needsProfileCompletionRedirect("/feed", null)).toBe(true);
  });

  it("redirects from /admin too — staff accounts aren't exempt", () => {
    expect(needsProfileCompletionRedirect("/admin/users", null)).toBe(true);
  });

  it("does not redirect once a username is set", () => {
    expect(needsProfileCompletionRedirect("/feed", "andre")).toBe(false);
  });

  it("does not redirect on /profile itself, even with no username (avoids a loop)", () => {
    expect(needsProfileCompletionRedirect("/profile", null)).toBe(false);
  });

  it("does not redirect on a nested /profile path (e.g. /profile/someone)", () => {
    expect(needsProfileCompletionRedirect("/profile/someone", null)).toBe(false);
  });
});
