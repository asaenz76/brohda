import { describe, expect, it, vi } from "vitest";
import { generateGamePreview, type PipelineDeps } from "@/lib/game-previews/pipeline";
import { addUsage, emptyUsage, type GamePreviewAngleProvider, type GamePreviewProviders, type GamePreviewResearchProvider, type GamePreviewVerifierProvider, type GamePreviewWriterProvider, type PreviewDraft } from "@/lib/game-previews/providers/types";
import type { GenerationRunInput } from "@/lib/game-previews/repository";
import type { GamePreviewInput } from "@/lib/game-previews/types";
import { config, facts, game, goodDraft, NOW, selection } from "./fixtures";

const usage = (o: Partial<ReturnType<typeof emptyUsage>> = {}) => ({ ...emptyUsage(), ...o });
const draftOf = (over: Partial<PreviewDraft> = {}): PreviewDraft => ({ ...goodDraft, promptVersion: "test-v1", usage: usage({ modelCalls: 1, inputTokens: 100, outputTokens: 50 }), ...over });
const sources = [{ url: facts[0].sourceUrl, title: "Texans 26, Titans 3", status: "accepted" as const }, { url: "https://x.com/a", title: "a post", status: "rejected" as const, reason: "blocked domain" }];

function setup(opts: { providers?: Partial<GamePreviewProviders>; config?: Partial<typeof config>; saved?: { outcome: string; previewId?: string }; loadGame?: PipelineDeps["loadGame"] } = {}) {
  const runs: GenerationRunInput[] = [];
  const saves: GamePreviewInput[] = [];
  const research = vi.fn<GamePreviewResearchProvider["research"]>(async () => ({ facts, sources, usage: usage({ searchCalls: 3, modelCalls: 1, inputTokens: 900, outputTokens: 400 }) }));
  const selectAngle = vi.fn<GamePreviewAngleProvider["selectAngle"]>(async () => ({ ...selection, usage: usage({ modelCalls: 1, inputTokens: 300, outputTokens: 200 }) }));
  const write = vi.fn<GamePreviewWriterProvider["write"]>(async () => draftOf());
  const verify = vi.fn<GamePreviewVerifierProvider["verify"]>(async () => ({ supported: true, editorialPasses: true, problems: [], usage: usage({ modelCalls: 1 }) }));
  const providers: GamePreviewProviders = { research: { name: "fake", research }, angles: { name: "fake", selectAngle }, writer: { name: "fake", write }, verifier: { name: "fake", verify }, ...opts.providers };
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
  return { deps, runs, saves, research, selectAngle, write, verify };
}
const req = { fixtureId: game.fixtureId, reason: "MISSING" as const, trigger: "ADMIN" as const };

