import { z } from "zod";
import type { PoolTemplate } from "./types";
import { validGoals } from "./event-helpers";

export const playerToScoreConfigSchema = z
  .object({ playerExternalId: z.string().min(1), playerName: z.string().trim().min(1).max(150) })
  .strict();
export type PlayerToScoreConfig = z.infer<typeof playerToScoreConfigSchema>;

export const playerToScore: PoolTemplate<PlayerToScoreConfig> = {
  id: "PLAYER_TO_SCORE",
  version: 1,
  activeForCreation: true,
  category: "PLAYER_PROPS",
  name: "Player to score",
  description: "Will the selected player score a valid goal?",
  questionBuilder: (_fixture, config) => `Will ${config.playerName} score?`,
  requiredConfigFields: [{ key: "player", label: "Player", type: "PLAYER" }],
  requiredDataSources: ["FIXTURE_EVENTS"],
  availabilityCheck: () => ({ available: true }),
  gradingRule: (data, config) => {
    // Own goals never count as a goal scored BY the selected player — the
    // credited team benefits, but the scoring player is on the other side.
    // Non-participants (never appear in the events at all) grade NO, per
    // spec's own recommended default — kept simple, no per-pool void
    // policy toggle for this single template.
    const goals = validGoals(data.events ?? []).filter((e) => e.detail !== "GOAL_OWN");
    const scored = goals.find((e) => e.playerExternalId === config.playerExternalId);
    const yes = Boolean(scored);
    return {
      result: yes ? "YES" : "NO",
      reason: yes
        ? `${config.playerName} scored (minute ${scored!.effectiveMinute}).`
        : `${config.playerName} did not score a valid goal.`,
      evidence: yes
        ? [{ source: "FIXTURE_EVENTS", field: "player_external_id", rawValue: scored!.playerExternalId, normalizedValue: scored!.playerExternalId }]
        : [],
    };
  },
};
