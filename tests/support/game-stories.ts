// Test support for the Game Story Engine: a canonical Game, evidence builders and scriptable fake providers (no network, no model).
import { randomUUID } from "node:crypto";
import type { PipelineDeps } from "@/lib/game-stories/pipeline";
import { addUsage, emptyUsage, type Angle, type Draft, type DraftClaim, type EvidenceItem, type GameContext, type ModelClaimVerdict, type ModelScore, type RawEvidence, type StoryConfig } from "@/lib/game-stories/types";

export const NOW = new Date("2026-10-26T12:00:00.000Z");
export const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();

export const game = (over: Partial<GameContext> = {}): GameContext => ({
  fixtureId: "11111111-1111-4111-8111-111111111111",
  postId: "22222222-2222-4222-8222-222222222222",
  sport: "basketball",
  competition: "NBA",
  season: "2026",
  homeTeam: "Boston Celtics",
  awayTeam: "New York Knicks",
  kickoffUtc: "2026-10-27T00:00:00.000Z",
  homeTeamExternalId: null,
  awayTeamExternalId: null,
  ...over,
});

export const config = (over: Partial<StoryConfig> = {}): StoryConfig => ({
  generationEnabled: true,
  autoPublishEnabled: false,
  provider: "anthropic",
  model: "test-model",
  effort: "medium",
  webSearchToolVersion: "web_search_20250305",
  webSearchEnabled: true,
  maxChars: 300,
  minScore: 80,
  researchWindowHours: 48,
  refreshIntervalMinutes: 360,
  editorialCutoffMinutes: 120,
  maxQueriesPerGame: 6,
  maxSources: 12,
  maxAttempts: 2,
  providerRetries: 1,
  requestTimeoutSeconds: 120,
  maxGamesPerRun: 2,
  maxRunsPerGame: 3,
  statusMaxAgeHours: 48,
  currentFactMaxAgeHours: 168,
  supportedSports: ["american_football", "basketball", "hockey"],
  preferredDomains: [],
  blockedDomains: [],
  ...over,
});

let seq = 0;
export const id = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** A usable evidence item (a major-journalism article by default). */
export const ev = (over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id: id(),
  kind: "MAJOR_JOURNALISM",
  authority: 75,
  canonicalId: `espn.com/story/${randomUUID()}`,
  url: "https://www.espn.com/nba/story/_/id/1",
  publisher: "ESPN",
  title: "Report",
  publishedAt: hoursAgo(6),
  retrievedAt: NOW.toISOString(),
  evidenceType: "ARTICLE",
  factKey: null,
  factValue: null,
  subjectTeam: "BOTH",
  factText: "A statement.",
  excerpt: null,
  asOf: null,
  status: "USABLE",
  statusReason: null,
  ...over,
});

export const structuredEv = (over: Partial<EvidenceItem> = {}): EvidenceItem =>
  ev({ kind: "STRUCTURED_DATA", authority: 95, evidenceType: "STRUCTURED", publisher: "Brohda game data", url: null, publishedAt: null, canonicalId: `brohda:fixtures:x:${randomUUID()}`, asOf: hoursAgo(30), ...over });

export const claim = (over: Partial<DraftClaim> & { evidenceIds: string[] }): DraftClaim => ({
  id: id(),
  text: "A claim.",
  type: "CONTEXT",
  subjectTeam: null,
  availabilityStatus: null,
  quote: null,
  ...over,
});

export const raw = (over: Partial<RawEvidence> = {}): RawEvidence => ({
  url: "https://www.espn.com/nba/story/_/id/99",
  publisher: "ESPN",
  title: "A report",
  publishedAt: hoursAgo(5),
  evidenceType: "ARTICLE",
  factKey: null,
  factValue: null,
  subjectTeam: "BOTH",
  factText: "A reported fact.",
  excerpt: null,
  asOf: null,
  ...over,
});

export const GOOD_SCORE: ModelScore = { dims: { relevance: 27, evidence: 23, debate: 17, originality: 13, freshness: 9 }, generic: false, safetyFlags: [], rationale: "Specific, evidenced, divisive." };

export interface Script {
  raw?: RawEvidence[];
  researchError?: Error;
  angles?: Angle[] | ((evidence: EvidenceItem[]) => Angle[]);
  /** One draft per call, in order (the last repeats). */
  drafts?: Array<Draft | ((evidence: EvidenceItem[]) => Draft)>;
  verdicts?: (claims: DraftClaim[]) => ModelClaimVerdict[];
  score?: ModelScore | ((n: number) => ModelScore);
  extracted?: DraftClaim[];
  providerError?: Error;
}

export interface Calls { research: number; angles: number; draft: number; verify: number; score: number }

export function fakeDeps(script: Script = {}, clock: () => Date = () => NOW): { deps: PipelineDeps; calls: Calls } {
  const calls: Calls = { research: 0, angles: 0, draft: 0, verify: 0, score: 0 };
  const usage = { ...emptyUsage(), modelCalls: 1, inputTokens: 100, outputTokens: 50 };
  const deps: PipelineDeps = {
    now: clock,
    newId: () => randomUUID(),
    research: {
      async research() {
        calls.research++;
        if (script.researchError) throw script.researchError;
        return { items: script.raw ?? [], usage: addUsage(usage, { ...emptyUsage(), searchCalls: 3 }), queriesUsed: 3 };
      },
    },
    angles: {
      async propose(_g, evidence) {
        calls.angles++;
        if (script.providerError) throw script.providerError;
        const a = typeof script.angles === "function" ? script.angles(evidence) : (script.angles ?? [{ type: "RECENT_FORM", summary: "A story", evidenceIds: evidence.slice(0, 2).map((e) => e.id) }]);
        return { angles: a, usage };
      },
    },
    drafter: {
      async draft(_g, _a, evidence) {
        const d = script.drafts?.[Math.min(calls.draft, (script.drafts?.length ?? 1) - 1)];
        calls.draft++;
        if (!d) throw new Error("no draft scripted");
        return { draft: typeof d === "function" ? d(evidence) : d, usage };
      },
      async extractClaims() {
        return { claims: script.extracted ?? [], usage };
      },
    },
    verifier: {
      async verifyClaims(_g, claims) {
        calls.verify++;
        const v = script.verdicts ? script.verdicts(claims) : claims.map((c) => ({ claimId: c.id, verdict: "SUPPORTED" as const, note: "ok" }));
        return { verdicts: v, usage };
      },
    },
    scorer: {
      async score() {
        calls.score++;
        const s = typeof script.score === "function" ? script.score(calls.score) : (script.score ?? GOOD_SCORE);
        return { score: s, usage };
      },
    },
  };
  return { deps, calls };
}