describe("generateGamePreview — research, then a story, then a draft", () => {
  it("runs the stages in order: research → candidate angles → the chosen story → draft → validation → verification → save", async () => {
    const t = setup();
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("SUCCEEDED");
    expect(t.research.mock.calls[0][1]).toMatchObject({ model: "test-model", effort: "medium", maxSearchCalls: config.maxSearchCallsPerGame, webSearchToolVersion: "web_search_20250305", blockedDomains: ["reddit.com", "x.com"] });
    expect(t.selectAngle.mock.calls[0][1]).toEqual(facts); // angles come from the verified facts
    const [, angleArg, factsArg, ctx] = t.write.mock.calls[0];
    expect(angleArg.id).toBe("a1"); // the writer is told the chosen story
    expect(factsArg).toEqual(facts);
    expect(ctx).toMatchObject({ maxChars: 700, hookMaxChars: 120, maxCitedFacts: 4, effort: "medium", feedback: [] });
    expect(t.verify).toHaveBeenCalledOnce();
    expect(t.saves).toHaveLength(1);
  });

  it("saves claim-level provenance and the decision record: chosen angle, candidate angles, effort, tool version", async () => {
    const t = setup();
    await generateGamePreview(t.deps, req);
    const saved = t.saves[0];
    expect(saved).toMatchObject({ generatedBy: "fake:test-model", reason: "MISSING" });
    expect(saved.sources.map((s) => s.url).sort()).toEqual(facts.map((f) => f.sourceUrl).sort());
    expect(saved.claims![0]).toMatchObject({ fact_ids: ["f1"], source_urls: [facts[0].sourceUrl] });
    expect(saved.meta).toMatchObject({ provider: "anthropic", model: "test-model", effort: "medium", webSearchToolVersion: "web_search_20250305", promptVersion: "test-v1", attempts: 1, verifiedByModel: true });
    expect((saved.meta as { angle: { id: string; type: string } }).angle).toMatchObject({ id: "a1", type: "CONTRAST", overridden: false });
    expect((saved.meta as { candidateAngles: unknown[] }).candidateAngles).toHaveLength(3);
  });

  it("records every run with usage AND what it found and decided (sources, facts, angles, rejections)", async () => {
    const t = setup();
    await generateGamePreview(t.deps, req);
    const run = t.runs[0];
    expect(run).toMatchObject({ status: "SUCCEEDED", provider: config.provider, model: "test-model", effort: "medium", toolVersion: "web_search_20250305", attempts: 1, searchCalls: 3, modelCalls: 4, inputTokens: 1300, outputTokens: 650, factsFound: 3, previewId: "preview-1", error: null });
    const d = run.details as { sources: { reached: number; accepted: number; rejected: number }; angles: unknown[]; chosenAngleId: string; selectedAngleId: string; rejectedAngles: unknown[]; attemptsLog: Array<{ provenanceProblems: string[] }>; rewrites: number };
    expect(d.sources).toMatchObject({ reached: 2, accepted: 1, rejected: 1 });
    expect(d.angles).toHaveLength(3);
    expect(d).toMatchObject({ chosenAngleId: "a1", selectedAngleId: "a1", rewrites: 0 });
    expect(d.rejectedAngles).toHaveLength(2);
    expect(d.attemptsLog).toHaveLength(1);
  });

  it("a records-only choice is overridden by a real story, and the writer is given the story, not the fallback", async () => {
    const t = setup({ providers: { angles: { name: "fake", selectAngle: async () => ({ ...selection, selectedId: "a2", selectionReason: "simple", usage: usage({ modelCalls: 1 }) }) } } });
    await generateGamePreview(t.deps, req);
    expect(t.write.mock.calls[0][1].id).toBe("a1");
    expect(t.runs[0].details).toMatchObject({ selectedAngleId: "a2", chosenAngleId: "a1", angleOverridden: true });
  });

  it("an unsupported figure is rejected and the corrected rewrite is the one saved", async () => {
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async (_g, _a, _f, ctx) => (ctx.feedback.length === 0 ? draftOf({ preview: goodDraft.preview.replace("26-3", "27-3") }) : draftOf()));
    const t = setup({ providers: { writer: { name: "fake", write } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("SUCCEEDED");
    expect(write.mock.calls[1][3].feedback.join(" ")).toMatch(/"27"/);
    expect(t.saves[0].body).toContain("26-3");
    const d = t.runs[0].details as { attemptsLog: Array<{ provenanceProblems: string[] }>; rewrites: number };
    expect(d.attemptsLog[0].provenanceProblems.join(" ")).toMatch(/"27"/);
    expect(d.rewrites).toBe(1);
  });

  it("an EDITORIAL rejection (a hook that merely states a record) is fed back and rewritten, never published", async () => {
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async (_g, _a, _f, ctx) => (ctx.feedback.length === 0 ? draftOf({ hook: "Tennessee is 0-5, Indianapolis is 2-3" }) : draftOf()));
    const t = setup({ providers: { writer: { name: "fake", write } } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(write.mock.calls[1][3].feedback.join(" ")).toMatch(/states a record or score/);
    expect(t.saves[0].hook).toBe(goodDraft.hook);
  });

  it("when every attempt is rejected NOTHING is saved, the run is REJECTED, and the reasons are reported", async () => {
    const bad = draftOf({ hook: "Tennessee is 0-5, Indianapolis is 2-3" });
    const t = setup({ providers: { writer: { name: "fake", write: async () => bad } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out).toMatchObject({ status: "REJECTED", error: "draft_rejected" });
    expect(out.status !== "SUCCEEDED" && out.problems.join(" ")).toMatch(/states a record or score/);
    expect(t.saves).toHaveLength(0);
    expect(t.runs[0]).toMatchObject({ status: "REJECTED", attempts: 2 });
    expect((t.runs[0].details as { attemptsLog: unknown[] }).attemptsLog).toHaveLength(2);
  });

  it("the independent read can reject a draft the deterministic checks passed (unsupported OR not a story)", async () => {
    for (const verdict of [{ supported: false, editorialPasses: true }, { supported: true, editorialPasses: false }]) {
      const verify = vi.fn<GamePreviewVerifierProvider["verify"]>(async () => ({ ...verdict, problems: ["the hook would not stop the scroll"], usage: usage({ modelCalls: 1 }) }));
      const t = setup({ providers: { verifier: { name: "fake", verify } } });
      expect((await generateGamePreview(t.deps, req)).status).toBe("REJECTED");
      expect(verify).toHaveBeenCalledTimes(2);
      expect(t.saves).toHaveLength(0);
    }
  });

  it("the verifier is not even called when the deterministic checks already failed", async () => {
    const t = setup({ providers: { writer: { name: "fake", write: async () => draftOf({ claims: [] }) } } });
    await generateGamePreview(t.deps, req);
    expect(t.verify).not.toHaveBeenCalled();
  });

  it("works without the optional verifier (the deterministic checks still run)", async () => {
    const t = setup({ providers: { verifier: null } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
  });

  it("refuses before any external call when no model is configured, or when web search is off (research is mandatory)", async () => {
    for (const [override, error] of [[{ model: " " }, "model_not_configured"], [{ webSearchEnabled: false }, "web_search_disabled"]] as const) {
      const t = setup({ config: override });
      expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error });
      expect(t.research).not.toHaveBeenCalled();
      expect(t.saves).toHaveLength(0);
      expect(t.runs[0].status).toBe("FAILED");
    }
  });

  it("weak research never becomes a manufactured story: no facts, no search, or a provider error all fail cleanly before any writing", async () => {
    let t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) } } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error: "no_verified_facts" });
    t = setup({ providers: { research: { name: "fake", research: async () => ({ facts, sources, usage: usage({ searchCalls: 0, modelCalls: 1 }) }) } } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error: "research_did_not_search" });
    t = setup({ providers: { research: { name: "fake", research: async () => { throw new Error("anthropic_api_529: overloaded"); } } } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error: "research_failed: anthropic_api_529: overloaded" });
    expect(t.selectAngle).not.toHaveBeenCalled();
    expect(t.write).not.toHaveBeenCalled();
    expect(t.saves).toHaveLength(0);
  });

  it("malformed candidate angles reject the run before anything is written", async () => {
    const t = setup({ providers: { angles: { name: "fake", selectAngle: async () => ({ ...selection, angles: selection.angles.slice(0, 2), usage: usage() }) } } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED", error: "angle_selection_invalid" });
    expect(t.write).not.toHaveBeenCalled();
    expect(t.saves).toHaveLength(0);
  });

  it("a provider failure in any later stage fails the run and saves nothing", async () => {
    let t = setup({ providers: { angles: { name: "fake", selectAngle: async () => { throw new Error("boom"); } } } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error: "angle_selection_failed: boom" });
    t = setup({ providers: { writer: { name: "fake", write: async () => { throw new Error("boom"); } } } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error: "writer_failed: boom" });
    t = setup({ providers: { verifier: { name: "fake", verify: async () => { throw new Error("boom"); } } } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error: "verifier_failed: boom" });
    expect(t.saves).toHaveLength(0);
  });

  it("does nothing for a Game that is not eligible (started or unknown) — and never researches it", async () => {
    const t = setup({ loadGame: async () => null });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error: "game_not_eligible" });
    expect(t.research).not.toHaveBeenCalled();
  });

  it("reports why the database refused the write and records it", async () => {
    const t = setup({ saved: { outcome: "game_started" } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error: "not_saved: game_started" });
    expect(t.runs[0]).toMatchObject({ status: "FAILED", error: "not_saved: game_started", previewId: null });
  });

  it("a failure to record the run never turns a finished run into a failure; attempts and effort are configuration", async () => {
    const t = setup({ config: { maxAttempts: 3, effort: "high" } });
    t.deps.recordRun = async () => {
      throw new Error("db down");
    };
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(t.write.mock.calls[0][3].effort).toBe("high");
    const bad = setup({ config: { maxAttempts: 3 }, providers: { writer: { name: "fake", write: async () => draftOf({ claims: [] }) } } });
    await generateGamePreview(bad.deps, req);
    expect(bad.runs[0].attempts).toBe(3);
  });

  it("usage helpers add up", () => {
    expect(addUsage(usage({ searchCalls: 1, modelCalls: 2 }), usage({ searchCalls: 3, inputTokens: 5 }))).toEqual({ searchCalls: 4, modelCalls: 2, inputTokens: 5, outputTokens: 0 });
  });
});
