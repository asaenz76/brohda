import { z } from "zod";

export const fixtureSearchSchema = z
  .object({
    mode: z.enum(["by_id", "by_league", "by_team"]),
    externalFixtureId: z.string().trim().min(1).optional(),
    competitionExternalId: z.string().trim().min(1).optional(),
    teamExternalId: z.string().trim().min(1).optional(),
    season: z
      .string()
      .trim()
      .regex(/^\d{4}$/)
      .optional(),
    date: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.mode === "by_id") return !!data.externalFixtureId;
      if (data.mode === "by_team") return !!data.teamExternalId;
      return !!data.competitionExternalId && !!data.season;
    },
    { message: "Enter a fixture ID, a league and season, or a team." },
  );

export type FixtureSearchInput = z.infer<typeof fixtureSearchSchema>;

export const teamSearchSchema = z.object({ query: z.string().trim().min(1) }).strict();

export type TeamSearchInput = z.infer<typeof teamSearchSchema>;

// Bulk import is capped at 50 per request — a sanity bound, not a real
// expected volume (a single league/date search realistically returns a
// handful of fixtures).
export const importFixturesSchema = z.array(z.string().trim().min(1)).min(1).max(50);

export type ImportFixturesInput = z.infer<typeof importFixturesSchema>;

// Bulk hide/unhide from the "Create a pool" dropdown — a sanity bound sized
// for clearing out a backlog of leftover test/abandoned fixtures in one go,
// not a real expected volume of legitimate imports.
export const setFixturesHiddenSchema = z.array(z.string().uuid()).min(1).max(500);

export type SetFixturesHiddenInput = z.infer<typeof setFixturesHiddenSchema>;
