import { z } from "zod";

// Deliberately excludes 'super_admin' — minting a new super admin stays a
// manual/create-super-admin-script action, not a UI dropdown one accidental
// click away.
export const setUserRoleSchema = z
  .object({
    userId: z.string().uuid(),
    role: z.enum(["player", "admin"]),
  })
  .strict();

export type SetUserRoleInput = z.infer<typeof setUserRoleSchema>;

// Mirrors createInvitationSchema's email handling — always lands as role
// 'player', same as an accepted invitation; promoting stays a separate,
// deliberate setUserRoleAction step.
export const createUserManuallySchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    displayName: z.string().trim().min(1).max(60),
  })
  .strict();

export type CreateUserManuallyInput = z.infer<typeof createUserManuallySchema>;
