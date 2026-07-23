import { describe, expect, it } from "vitest";
import { isUsableSession, isSuperAdmin } from "@/lib/auth/guards";
import type { UserProfile } from "@/lib/auth/session";

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    display_name: "Test User",
    username: null,
    avatar_url: null,
    role: "player",
    is_active: true,
    ...overrides,
  };
}

describe("isUsableSession", () => {
  it("rejects a null profile", () => {
    expect(isUsableSession(null)).toBe(false);
  });

  it("rejects a deactivated profile", () => {
    expect(isUsableSession(makeProfile({ is_active: false }))).toBe(false);
  });

  it("accepts an active profile", () => {
    expect(isUsableSession(makeProfile())).toBe(true);
  });
});

describe("isSuperAdmin", () => {
  it("is false for a player", () => {
    expect(isSuperAdmin(makeProfile({ role: "player" }))).toBe(false);
  });

  it("is true for a super_admin", () => {
    expect(isSuperAdmin(makeProfile({ role: "super_admin" }))).toBe(true);
  });
});
