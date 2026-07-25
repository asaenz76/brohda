import { describe, expect, it } from "vitest";
import { createInvitationSchema, acceptInvitationSchema } from "@/lib/validations/invitation";
import { updateProfileSchema, loginSchema } from "@/lib/validations/profile";

describe("createInvitationSchema", () => {
  it("accepts a valid email", () => {
    const result = createInvitationSchema.safeParse({ email: "Friend@Example.com" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe("friend@example.com");
  });

  it("rejects an invalid email", () => {
    expect(createInvitationSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      createInvitationSchema.safeParse({ email: "a@b.com", role: "super_admin" }).success,
    ).toBe(false);
  });
});

describe("acceptInvitationSchema", () => {
  const valid = {
    token: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    displayName: "Andre",
    password: "supersecret",
    acceptedRules: true,
  };

  it("accepts a fully valid payload", () => {
    expect(acceptInvitationSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a short password", () => {
    expect(
      acceptInvitationSchema.safeParse({ ...valid, password: "short" }).success,
    ).toBe(false);
  });

  it("rejects when rules aren't accepted", () => {
    expect(
      acceptInvitationSchema.safeParse({ ...valid, acceptedRules: false }).success,
    ).toBe(false);
  });

  it("rejects a non-uuid token", () => {
    expect(acceptInvitationSchema.safeParse({ ...valid, token: "not-a-uuid" }).success).toBe(
      false,
    );
  });
});

describe("updateProfileSchema", () => {
  const requiredVisibilityFlags = {
    showPronouns: true,
    showGender: true,
    showBio: true,
    emailNotificationsEnabled: true,
  };

  it("rejects a display name with no username — username is required", () => {
    expect(
      updateProfileSchema.safeParse({ displayName: "Andre", ...requiredVisibilityFlags }).success,
    ).toBe(false);
  });

  it("rejects an invalid username format", () => {
    expect(
      updateProfileSchema.safeParse({
        displayName: "Andre",
        username: "Has Spaces!",
        ...requiredVisibilityFlags,
      }).success,
    ).toBe(false);
  });

  it("accepts a valid username", () => {
    expect(
      updateProfileSchema.safeParse({
        displayName: "Andre",
        username: "andre_s76",
        ...requiredVisibilityFlags,
      }).success,
    ).toBe(true);
  });
});

describe("loginSchema", () => {
  it("requires a non-empty password", () => {
    expect(loginSchema.safeParse({ email: "a@b.com", password: "" }).success).toBe(false);
  });

  it("accepts valid credentials", () => {
    expect(loginSchema.safeParse({ email: "a@b.com", password: "x" }).success).toBe(true);
  });
});
