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

// Self-service signup, collected as a 4-step wizard (register-form.tsx) —
// username is set here, atomically with account creation, rather than via
// a separate forced "complete your profile" step afterward (the old flow's
// post-signup notice went unread and left people stuck). Same username
// format rule as updateProfileSchema; acceptedTerms mirrors
// acceptInvitationSchema's acceptedRules pattern.
export const registerSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(8).max(72),
    displayName: z.string().trim().min(1).max(60),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_]{3,24}$/, "3-24 lowercase letters, numbers, or underscores"),
    acceptedTerms: z.literal(true),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
