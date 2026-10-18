import { describe, expect, it, vi } from "vitest";
import { generateGamePreview, type PipelineDeps } from "@/lib/game-previews/pipeline";
import { addUsage, emptyUsage, type GamePreviewProviders, type GamePreviewResearchProvider, type GamePreviewVerifierProvider, type GamePreviewWriterProvider, type PreviewDraft } from "@/lib/game-previews/providers/types";
import type { GenerationRunInput } from "@/lib/game-previews/repository";
import type { GamePreviewInput } from "@/lib/game-previews/types";
import { config, facts, game, goodDraft, NOW } from "./fixtures";

const usage = (o: Partial<ReturnType<typeof emptyUsage>> = {}) => ({ ...emptyUsage(), ...o });
const draftOf = (over: Partial<PreviewDraft> = {}): PreviewDraft => ({ ...goodDraft, promptVersion: "test-v1", usage: usage({ modelCalls: 1, inputTokens: 100, outputTokens: 50 }), ...over });

function setup(opts: { providers?: Partial<GamePreviewProviders>; config?: Partial<typeof config>; saved?: { outcome: string; previewId?: string }; loadGame?: PipelineDeps["loadGame"] } = {}) {
  const runs: GenerationRunInput[] = [];
  const saves: GamePreviewInput[] = [];
  const research = vi.fn<GamePreviewResearchProvider["research"]>(async () => ({ facts, usage: usage({ searchCalls: 4, modelCalls: 1, inputTokens: 900, outputTokens: 400 }) }));
  const write = vi.fn<GamePreviewWriterProvider["write"]>(async () => draftOf());
  const verify = vi.fn<GamePreviewVerifierProvider["verify"]>(async () => ({ supported: true, problems: [] as string[], usage: usage({ modelCalls: 1 }) }));
  const providers: GamePreviewProviders = {
    research: { name: "fake", research },
    writer: { name: "fake", write },
    verifier: { name: "fake", verify },
    ...opts.providers,
  };
  const deps: PipelineDeps = {
    config: { ...config, ...opts.config },
    providers,
    loadGame: opts.loadGame ?? (async () => game),
    save: async (input) => {
      saves.push(input);
      return (opts.saved ?? { outcome: "created", previewId: "preview-1" }) as { outcome: "created"; previewId: string };
    },
    recordRun: async (run) => {
      runs.push(run);
    },
    now: () => NOW,
  };
  return { deps, runs, saves, research, write, verify };
}
const req = { fixtureId: game.fixtureId, reason: "MISSING" as const, trigger: "ADMIN" as const };

