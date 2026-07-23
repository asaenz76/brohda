import { z } from "zod";

export const toggleLikeSchema = z
  .object({
    poolId: z.string().uuid(),
  })
  .strict();

export type ToggleLikeInput = z.infer<typeof toggleLikeSchema>;
