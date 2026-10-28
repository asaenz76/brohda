import { z } from "zod";

export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60),
    // Optional here, not required: once a username is set it's permanent
    // (see updateProfileAction), so ProfileForm renders it `disabled` at
    // that point — and a disabled field is excluded from FormData
    // entirely, so this can't be `required` without breaking every other
    // edit a user with a username already makes. Still format-validated
    // when present (the one-time initial set, or a resubmission of the
    // still-enabled field).
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_]{3,24}$/, "3-24 lowercase letters, numbers, or underscores")
      .optional(),
    pronouns: z.string().trim().max(30).optional().or(z.literal("")),
    gender: z.string().trim().max(30).optional().or(z.literal("")),
    bio: z.string().trim().max(150).optional().or(z.literal("")),
    showPronouns: z.boolean(),
    showGender: z.boolean(),
    showBio: z.boolean(),
  })
  .strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword: z.string().min(8, "New password must be at least 8 characters."),
    confirmPassword: z.string().min(1),
  })
  .strict()
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "New passwords do not match.",
    path: ["confirmPassword"],
  });

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

// Self-service signup (register-form.tsx): ONE screen — email, password, username and the Terms. Username is set here, atomically with account creation, because a Member without one is held at /profile by the proxy (lib/auth/profile-gate.ts) and
// every public surface (profile link, Pick and Call BS attribution) needs it. There is no name field: display_name starts as the username and is editable in Profile. Same username format rule as updateProfileSchema.
export const registerSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(8).max(72),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_]{3,24}$/, "3-24 lowercase letters, numbers, or underscores"),
    acceptedTerms: z.literal(true),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;

export type RegisterField = "email" | "password" | "username" | "acceptedTerms";

/** One short, actionable message per field that failed — what the sign-up form shows next to the field (never a generic "check your details"). */
export const REGISTER_FIELD_MESSAGES: Record<RegisterField, string> = {
  email: "Enter a valid email address.",
  password: "Use 8 to 72 characters.",
  username: "Use 3 to 24 letters, numbers or underscores.",
  acceptedTerms: "Agree to the Terms and Policy to create your account.",
};

/** Which fields of a registration attempt are invalid, from the schema's own verdict. */
export function registerFieldErrors(input: unknown): Partial<Record<RegisterField, string>> {
  const result = registerSchema.safeParse(input);
  if (result.success) return {};
  const errors: Partial<Record<RegisterField, string>> = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (field === "email" || field === "password" || field === "username" || field === "acceptedTerms") errors[field] ??= REGISTER_FIELD_MESSAGES[field];
  }
  return errors;
}
