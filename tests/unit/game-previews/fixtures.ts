import type { GamePreviewConfig } from "@/lib/game-previews/types";
import type { CandidateFact, GameIdentity } from "@/lib/game-previews/providers/types";

export const NOW = new Date("2026-10-17T20:00:00.000Z");

export const game: GameIdentity = {
  fixtureId: "11111111-1111-4111-8111-111111111111",
  sport: "american_football",
  competition: "NFL",
  homeTeam: "Indianapolis Colts",
  awayTeam: "Tennessee Titans",
  kickoffUtc: "2026-10-18T17:00:00.000Z",
  asOf: NOW.toISOString(),
};

export const config: GamePreviewConfig = {
  maxChars: 700,
  hookMaxChars: 120,
  leadHours: 48,
  staleAfterHours: 36,
  minRefreshIntervalHours: 6,
  generationEnabled: false,
  provider: "openai",
  model: "test-model",
  webSearchEnabled: true,
  verifyWithModel: true,
  maxAttempts: 2,
  maxGamesPerRun: 3,
  maxSearchCallsPerGame: 8,
  currentFactMaxAgeHours: 72,
  preferredDomains: ["espn.com", "nfl.com"],
  blockedDomains: ["reddit.com", "x.com"],
};

export const fact = (over: Partial<CandidateFact> = {}): CandidateFact => ({
  id: "f1",
  kind: "historical",
  claim: "Tennessee lost 26-3 to Houston on Oct. 11, falling to 0-5.",
  excerpt: "The Texans beat the Titans 26-3 ... Tennessee is 0-5.",
  sourceUrl: "https://www.espn.com/nfl/game/_/gameId/401872984",
  sourceProvider: "ESPN",
  sourceTitle: "Texans 26, Titans 3",
  publishedAt: "2026-10-11T22:00:00.000Z",
  retrievedAt: NOW.toISOString(),
  relevance: 0.9,
  gameAssociation: "Tennessee Titans' most recent game",
  ...over,
});

export const facts: CandidateFact[] = [
  fact(),
  fact({ id: "f2", claim: "Indianapolis beat Tennessee 41-20 and 38-14 in 2025.", excerpt: "Colts 41, Titans 20 (Sept. 21, 2025); Colts 38, Titans 14 (Oct. 26, 2025).", sourceUrl: "https://www.espn.com/nfl/team/schedule/_/name/ind/season/2025", sourceTitle: "Colts 2025 schedule" }),
  fact({ id: "f3", claim: "Indianapolis is 2-3 after a 34-22 loss at Pittsburgh.", excerpt: "Steelers 34, Colts 22. Indianapolis falls to 2-3.", kind: "historical", publishedAt: "2026-10-11T23:30:00.000Z", sourceUrl: "https://www.nfl.com/news/colts-steelers-recap", sourceProvider: "NFL.com", sourceTitle: "Steelers beat Colts" }),
];

export const goodDraft = {
  hook: "Zero wins in five. Indianapolis, you're up.",
  preview: "Tennessee is 0-5 after a 26-3 loss to Houston. Indianapolis is 2-3 after a 34-22 loss at Pittsburgh, but beat Tennessee 41-20 and 38-14 last season. Does the Titans' winless start end in Indianapolis?",
  claims: [
    { text: "Tennessee is 0-5 after a 26-3 loss to Houston.", factIds: ["f1"] },
    { text: "Indianapolis is 2-3 after a 34-22 loss at Pittsburgh.", factIds: ["f3"] },
    { text: "Indianapolis beat Tennessee 41-20 and 38-14 last season.", factIds: ["f2"] },
  ],
};
