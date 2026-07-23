import { z } from "zod";

export const createInvitationSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
  })
  .strict();

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const acceptInvitationSchema = z
  .object({
    token: z.string().uuid(),
    displayName: z.string().trim().min(1).max(60),
    password: z.string().min(8).max(72),
    acceptedRules: z.literal(true),
  })
  .strict();

export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
