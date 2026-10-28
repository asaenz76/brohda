import { describe, expect, it } from "vitest";
import { updateProfileSchema, changePasswordSchema, registerSchema, registerFieldErrors, REGISTER_FIELD_MESSAGES } from "@/lib/validations/profile";

const validUpdate = {
  displayName: "André",
  username: "andre",
  pronouns: "They/them",
  gender: "Non-binary",
  bio: "Building PollPools.",
  showPronouns: true,
  showGender: true,
  showBio: true,
};

describe("updateProfileSchema", () => {
  it("accepts a fully valid payload", () => {
    expect(updateProfileSchema.safeParse(validUpdate).success).toBe(true);
  });

  it("accepts empty pronouns/gender/bio (all optional)", () => {
    const result = updateProfileSchema.safeParse({
      ...validUpdate,
      pronouns: "",
      gender: "",
      bio: "",
    });
    expect(result.success).toBe(true);
  });

  it("rejects pronouns over 30 characters", () => {
    const result = updateProfileSchema.safeParse({
      ...validUpdate,
      pronouns: "a".repeat(31),
    });
    expect(result.success).toBe(false);
  });

  it("rejects gender over 30 characters", () => {
    const result = updateProfileSchema.safeParse({
      ...validUpdate,
      gender: "a".repeat(31),
    });
    expect(result.success).toBe(false);
  });

  it("rejects bio over 150 characters", () => {
    const result = updateProfileSchema.safeParse({
      ...validUpdate,
      bio: "a".repeat(151),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing showPronouns/showGender/showBio (strict, required booleans)", () => {
    const rest = { ...validUpdate } as Partial<typeof validUpdate>;
    delete rest.showPronouns;
    expect(updateProfileSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an empty username — it's required, not optional", () => {
    const result = updateProfileSchema.safeParse({ ...validUpdate, username: "" });
    expect(result.success).toBe(false);
  });

  it("accepts a missing username — optional here since it's disabled/omitted from the form once already set", () => {
    const rest = { ...validUpdate } as Partial<typeof validUpdate>;
    delete rest.username;
    expect(updateProfileSchema.safeParse(rest).success).toBe(true);
  });

  it("rejects a username shorter than 3 characters", () => {
    const result = updateProfileSchema.safeParse({ ...validUpdate, username: "ab" });
    expect(result.success).toBe(false);
  });

  it("lowercases a mixed-case username", () => {
    const result = updateProfileSchema.safeParse({ ...validUpdate, username: "André123" });
    // "é" isn't in [a-z0-9_], so this specific value should fail — a plain
    // ASCII mixed-case one should pass and come out lowercased.
    expect(result.success).toBe(false);
    const ascii = updateProfileSchema.safeParse({ ...validUpdate, username: "Andre123" });
    expect(ascii.success).toBe(true);
    if (ascii.success) expect(ascii.data.username).toBe("andre123");
  });
});

describe("changePasswordSchema", () => {
  const validChange = {
    currentPassword: "oldpassword1",
    newPassword: "newpassword1",
    confirmPassword: "newpassword1",
  };

  it("accepts a valid password change", () => {
    expect(changePasswordSchema.safeParse(validChange).success).toBe(true);
  });

  it("rejects a new password under 8 characters", () => {
    const result = changePasswordSchema.safeParse({
      ...validChange,
      newPassword: "short1",
      confirmPassword: "short1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects mismatched confirmation", () => {
    const result = changePasswordSchema.safeParse({
      ...validChange,
      confirmPassword: "somethingelse1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty current password", () => {
    const result = changePasswordSchema.safeParse({ ...validChange, currentPassword: "" });
    expect(result.success).toBe(false);
  });
});

describe("registerSchema", () => {
  const validRegistration = {
    email: "New.Player@Example.com",
    password: "supersecret1",
    username: "newplayer",
    acceptedTerms: true as const,
  };

  it("accepts a valid signup and lowercases the email", () => {
    const result = registerSchema.safeParse(validRegistration);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.email).toBe("new.player@example.com");
  });

  it("rejects an invalid email", () => {
    const result = registerSchema.safeParse({ ...validRegistration, email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  it("rejects a password under 8 characters", () => {
    const result = registerSchema.safeParse({ ...validRegistration, password: "short1" });
    expect(result.success).toBe(false);
  });

  it("asks for no name: a name field is not part of sign-up (the display name starts as the username)", () => {
    expect(registerSchema.safeParse({ ...validRegistration, displayName: "New Player" }).success).toBe(false); // strict: not accepted, not silently kept
  });

  it("rejects a password over 72 characters (the limit the login provider enforces)", () => {
    expect(registerSchema.safeParse({ ...validRegistration, password: "x".repeat(73) }).success).toBe(false);
    expect(registerSchema.safeParse({ ...validRegistration, password: "x".repeat(72) }).success).toBe(true);
  });

  it("rejects a missing username — set atomically at signup, on the same screen", () => {
    const rest = { ...validRegistration } as Partial<typeof validRegistration>;
    delete rest.username;
    expect(registerSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an invalid username format", () => {
    const result = registerSchema.safeParse({ ...validRegistration, username: "no spaces!" });
    expect(result.success).toBe(false);
  });

  it("lowercases a mixed-case username", () => {
    const result = registerSchema.safeParse({ ...validRegistration, username: "NewPlayer" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.username).toBe("newplayer");
  });

  it("rejects when acceptedTerms is not true", () => {
    const result = registerSchema.safeParse({ ...validRegistration, acceptedTerms: false });
    expect(result.success).toBe(false);
  });

  it("rejects a missing acceptedTerms", () => {
    const rest = { ...validRegistration } as Partial<typeof validRegistration>;
    delete rest.acceptedTerms;
    expect(registerSchema.safeParse(rest).success).toBe(false);
  });
});

describe("registerFieldErrors — one message per field that is wrong", () => {
  const good = { email: "a@b.co", password: "supersecret1", username: "newplayer", acceptedTerms: true };

  it("is empty for a valid sign-up", () => {
    expect(registerFieldErrors(good)).toEqual({});
  });

  it("names every invalid field at once, in the field's own words", () => {
    expect(registerFieldErrors({ email: "nope", password: "short", username: "no spaces!", acceptedTerms: false })).toEqual(REGISTER_FIELD_MESSAGES);
  });

  it("flags only the fields that are wrong, so the rest of the form is left alone", () => {
    expect(Object.keys(registerFieldErrors({ ...good, acceptedTerms: false }))).toEqual(["acceptedTerms"]);
    expect(Object.keys(registerFieldErrors({ ...good, username: "ab" }))).toEqual(["username"]);
    expect(Object.keys(registerFieldErrors({ ...good, email: "" }))).toEqual(["email"]);
  });

  it("treats missing values (a hand-made POST) as invalid fields, never as a crash", () => {
    expect(Object.keys(registerFieldErrors({})).sort()).toEqual(["acceptedTerms", "email", "password", "username"]);
    expect(Object.keys(registerFieldErrors({ email: null, password: null, username: null, acceptedTerms: false })).sort()).toEqual(["acceptedTerms", "email", "password", "username"]);
  });
});
