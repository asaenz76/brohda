import { z } from "zod";

export const toggleFollowSchema = z
  .object({
    followeeId: z.string().uuid(),
  })
  .strict();

export type ToggleFollowInput = z.infer<typeof toggleFollowSchema>;
