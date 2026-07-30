import { z } from "zod";

export const toggleTeamFollowSchema = z
  .object({
    teamId: z.string().uuid(),
  })
  .strict();

export const updateTeamFollowEmailSchema = z
  .object({
    teamId: z.string().uuid(),
    emailEnabled: z.boolean(),
  })
  .strict();

export const toggleLeagueFollowSchema = z
  .object({
    leagueId: z.string().uuid(),
  })
  .strict();

export const updateLeagueFollowEmailSchema = z
  .object({
    leagueId: z.string().uuid(),
    emailEnabled: z.boolean(),
  })
  .strict();
