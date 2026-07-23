import { z } from "zod";

export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60),
    // Required, not just format-validated — every user must choose a
    // handle (spec: onboarding forces this before anything else), and once
    // set it can never be cleared back to empty via this form again.
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_]{3,24}$/, "3-24 lowercase letters, numbers, or underscores"),
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

// Self-service signup — deliberately narrower than acceptInvitationSchema
// (no username here): the new account still lands on the same forced
// "complete your profile" redirect as every other creation path, which is
// where username actually gets collected.
export const registerSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(8).max(72),
    displayName: z.string().trim().min(1).max(60),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
