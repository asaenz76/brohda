import { z } from "zod";
import type { TemplateFixtureScore } from "./types";

// Shared by every template that lets the admin pick which side of the
// fixture the question is about — only 2 valid values since a fixture only
// ever has 2 teams. Sport-agnostic (not football-specific): NFL's own
// spread/team-total templates and nfl-odds.ts's line estimation use this
// same type.
export const teamSideSchema = z.enum(["HOME", "AWAY"]);
export type TeamSide = z.infer<typeof teamSideSchema>;

export function teamName(fixture: TemplateFixtureScore, side: TeamSide): string {
  return side === "HOME" ? fixture.homeTeamName : fixture.awayTeamName;
}