describe("generateGamePreview", () => {
  it("researches first, then writes from those facts only, validates, verifies, and saves with claim-level provenance", async () => {
    const t = setup();
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("SUCCEEDED");
    expect(t.research).toHaveBeenCalledOnce();
    expect(t.research.mock.calls[0][1]).toMatchObject({ model: "test-model", maxSearchCalls: 8, preferredDomains: ["espn.com", "nfl.com"], blockedDomains: ["reddit.com", "x.com"] });
    expect(t.write.mock.calls[0][1]).toEqual(facts); // the writer sees the researched facts
    expect(t.verify).toHaveBeenCalledOnce();
    const saved = t.saves[0];
    expect(saved).toMatchObject({ fixtureId: game.fixtureId, reason: "MISSING", generatedBy: "fake:test-model" });
    expect(saved.sources.map((s) => s.url).sort()).toEqual(facts.map((f) => f.sourceUrl).sort()); // exactly the cited facts' sources
    expect(saved.sources.find((s) => s.provider === "ESPN" && s.title === "Texans 26, Titans 3")).toMatchObject({ excerpt: expect.stringContaining("26-3"), supports: expect.stringContaining("0-5") });
    expect(saved.claims).toHaveLength(3);
    expect(saved.claims![0]).toMatchObject({ fact_ids: ["f1"], source_urls: [facts[0].sourceUrl] });
    expect(saved.meta).toMatchObject({ provider: "openai", model: "test-model", promptVersion: "test-v1", verifiedByModel: true, attempts: 1 });
  });

  it("records every run with its usage (searches, model calls, tokens)", async () => {
    const t = setup();
    await generateGamePreview(t.deps, req);
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]).toMatchObject({ status: "SUCCEEDED", provider: "openai", model: "test-model", attempts: 1, searchCalls: 4, modelCalls: 3, inputTokens: 1000, outputTokens: 450, factsFound: 3, trigger: "ADMIN", previewId: "preview-1", error: null });
  });

  it("a draft with an unsupported figure is rejected, the writer is told why, and the corrected attempt is the one saved", async () => {
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async (_g, _f, ctx) => (ctx.feedback.length === 0 ? draftOf({ preview: goodDraft.preview.replace("26-3", "27-3") }) : draftOf()));
    const t = setup({ providers: { writer: { name: "fake", write } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("SUCCEEDED");
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][2].feedback.join(" ")).toMatch(/"27"/);
    expect(t.saves).toHaveLength(1);
    expect(t.saves[0].body).toContain("26-3");
    expect(t.runs[0].attempts).toBe(2);
  });

  it("when every attempt is rejected NOTHING is saved, the run is recorded as REJECTED, and the problems are reported", async () => {
    const bad = draftOf({ preview: goodDraft.preview.replace("26-3", "27-3") });
    const t = setup({ providers: { writer: { name: "fake", write: async () => bad } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out).toMatchObject({ status: "REJECTED", error: "draft_rejected" });
    expect(out.status !== "SUCCEEDED" && out.problems.join(" ")).toMatch(/"27"/);
    expect(t.saves).toHaveLength(0);
    expect(t.runs[0]).toMatchObject({ status: "REJECTED", attempts: 2 });
  });

  it("the independent fact-check can reject a draft the built-in checks passed", async () => {
    const verify = vi.fn<GamePreviewVerifierProvider["verify"]>(async () => ({ supported: false, problems: ["'unbeaten at home' is not in the facts"], usage: usage({ modelCalls: 1 }) }));
    const t = setup({ providers: { verifier: { name: "fake", verify } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("REJECTED");
    expect(verify).toHaveBeenCalledTimes(2);
    expect(t.saves).toHaveLength(0);
  });

  it("works without the optional verifier (the built-in checks still run)", async () => {
    const t = setup({ providers: { verifier: null } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
  });

  it("refuses before any external call when no model is configured, or when web search is off (research is mandatory)", async () => {
    for (const [override, error] of [[{ model: " " }, "model_not_configured"], [{ webSearchEnabled: false }, "web_search_disabled"]] as const) {
      const t = setup({ config: override });
      const out = await generateGamePreview(t.deps, req);
      expect(out).toMatchObject({ status: "FAILED", error });
      expect(t.research).not.toHaveBeenCalled();
      expect(t.saves).toHaveLength(0);
      expect(t.runs[0].status).toBe("FAILED");
    }
  });

  it("fails cleanly — and saves nothing — when research finds no verified facts, did not actually search, or errors", async () => {
    let t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [], usage: usage({ searchCalls: 3, modelCalls: 1 }) }) } } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error: "no_verified_facts" });
    t = setup({ providers: { research: { name: "fake", research: async () => ({ facts, usage: usage({ searchCalls: 0, modelCalls: 1 }) }) } } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error: "research_did_not_search" });
    t = setup({ providers: { research: { name: "fake", research: async () => { throw new Error("boom"); } } } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error: "research_failed: boom" });
    expect(t.write).not.toHaveBeenCalled();
    expect(t.saves).toHaveLength(0);
  });

  it("does nothing for a Game that is not eligible (started or unknown) — and never researches it", async () => {
    const t = setup({ loadGame: async () => null });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error: "game_not_eligible" });
    expect(t.research).not.toHaveBeenCalled();
  });

  it("reports why the database refused the write (the Game started meanwhile, or the refresh rules said no) and records it", async () => {
    const t = setup({ saved: { outcome: "game_started" } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error: "not_saved: game_started" });
    expect(t.runs[0]).toMatchObject({ status: "FAILED", error: "not_saved: game_started", previewId: null });
  });

  it("a failure to record the run never turns a finished run into a failure", async () => {
    const t = setup();
    t.deps.recordRun = async () => {
      throw new Error("db down");
    };
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
  });

  it("the number of attempts is configuration", async () => {
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async () => draftOf({ claims: [] }));
    const t = setup({ config: { maxAttempts: 3 }, providers: { writer: { name: "fake", write } } });
    await generateGamePreview(t.deps, req);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("usage helpers add up", () => {
    expect(addUsage(usage({ searchCalls: 1, modelCalls: 2 }), usage({ searchCalls: 3, inputTokens: 5 }))).toEqual({ searchCalls: 4, modelCalls: 2, inputTokens: 5, outputTokens: 0 });
  });
});
