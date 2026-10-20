import { describe, expect, it, vi } from "vitest";
import { generateGamePreview, verificationReserve, type PipelineDeps } from "@/lib/game-previews/pipeline";
import { addUsage, emptyUsage, type FactCheck, type GamePreviewAngleProvider, type GamePreviewFactVerifierProvider, type GamePreviewProviders, type GamePreviewResearchProvider, type GamePreviewVerifierProvider, type GamePreviewWriterProvider, type PreviewDraft } from "@/lib/game-previews/providers/types";
import type { GenerationRunInput } from "@/lib/game-previews/repository";
import type { GamePreviewInput } from "@/lib/game-previews/types";
import { config, fact, facts, game, goodDraft, NOW, selection } from "./fixtures";

const usage = (o: Partial<ReturnType<typeof emptyUsage>> = {}) => ({ ...emptyUsage(), ...o });
const draftOf = (over: Partial<PreviewDraft> = {}): PreviewDraft => ({ ...goodDraft, promptVersion: "test-v1", usage: usage({ modelCalls: 1, inputTokens: 100, outputTokens: 50 }), ...over });
const sources = [{ url: facts[0].sourceUrl, title: "Texans 26, Titans 3", status: "accepted" as const }, { url: "https://x.com/a", title: "a post", status: "rejected" as const, reason: "blocked domain" }];

function setup(opts: { providers?: Partial<GamePreviewProviders>; config?: Partial<typeof config>; saved?: { outcome: string; previewId?: string }; loadGame?: PipelineDeps["loadGame"] } = {}) {
  const runs: GenerationRunInput[] = [];
  const saves: GamePreviewInput[] = [];
  const research = vi.fn<GamePreviewResearchProvider["research"]>(async () => ({ facts, sources, usage: usage({ searchCalls: 3, modelCalls: 1, inputTokens: 900, outputTokens: 400 }) }));
  const selectAngle = vi.fn<GamePreviewAngleProvider["selectAngle"]>(async () => ({ ...selection, usage: usage({ modelCalls: 1, inputTokens: 300, outputTokens: 200 }) }));
  // A writer that cites only the facts of the story it is given (a story may have lost a fact that failed verification).
  const write = vi.fn<GamePreviewWriterProvider["write"]>(async (_g, angle) => draftOf({ claims: goodDraft.claims.filter((c) => c.factIds.every((id) => angle.factIds.includes(id))) }));
  const verify = vi.fn<GamePreviewVerifierProvider["verify"]>(async () => ({ blocking: [], advisory: [], usage: usage({ modelCalls: 1 }) }));
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
    expect(ctx).toMatchObject({ maxChars: 700, maxCitedFacts: 4, effort: "medium", feedback: [] });
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

  it("an unsupported figure is a HINT for the reviewer, which blocks it; the corrected rewrite is the one saved", async () => {
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async (_g, _a, _f, ctx) => (ctx.feedback.length === 0 ? draftOf({ preview: goodDraft.preview.replace("26-3", "27-3") }) : draftOf()));
    const verify = vi.fn<GamePreviewVerifierProvider["verify"]>(async (_g, _a, d) => ({ blocking: d.preview.includes("27-3") ? [{ category: "wrong_figure" as const, problem: 'The score "27-3" is not in the facts.' }] : [], advisory: [], usage: usage({ modelCalls: 1 }) }));
    const t = setup({ providers: { writer: { name: "fake", write }, verifier: { name: "fake", verify } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("SUCCEEDED");
    expect(verify.mock.calls[0][5]?.figures).toContain("27"); // code tells the reviewer where to look
    expect(write.mock.calls[1][3].feedback.join(" ")).toMatch(/27-3/);
    expect(t.saves[0].body).toContain("26-3");
    const d = t.runs[0].details as { attemptsLog: Array<{ reviewerBlocking?: unknown[] }>; rewrites: number };
    expect(d.rewrites).toBe(1);
  });

  it("a deterministic ADVISORY (more facts cited than the guidance) is never a rejection: ONE rewrite uses the note, and the valid rewrite is saved", async () => {
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async (_g, _a, _f, ctx) => (ctx.feedback.length === 0 ? draftOf() : draftOf({ claims: goodDraft.claims.slice(0, 2) })));
    const t = setup({ providers: { writer: { name: "fake", write } }, config: { maxCitedFacts: 2 } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][3]).toMatchObject({ feedbackKind: "advisory" });
    expect(write.mock.calls[1][3].feedback.join(" ")).toMatch(/cites 3 facts/);
    const d = t.runs[0].details as { advisoryRewrite: string; advisoryNotes: Array<{ attempt: number; source: string; note: string }> };
    expect(d.advisoryRewrite).toBe("kept_rewrite");
    expect(d.advisoryNotes[0]).toMatchObject({ attempt: 1, source: "deterministic" });
  });

  const withFact4 = (over = {}) => {
    const injury = fact({ id: "f4", kind: "current", category: "injury", claim: "The quarterback practiced in full.", publishedAt: null, ...over });
    const story = { ...selection, angles: selection.angles.map((a) => (a.id === "a1" ? { ...a, factIds: ["f1", "f4"] } : a)) };
    return { injury, story };
  };

  it("(test M) an undated or stale current-state fact is NOT silently excluded: it stays in the pool, and a story that rests on it must verify first", async () => {
    const { injury, story } = withFact4();
    const verifyFacts = vi.fn<GamePreviewFactVerifierProvider["verifyFacts"]>(async (_g, fs) => ({ checks: fs.map((f) => ({ factId: f.id, status: "confirmed" as const, basis: "stored_evidence" as const, retrievalFailed: false, note: "ok", corroboratingUrl: null })), usage: usage({ modelCalls: 1 }) }));
    const selectAngle = vi.fn<GamePreviewAngleProvider["selectAngle"]>(async () => ({ ...story, usage: usage({ modelCalls: 1 }) }));
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [...facts, injury], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle }, factVerifier: { name: "fake", verifyFacts } } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(selectAngle.mock.calls[0][1].map((f) => f.id)).toEqual(["f1", "f2", "f3", "f4"]);
    expect(verifyFacts.mock.calls[0][1].map((f) => f.id)).toEqual(["f4"]);
    expect((t.runs[0].details as { exceptionReasons: Record<string, string[]> }).exceptionReasons.f4.join(" ")).toMatch(/no publication date/);
  });

  it("(test G) a stale peripheral fact that cannot be verified is REMOVED and the story is kept when its central facts stand", async () => {
    const { injury, story } = withFact4({ publishedAt: "2026-10-01T00:00:00.000Z" });
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [...facts, injury], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, factVerifier: null } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    const [, angleArg, factsArg] = t.write.mock.calls[0];
    expect(angleArg.id).toBe("a1");
    expect(factsArg.map((f) => f.id)).not.toContain("f4");
    const d = t.runs[0].details as { exceptionReasons: Record<string, string[]>; factsRemoved: Array<{ angleId: string; factId: string }> };
    expect(d.exceptionReasons.f4.join(" ")).toMatch(/older than 72 hours/);
    expect(d.factsRemoved).toEqual([expect.objectContaining({ angleId: "a1", factId: "f4" })]);
    expect(t.saves).toHaveLength(1);
  });

  it("(test H) a stale or unverifiable CENTRAL fact drops that story; with no other story the run is story_not_verified and nothing is written", async () => {
    const { injury } = withFact4({ publishedAt: "2026-10-01T00:00:00.000Z" });
    const only = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f4"], centralFactIds: ["f4"], summary: "A quarterback is back." }], selectedId: "a1" };
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [...facts, { ...injury, sourceUrl: "https://www.espn.com/nfl/story/_/id/9/qb-back" }], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...only, usage: usage({ modelCalls: 1 }) }) }, factVerifier: null } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED", error: "story_not_verified" });
    expect(t.write).not.toHaveBeenCalled();
    expect(t.saves).toHaveLength(0);
  });

  it("a figure named in the chosen story is backed: the fact that holds it is handed to the writer", async () => {
    const narrow = { ...selection, angles: selection.angles.map((a) => (a.id === "a1" ? { ...a, summary: "Indianapolis beat Tennessee 41-20.", factIds: ["f1"] } : a)) };
    const t = setup({ providers: { angles: { name: "fake", selectAngle: async () => ({ ...narrow, usage: usage({ modelCalls: 1 }) }) } } });
    await generateGamePreview(t.deps, req);
    expect(t.write.mock.calls[0][1].factIds).toEqual(["f1", "f2"]);
    expect((t.runs[0].details as { angleFactsAdded: string[] }).angleFactsAdded).toEqual(["f2"]);
  });

  it("(tests B, C) a fact published before the supplied season began is history, whatever the research called it, and the record shows it; a historical fact can still support a current story", async () => {
    const old = fact({ id: "f4", claim: "The Chargers swept the Chiefs.", seasonScope: "CURRENT_SEASON", publishedAt: "2026-03-06T00:00:00.000Z" }); // published before the 2026 season began
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [...facts, old], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) } } });
    await generateGamePreview(t.deps, req);
    expect(t.selectAngle.mock.calls[0][1].find((f) => f.id === "f4")?.seasonScope).toBe("HISTORICAL_CONTEXT");
    const d = t.runs[0].details as { facts: Array<{ id: string; seasonScope: string }>; angleBasis: Record<string, string> };
    expect(d.facts.find((f) => f.id === "f4")?.seasonScope).toBe("HISTORICAL_CONTEXT");
    expect(d.angleBasis).toMatchObject({ a1: "CURRENT_WITH_HISTORY", a2: "CURRENT_SEASON", a3: "HISTORY_ONLY" });
  });

  it("a history-only choice is overridden by a current-season story, and the writer is given the current-season story", async () => {
    const t = setup({ providers: { angles: { name: "fake", selectAngle: async () => ({ ...selection, selectedId: "a3", usage: usage({ modelCalls: 1 }) }) } } });
    await generateGamePreview(t.deps, req);
    expect(t.write.mock.calls[0][1].id).toBe("a1");
    expect((t.runs[0].details as { angleOverridden: boolean }).angleOverridden).toBe(true);
  });

  it("the run record keeps each fact's supporting excerpt, so a misattributed player or team can be spotted in review", async () => {
    const t = setup();
    await generateGamePreview(t.deps, req);
    const recorded = (t.runs[0].details as { facts: Array<{ id: string; excerpt: string | null }> }).facts;
    expect(recorded.find((f) => f.id === "f1")?.excerpt).toBe(facts[0].excerpt);
  });

  const verifierOf = (status: (id: string) => FactCheck["status"], basis: "stored_evidence" | "targeted_search" = "stored_evidence", searches = 0) =>
    vi.fn<GamePreviewFactVerifierProvider["verifyFacts"]>(async (_g, fs) => ({ checks: fs.map((f) => ({ factId: f.id, status: status(f.id), basis, retrievalFailed: false, note: `note ${f.id}`, corroboratingUrl: null })), usage: usage({ searchCalls: searches, modelCalls: 1 }) }));
  /** Research that flags facts as exceptions (surprising / ambiguous / disputed): the only facts that call for additional verification. */
  const flagged = (...ids: string[]) => ({ name: "fake", research: async () => ({ facts: facts.map((f) => (ids.includes(f.id) ? { ...f, surprising: true } : f)), sources, usage: usage({ searchCalls: 3, modelCalls: 1, inputTokens: 900, outputTokens: 400 }) }) });

  it("ONE TRUSTED SOURCE IS ENOUGH: facts from trusted sources that clearly say what is claimed are not re-verified at all — no verification call, no extra search", async () => {
    const verifyFacts = verifierOf(() => "confirmed");
    const t = setup({ providers: { factVerifier: { name: "fake", verifyFacts } }, config: { maxSearchCallsPerGame: 6 } });
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("SUCCEEDED");
    expect(verifyFacts).not.toHaveBeenCalled();
    const m = (t.runs[0].details as { measurement: Record<string, unknown> }).measurement;
    expect(m).toMatchObject({ exceptionFacts: 0, exceptionVerification: false, verificationSearches: 0, sourceDisagreement: false });
  });

  it("only the EXCEPTIONS are verified (here the one flagged surprising), with the searches that remain under the ceiling; the writer comes after", async () => {
    const verifyFacts = verifierOf(() => "confirmed");
    const t = setup({ providers: { research: flagged("f2"), factVerifier: { name: "fake", verifyFacts } }, config: { maxSearchCallsPerGame: 6 } });
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("SUCCEEDED");
    const [, checked, vctx] = verifyFacts.mock.calls[0];
    expect(checked.map((f) => f.id)).toEqual(["f2"]); // f1 and f3 are trusted and clear: not re-checked
    expect(vctx).toMatchObject({ maxSearchCalls: 3, webSearchToolVersion: "web_search_20250305" }); // 6 ceiling - 3 used by research
    expect(t.write.mock.invocationCallOrder[0]).toBeGreaterThan(verifyFacts.mock.invocationCallOrder[0]);
    const d = t.runs[0].details as { exceptionReasons: Record<string, string[]>; factVerification: unknown[] };
    expect(d.exceptionReasons.f2).toEqual(["the claim is unusually surprising or consequential"]);
    expect(d.factVerification).toHaveLength(1);
  });

  it("what makes a fact an exception: a source outside the trusted group, a missing passage, a disputed or ambiguous flag", async () => {
    const verifyFacts = verifierOf(() => "confirmed");
    const research = { name: "fake", research: async () => ({ facts: [facts[0], { ...facts[1], sourceUrl: "https://random-blog.example/post" }, { ...facts[2], excerpt: null }], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) };
    const t = setup({ providers: { research, factVerifier: { name: "fake", verifyFacts } } });
    await generateGamePreview(t.deps, req);
    const d = t.runs[0].details as { exceptionReasons: Record<string, string[]> };
    expect(d.exceptionReasons.f2).toEqual(["the source is outside the trusted group"]);
    expect(d.exceptionReasons.f3).toEqual(["no passage shows that the source says it"]);
    expect(d.exceptionReasons.f1).toBeUndefined();
  });

  it("(test G) a flagged PERIPHERAL fact that does not verify is removed; the story it supported is kept and written without it", async () => {
    const verifyFacts = verifierOf((id) => (id === "f2" ? "unsupported" : "confirmed"));
    const t = setup({ providers: { research: flagged("f2"), factVerifier: { name: "fake", verifyFacts } } });
    const out = await generateGamePreview(t.deps, req);
    const [, angleArg, factsArg] = t.write.mock.calls[0];
    expect(angleArg.id).toBe("a1"); // f2 is supporting context for a1: a1 stands without it
    expect(angleArg.factIds).not.toContain("f2");
    expect(factsArg.map((f) => f.id)).not.toContain("f2"); // the writer never sees the failed fact
    const d = t.runs[0].details as { facts: Array<{ id: string; excluded?: string }>; factsRemoved: Array<{ angleId: string; factId: string }>; storyAttempts: Array<{ angleId: string; outcome: string }> };
    expect(d.facts.find((f) => f.id === "f2")?.excluded).toMatch(/failed verification \(unsupported: note f2\)/);
    expect(d.factsRemoved.some((r) => r.angleId === "a1" && r.factId === "f2")).toBe(true);
    expect(d.storyAttempts).toEqual([{ angleId: "a1", outcome: "used" }]);
    expect(verifyFacts).toHaveBeenCalledTimes(1);
    expect(out.status).toBe("SUCCEEDED");
  });

  it("(tests H, I) a story whose CENTRAL fact does not verify collapses, and the next-best supported story is used from the research already gathered (no new research)", async () => {
    const verifyFacts = verifierOf((id) => (id === "f1" ? "unsupported" : "confirmed"));
    const researchSpy = vi.fn(flagged("f1").research);
    const t = setup({ providers: { research: { name: "fake", research: researchSpy }, factVerifier: { name: "fake", verifyFacts } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("SUCCEEDED");
    expect(t.write.mock.calls[0][1].id).toBe("a3"); // a1 and a2 are centred on f1; the history story a3 (f2) is the next-best supported one
    expect(researchSpy).toHaveBeenCalledTimes(1);
    const d = t.runs[0].details as { storyAttempts: Array<{ angleId: string; outcome: string }>; angleOverridden: boolean };
    expect(d.storyAttempts.map((a) => `${a.angleId}:${a.outcome}`)).toEqual(["a1:collapsed", "a3:used"]);
    expect(d.angleOverridden).toBe(true);
  });

  it("'disputed' does not verify either; when no story stands the run is REJECTED and the writer is never called", async () => {
    const verifyFacts = verifierOf(() => "disputed");
    const t = setup({ providers: { research: flagged("f1", "f2", "f3"), factVerifier: { name: "fake", verifyFacts } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out).toMatchObject({ status: "REJECTED", error: "story_not_verified" });
    expect(t.write).not.toHaveBeenCalled();
    expect(t.saves).toHaveLength(0);
  });

  it("an exception that cannot be verified because no verifier is configured rejects the story rather than trusting it", async () => {
    const t = setup({ providers: { research: flagged("f1", "f2", "f3"), factVerifier: null } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED", error: "story_not_verified" });
    expect(t.write).not.toHaveBeenCalled();
  });

  it("a failure of the verification call fails the run before anything is written", async () => {
    const t = setup({ providers: { research: flagged("f2"), factVerifier: { name: "fake", verifyFacts: async () => { throw new Error("anthropic_api_500: x"); } } } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "FAILED", error: expect.stringMatching(/^fact_verification_failed/) });
    expect(t.write).not.toHaveBeenCalled();
  });

  it("the credited primary source is chosen among the story's OWN facts: a first-listed blog is not a reason to lose the story if another of its facts is trusted and current; with no such fact the story is set aside; with none anywhere nothing is written", async () => {
    const blog = (f: (typeof facts)[number]) => ({ ...f, sourceUrl: "https://random-blog.example/post" });
    // f1 (current, blog) is listed first in a1 and a2; f3 (current, nfl.com) is the story's best eligible source: it becomes the primary and the story stands.
    // (the blog fact stays in the story as a SUPPORTING fact, so it is an exception that is verified)
    const t1 = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [blog(facts[0]), facts[1], facts[2]], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, factVerifier: { name: "fake", verifyFacts: verifierOf(() => "confirmed") } } });
    await generateGamePreview(t1.deps, req);
    expect(t1.write.mock.calls[0][1].id).toBe("a1");
    expect(t1.write.mock.calls[0][1].factIds[0]).toBe("f3");
    expect((t1.runs[0].details as { primaryReordered: string[] }).primaryReordered).toEqual(["a1"]);
    // both current-season facts are blogs: a1 and a2 (about this season) have no eligible CURRENT primary; only the history-only a3 (f2, espn.com) is publishable.
    const t2 = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [blog(facts[0]), facts[1], blog(facts[2])], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) } } });
    await generateGamePreview(t2.deps, req);
    expect(t2.write.mock.calls[0][1].id).toBe("a3");
    expect((t2.runs[0].details as { angleOverridden: boolean }).angleOverridden).toBe(true);
    const allBlogs = { name: "fake", research: async () => ({ facts: facts.map(blog), sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) };
    const t3 = setup({ providers: { research: allBlogs } });
    expect(await generateGamePreview(t3.deps, req)).toMatchObject({ status: "REJECTED", error: "story_not_verified" });
    expect(t3.write).not.toHaveBeenCalled();
  });

  it("the public credit: the primary source first, then at most one more trusted source from a DIFFERENT publisher; stored sources are primary-first and deduplicated", async () => {
    const t = setup();
    await generateGamePreview(t.deps, req);
    const saved = t.saves[0];
    expect(saved.sources[0].url).toBe(facts[0].sourceUrl); // f1 is the story's primary fact
    expect(new Set(saved.sources.map((x) => x.url)).size).toBe(saved.sources.length);
    const meta = saved.meta as { publicSourceUrls: string[]; primarySourceUrl: string };
    expect(meta.primarySourceUrl).toBe(facts[0].sourceUrl);
    expect(meta.publicSourceUrls).toEqual([facts[0].sourceUrl, facts[2].sourceUrl]); // espn.com (f1) then nfl.com (f3); f2 is also espn.com so it adds no second credit
    expect((t.runs[0].details as { measurement: { publicSources: string[]; primarySource: string } }).measurement.publicSources).toEqual(meta.publicSourceUrls);
  });

  it("a draft that does not cite the story's primary fact is rejected: the Preview must rest on the source it credits", async () => {
    const noPrimary = draftOf({ claims: goodDraft.claims.filter((c) => !c.factIds.includes("f1")), preview: "Indianapolis is 2-3, but beat Tennessee 41-20 and 38-14 last season. Does the Titans' winless start end in Indianapolis?" });
    const t = setup({ providers: { writer: { name: "fake", write: async () => noPrimary } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("REJECTED");
    expect(out.status !== "SUCCEEDED" && out.problems.join(" ")).toMatch(/primary fact \(f1\)/);
    expect(t.saves).toHaveLength(0);
  });

  it("source conflicts and research leads are recorded; leads keep only usable facts and reach the angle stage as hints", async () => {
    const leads = [{ summary: "A winless team meets a team that owned it.", factIds: ["f1", "f2", "f99"] }, { summary: "Dropped.", factIds: ["f99"] }];
    const conflicts = [{ topic: "Tennessee goals", note: "ESPN 3, NFL.com 4" }];
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts, sources, leads, conflicts, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) } } });
    await generateGamePreview(t.deps, req);
    expect(t.selectAngle.mock.calls[0][3]).toEqual([{ summary: "A winless team meets a team that owned it.", factIds: ["f1", "f2"] }]);
    const d = t.runs[0].details as { sourceConflicts: unknown[]; researchLeads: unknown[] };
    expect(d.sourceConflicts).toEqual(conflicts);
    expect(d.researchLeads).toHaveLength(1);
  });

  it("the ceiling covers research AND any verification: research gets two thirds, and what it leaves unused rolls over", async () => {
    expect([6, 5, 3, 2, 0].map((n) => verificationReserve(n, true))).toEqual([2, 1, 1, 0, 0]);
    expect(verificationReserve(6, false)).toBe(0);
    const t = setup({ providers: { factVerifier: { name: "fake", verifyFacts: verifierOf(() => "confirmed") } }, config: { maxSearchCallsPerGame: 6 } });
    await generateGamePreview(t.deps, req);
    expect(t.research.mock.calls[0][1].maxSearchCalls).toBe(4);
  });

  it("without a fact verifier the whole ceiling goes to research", async () => {
    const t = setup({ config: { maxSearchCallsPerGame: 6 } });
    await generateGamePreview(t.deps, req);
    expect(t.research.mock.calls[0][1].maxSearchCalls).toBe(6);
  });

  it("pilot measurement per exception: where the searches went and how each flagged fact was settled", async () => {
    const verifyFacts = verifierOf(() => "confirmed", "targeted_search", 1);
    const t = setup({ providers: { research: flagged("f2"), factVerifier: { name: "fake", verifyFacts } }, config: { maxSearchCallsPerGame: 6 } });
    await generateGamePreview(t.deps, req);
    const m = (t.runs[0].details as { measurement: Record<string, unknown> }).measurement;
    expect(m).toMatchObject({ researchSearches: 3, verificationSearches: 1, factsDiscovered: 3, factsSelected: 3, exceptionFacts: 1, exceptionVerification: true, confirmedFromStoredEvidence: 0, confirmedAfterTargetedSearch: 1, needingExtraSearch: 1, disputed: 0, unsupported: 0, retrievalFailed: 0, sourceDisagreement: false });
  });

  it("a Preview may use 0 verification searches when the captured evidence settles the exception", async () => {
    const t = setup({ providers: { research: flagged("f2"), factVerifier: { name: "fake", verifyFacts: verifierOf(() => "confirmed", "stored_evidence", 0) } }, config: { maxSearchCallsPerGame: 6 } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect((t.runs[0].details as { measurement: { verificationSearches: number; confirmedFromStoredEvidence: number } }).measurement).toMatchObject({ verificationSearches: 0, confirmedFromStoredEvidence: 1 });
  });

  it("a disputed fact is recorded as a source disagreement in the pilot measurement", async () => {
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: facts.map((f) => (f.id === "f2" ? { ...f, disputed: true } : f)), sources, conflicts: [{ topic: "score", note: "ESPN 3, NFL.com 4" }], usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, factVerifier: { name: "fake", verifyFacts: verifierOf(() => "confirmed") } } });
    await generateGamePreview(t.deps, req);
    expect((t.runs[0].details as { measurement: { sourceDisagreement: boolean } }).measurement.sourceDisagreement).toBe(true);
  });

  it("two angles of the same kind do not reject the run: the weaker is set aside, recorded, and the story is still written", async () => {
    const dup = { ...selection, angles: selection.angles.map((a) => (a.id === "a3" ? { ...a, type: "CONTRAST" as const } : a)) }; // a3 is now a second CONTRAST (a1 is the stronger)
    const t = setup({ providers: { angles: { name: "fake", selectAngle: async () => ({ ...dup, usage: usage({ modelCalls: 1 }) }) } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("SUCCEEDED");
    const d = t.runs[0].details as { angleDuplicatesDropped: Array<{ id: string; keptId: string }>; angles: Array<{ id: string }> };
    expect(d.angleDuplicatesDropped).toEqual([{ id: "a3", keptId: "a1", reason: expect.stringMatching(/another CONTRAST story/) }]);
    expect(d.angles.map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  it("when every attempt has a BLOCKING problem NOTHING is saved, the run is REJECTED, and the reasons are reported", async () => {
    const bad = draftOf({ preview: `${goodDraft.preview} The Colts are heavy favorites on the moneyline.` }); // wagering language is a deterministic style invariant
    const t = setup({ providers: { writer: { name: "fake", write: async () => bad } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out).toMatchObject({ status: "REJECTED", error: "draft_rejected" });
    expect(out.status !== "SUCCEEDED" && out.problems.join(" ")).toMatch(/wagering language/);
    expect(t.saves).toHaveLength(0);
    expect(t.runs[0]).toMatchObject({ status: "REJECTED", attempts: 2 });
    expect((t.runs[0].details as { attemptsLog: unknown[] }).attemptsLog).toHaveLength(2);
  });

  const reviewer = (script: Array<Partial<Awaited<ReturnType<GamePreviewVerifierProvider["verify"]>>>>) => {
    let i = 0;
    return vi.fn<GamePreviewVerifierProvider["verify"]>(async () => ({ blocking: [], advisory: [], usage: usage({ modelCalls: 1 }), ...(script[Math.min(i++, script.length - 1)] ?? {}) }));
  };
  const BLOCK = { blocking: [{ category: "unsupported_causation" as const, problem: "A defensive player's absence is presented as burdening the offense." }] };
  const ADVISE = { advisory: [{ kind: "game_note_feel" as const, note: "reads like game notes" }] };

  it("a BLOCKING finding from the independent read (a causal misuse of true facts) rejects every attempt it appears in; the category is recorded", async () => {
    const verify = reviewer([BLOCK]);
    const t = setup({ providers: { verifier: { name: "fake", verify } } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED", error: "draft_rejected" });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(t.saves).toHaveLength(0);
    const d = t.runs[0].details as { blockingCounts: { reviewer: number; reviewerByCategory: Record<string, number> }; attemptsLog: Array<{ verifierProblems: string[] }> };
    expect(d.blockingCounts.reviewerByCategory).toEqual({ unsupported_causation: 2 });
    expect(d.attemptsLog[0].verifierProblems[0]).toMatch(/^\[unsupported_causation\]/);
  });

  it("ADVISORY-only findings never reject: ONE rewrite uses the notes, and a factually valid rewrite is saved (no endless editorial loop)", async () => {
    const verify = reviewer([ADVISE, ADVISE, ADVISE]);
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async (_g, _a, _f, ctx) => draftOf({ hook: ctx.feedback.length ? "Zero wins in five. Indianapolis, you're up (v2)." : "Zero wins in five. Indianapolis, you're up." }));
    const t = setup({ providers: { writer: { name: "fake", write }, verifier: { name: "fake", verify } }, config: { maxAttempts: 3 } });
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("SUCCEEDED");
    expect(write).toHaveBeenCalledTimes(2); // not three: the second valid draft is saved even though the reviewer still has taste notes
    expect(write.mock.calls[1][3]).toMatchObject({ feedbackKind: "advisory", feedback: ["reads like game notes"] });
    expect(t.saves[0].hook).toContain("(v2)");
    const d = t.runs[0].details as { advisoryRewrite: string; advisoryNotes: unknown[]; blockingCounts: { reviewer: number } };
    expect(d.advisoryRewrite).toBe("kept_rewrite");
    expect(d.advisoryNotes).toHaveLength(2);
    expect(d.blockingCounts.reviewer).toBe(0);
    expect((t.saves[0].meta as { advisoryNotes: unknown[] }).advisoryNotes).toHaveLength(1); // the saved draft's own notes are kept with the Preview
  });

  it("if the polish rewrite introduces a BLOCKING problem, the earlier valid draft is saved instead", async () => {
    const verify = reviewer([ADVISE, BLOCK]);
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async (_g, _a, _f, ctx) => draftOf({ hook: ctx.feedback.length ? "The rewrite that went wrong." : "Zero wins in five. Indianapolis, you're up." }));
    const t = setup({ providers: { writer: { name: "fake", write }, verifier: { name: "fake", verify } }, config: { maxAttempts: 3 } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(t.saves[0].hook).toBe("Zero wins in five. Indianapolis, you're up.");
    expect((t.runs[0].details as { advisoryRewrite: string }).advisoryRewrite).toBe("kept_original");
  });

  it("with no attempt left for a polish rewrite, a valid draft with advisory notes is saved as it is", async () => {
    const verify = reviewer([ADVISE]);
    const t = setup({ providers: { verifier: { name: "fake", verify } }, config: { maxAttempts: 1 } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(t.write).toHaveBeenCalledTimes(1);
    expect((t.runs[0].details as { advisoryRewrite: string; advisoryNotes: unknown[] }).advisoryNotes).toHaveLength(1);
  });

  it("a BLOCKING problem first, then a clean rewrite: saved, and no advisory rewrite is attempted", async () => {
    const verify = reviewer([BLOCK, {}]);
    const t = setup({ providers: { verifier: { name: "fake", verify } } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(t.write).toHaveBeenCalledTimes(2);
    expect(t.write.mock.calls[1][3]).toMatchObject({ feedbackKind: "blocking" });
  });

  it("a betting page cannot be the credited primary source even on a trusted domain: another of the story's own facts is credited instead; if every fact is a betting page, nothing is written", async () => {
    const betting = (f: (typeof facts)[number]) => ({ ...f, sourceUrl: "https://www.espn.com/betting/nfl/news/colts-titans-odds-expert-picks" });
    const t1 = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [betting(facts[0]), facts[1], facts[2]], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, factVerifier: { name: "fake", verifyFacts: verifierOf(() => "confirmed") } } });
    await generateGamePreview(t1.deps, req);
    expect(t1.write.mock.calls[0][1].factIds[0]).toBe("f3"); // never the betting page
    expect((t1.saves[0]?.meta as { primarySourceUrl: string } | undefined)?.primarySourceUrl ?? facts[2].sourceUrl).toBe(facts[2].sourceUrl);
    const t2 = setup({ providers: { research: { name: "fake", research: async () => ({ facts: facts.map(betting), sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) } } });
    expect(await generateGamePreview(t2.deps, req)).toMatchObject({ status: "REJECTED", error: "story_not_verified" });
  });

  it("a betting page that supports a non-primary fact is an exception that must be verified, and is never credited publicly", async () => {
    const verifyFacts = verifierOf(() => "confirmed");
    const research = { name: "fake", research: async () => ({ facts: [facts[0], facts[1], { ...facts[2], sourceUrl: "https://www.nfl.com/betting/colts-odds-picks" }], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) };
    const t = setup({ providers: { research, factVerifier: { name: "fake", verifyFacts } } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(verifyFacts.mock.calls[0][1].map((f) => f.id)).toEqual(["f3"]);
    expect((t.runs[0].details as { exceptionReasons: Record<string, string[]> }).exceptionReasons.f3).toEqual(["the page is a betting, odds or picks page"]);
    expect((t.saves[0].meta as { publicSourceUrls: string[] }).publicSourceUrls).toEqual([facts[0].sourceUrl]);
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

  it("candidate angles are cleaned structurally, not rejected: one angle is enough, an unknown type or out-of-range score is repaired, and only 'nothing usable' rejects the run", async () => {
    const one = setup({ providers: { angles: { name: "fake", selectAngle: async () => ({ ...selection, angles: selection.angles.slice(0, 1), usage: usage() }) } } });
    expect((await generateGamePreview(one.deps, req)).status).toBe("SUCCEEDED");
    const none = setup({ providers: { angles: { name: "fake", selectAngle: async () => ({ ...selection, angles: selection.angles.map((a) => ({ ...a, factIds: ["f99"] })), usage: usage() }) } } });
    expect(await generateGamePreview(none.deps, req)).toMatchObject({ status: "REJECTED", error: "angle_selection_invalid" });
    expect(none.write).not.toHaveBeenCalled();
    expect(none.saves).toHaveLength(0);
  });

  it("(test S) a Game the sources do not confirm is returned as needs_review with the specific conflict; no story is written and nothing is saved", async () => {
    const conflict = "The league shows Indianapolis hosting Houston on Oct. 19.";
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ gameCheck: { confirmed: false, conflict }, facts, sources, usage: usage({ searchCalls: 2, modelCalls: 1 }) }) } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out).toMatchObject({ status: "REJECTED", error: "needs_review: game_mismatch" });
    expect(out.status !== "SUCCEEDED" && out.problems).toEqual([conflict]);
    expect(t.selectAngle).not.toHaveBeenCalled();
    expect(t.write).not.toHaveBeenCalled();
    expect(t.saves).toHaveLength(0);
    expect(t.runs).toHaveLength(1);
  });

  it("a writer that finds no honest story in ANY supported story returns needs_review with its reason: nothing is reviewed or saved", async () => {
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async () => draftOf({ status: "needs_review", reason: "Only last season's material.", hook: "", preview: "", claims: [] }));
    const t = setup({ providers: { writer: { name: "fake", write } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out).toMatchObject({ status: "REJECTED", error: "needs_review: no_supported_story" });
    expect(out.status !== "SUCCEEDED" && out.problems.join(" ")).toMatch(/Only last season's material\./);
    expect(write).toHaveBeenCalledTimes(2); // a1, then the next-best a3, within the attempt budget
    expect(t.verify).not.toHaveBeenCalled();
    expect(t.saves).toHaveLength(0);
  });

  it("(test I) when the writer declines the first story, the next-best supported story is written before needs_review, inside the same attempt budget", async () => {
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async (_g, angle) => (angle.id === "a1" ? draftOf({ status: "needs_review", reason: "Thin.", hook: "", preview: "", claims: [] }) : draftOf({ claims: [{ text: "Indianapolis beat Tennessee 41-20 and 38-14 last season.", factIds: ["f2"] }] })));
    const t = setup({ providers: { writer: { name: "fake", write } }, config: { maxAttempts: 3 } });
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("SUCCEEDED");
    expect(write.mock.calls.map((c) => c[1].id)).toEqual(["a1", "a3"]);
    expect(out.attempts).toBe(2); // never more than max attempts
    expect((t.runs[0].details as { storyAttempts: Array<{ angleId: string; outcome: string }> }).storyAttempts.map((a) => `${a.angleId}:${a.outcome}`)).toEqual(["a1:used", "a1:collapsed", "a3:used"]);
  });

  it("(test E) status inflation is a BLOCKING finding: 'unlikely to play' written as 'out' is rejected and rewritten (Packers @ Lions regression)", async () => {
    const hedged = fact({ id: "f1", claim: "Micah Parsons won't practice this week and doesn't look likely to play in Week 7.", excerpt: "Parsons will not practice this week; Yahoo Sports reports he is unlikely to play Sunday." });
    const inflated = draftOf({ hook: "Green Bay is missing Parsons just as Detroit scores 33", preview: "Micah Parsons is out. Can the Packers' front hold up?", claims: [{ text: "Micah Parsons is out.", factIds: ["f1"] }] });
    const honest = draftOf({ hook: "Parsons is unlikely to play, and Detroit scores 33", preview: "Micah Parsons is unlikely to play after sitting out practice. Can the Packers' front hold up?", claims: [{ text: "Micah Parsons is unlikely to play.", factIds: ["f1"] }] });
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async (_g, _a, _f, ctx) => (ctx.feedback.length === 0 ? inflated : honest));
    const verify = vi.fn<GamePreviewVerifierProvider["verify"]>(async (_g, _a, d, _f, _c, hints) => ({
      blocking: /\b(is out|is missing)\b/i.test(`${d.hook} ${d.preview}`) ? [{ category: "status_overstated" as const, problem: "'unlikely to play' is written as 'out'/'missing'." }] : [],
      advisory: [],
      usage: usage({ modelCalls: 1 }),
      ...(hints ? {} : {}),
    }));
    const story = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f1"], centralFactIds: ["f1"], summary: "A pass rusher is unlikely to play." }], selectedId: "a1" };
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [hedged], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, writer: { name: "fake", write }, verifier: { name: "fake", verify } } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(t.saves[0].hook).toBe(honest.hook);
    expect(verify.mock.calls[0][5]?.hedges?.join(" ")).toMatch(/f1: "unlikely"/); // code tells the reviewer which hedges the source carried
    expect((t.runs[0].details as { blockingCounts: { reviewerByCategory: Record<string, number> } }).blockingCounts.reviewerByCategory.status_overstated).toBe(1);
  });

  const ESPN_STORY = "https://www.espn.com/nfl/story/_/id/1/titans-winless";
  const savedPublic = (t: ReturnType<typeof setup>) => ((t.saves[0].meta as { publicSourceUrls: string[] }).publicSourceUrls);

  it("(test A) the public primary is the source of the CENTRAL claim, not of an incidental fact that happens to be listed first", async () => {
    const incidental = fact({ id: "f9", claim: "Kickoff is at 1 PM.", excerpt: "Kickoff 1 PM ET", sourceUrl: "https://www.nfl.com/news/kickoff-notes", sourceProvider: "NFL.com", sourceTitle: "Kickoff notes", category: "context" });
    const central = fact({ id: "f1", sourceUrl: ESPN_STORY });
    const story = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f9", "f1"], centralFactIds: ["f1"], summary: "A winless team." }], selectedId: "a1" };
    const draft = draftOf({ claims: [{ text: "Tennessee is 0-5 after a 26-3 loss to Houston.", factIds: ["f1"] }, { text: "Kickoff is at 1 PM.", factIds: ["f9"] }] });
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [incidental, central], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, writer: { name: "fake", write: async () => draft } } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(t.write).not.toHaveBeenCalled();
    expect((t.saves[0].meta as { primarySourceUrl: string }).primarySourceUrl).toBe(ESPN_STORY);
    expect(savedPublic(t)[0]).toBe(ESPN_STORY);
    const cs = (t.runs[0].details as { centralStory: { primarySource: string; primaryClaims: string[] } }).centralStory;
    expect(cs.primarySource).toBe(ESPN_STORY);
    expect(cs.primaryClaims).toEqual([central.claim]);
  });

  it("(tests B, C, D) raw JSON, a schedule PDF and a live injury list are VALID EVIDENCE (stored with the Preview) but are never the public credit", async () => {
    const central = fact({ id: "f1", sourceUrl: ESPN_STORY });
    const json = fact({ id: "f2", category: "context", claim: "The game is Sunday at 1 PM.", sourceUrl: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", sourceProvider: "ESPN", sourceTitle: "scoreboard" });
    const pdf = fact({ id: "f3", category: "context", claim: "The league schedule lists the game in Week 7.", sourceUrl: "https://www.nfl.com/uploads/2026-schedule.pdf", sourceProvider: "NFL.com", sourceTitle: "2026 schedule" });
    const list = fact({ id: "f4", kind: "current", category: "injury", claim: "The quarterback is listed as questionable.", sourceUrl: "https://www.espn.com/nfl/team/injuries/_/name/ten/tennessee-titans", sourceProvider: "ESPN", sourceTitle: "Titans injuries", publishedAt: "2026-10-17T12:00:00.000Z" });
    const story = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f1", "f2", "f3", "f4"], centralFactIds: ["f1"], summary: "A winless team." }], selectedId: "a1" };
    const draft = draftOf({ claims: [{ text: "Tennessee is 0-5.", factIds: ["f1"] }, { text: "The game is Sunday at 1 PM.", factIds: ["f2"] }, { text: "It is Week 7.", factIds: ["f3"] }, { text: "The quarterback is questionable.", factIds: ["f4"] }] });
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [central, json, pdf, list], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, writer: { name: "fake", write: async () => draft } }, config: { maxCitedFacts: 4 } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(t.saves[0].sources.map((x) => x.url)).toEqual(expect.arrayContaining([json.sourceUrl, pdf.sourceUrl, list.sourceUrl])); // evidence is kept
    expect(savedPublic(t)).toEqual([ESPN_STORY]); // the credit is only the readable story
  });

  it("a story whose CENTRAL claim rests only on a data feed, a PDF or a live list has no creditable source: it is not published", async () => {
    const json = fact({ id: "f1", sourceUrl: "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard" });
    const only = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f1"], centralFactIds: ["f1"], summary: "A winless team." }], selectedId: "a1" };
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [json], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...only, usage: usage({ modelCalls: 1 }) }) } } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED", error: "no_trusted_primary_source" });
    expect(t.saves).toHaveLength(0);
  });

  it("(test N) a second public source only when it materially supports the story: a source that merely backs a claim the primary already covers is not shown", async () => {
    const primary = fact({ id: "f1", sourceUrl: ESPN_STORY });
    const other = fact({ id: "f3", category: "record", claim: "Indianapolis is 2-3.", excerpt: "Colts 2-3", sourceUrl: "https://www.nfl.com/news/colts-steelers-recap", sourceProvider: "NFL.com", sourceTitle: "Steelers beat Colts" });
    const story = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f1", "f3"], centralFactIds: ["f1"], summary: "A winless team." }], selectedId: "a1" };
    const run = async (claims: Array<{ text: string; factIds: string[] }>) => {
      const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [primary, other], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, writer: { name: "fake", write: async () => draftOf({ claims }) } } });
      await generateGamePreview(t.deps, req);
      return savedPublic(t);
    };
    // The second source carries a claim of its own: material.
    expect(await run([{ text: "Tennessee is 0-5.", factIds: ["f1"] }, { text: "Indianapolis is 2-3.", factIds: ["f3"] }])).toEqual([ESPN_STORY, other.sourceUrl]);
    // Its only claim is also backed by the primary: not material, so not shown.
    expect(await run([{ text: "Tennessee is 0-5.", factIds: ["f1"] }, { text: "Indianapolis is 2-3 and Tennessee is 0-5.", factIds: ["f1", "f3"] }])).toEqual([ESPN_STORY]);
    // A source that was only consulted (found by research, never cited) is never shown.
    expect(await run([{ text: "Tennessee is 0-5.", factIds: ["f1"] }])).toEqual([ESPN_STORY]);
  });

  it("(tests L, M) a credited source research left undated gets the date the page itself shows; if the page shows none it stays null; a date research already has is kept", async () => {
    const undated = fact({ id: "f1", sourceUrl: ESPN_STORY, publishedAt: null });
    const dated = fact({ id: "f3", category: "record", claim: "Indianapolis is 2-3.", excerpt: "Colts 2-3", sourceUrl: "https://www.nfl.com/news/colts-steelers-recap", sourceProvider: "NFL.com", sourceTitle: "Steelers beat Colts", publishedAt: "2026-10-12T00:00:00.000Z" });
    const story = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f1", "f3"], centralFactIds: ["f1"], summary: "A winless team." }], selectedId: "a1" };
    const draft = draftOf({ claims: [{ text: "Tennessee is 0-5.", factIds: ["f1"] }, { text: "Indianapolis is 2-3.", factIds: ["f3"] }] });
    const make = (fetchPublishedDate: PipelineDeps["fetchPublishedDate"]) => {
      const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [undated, dated], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, writer: { name: "fake", write: async () => draft } }, config: { verifyWithModel: false } });
      t.deps.fetchPublishedDate = fetchPublishedDate;
      return t;
    };
    const fetchSpy = vi.fn(async (url: string) => (url === ESPN_STORY ? "2026-10-20T08:00:00.000Z" : "2099-01-01T00:00:00.000Z"));
    const found = make(fetchSpy);
    await generateGamePreview(found.deps, req);
    expect(found.saves[0].sources.find((x) => x.url === ESPN_STORY)?.publishedAt).toBe("2026-10-20T08:00:00.000Z");
    expect(found.saves[0].sources.find((x) => x.url === dated.sourceUrl)?.publishedAt).toBe("2026-10-12T00:00:00.000Z");
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the undated credited source is looked up
    const none = make(async () => null);
    await generateGamePreview(none.deps, req);
    expect(none.saves[0].sources.find((x) => x.url === ESPN_STORY)?.publishedAt ?? null).toBeNull();
    const absent = make(undefined);
    await generateGamePreview(absent.deps, req);
    expect(absent.saves[0].sources.find((x) => x.url === ESPN_STORY)?.publishedAt ?? null).toBeNull();
    const throws = make(async () => { throw new Error("blocked"); });
    expect((await generateGamePreview(throws.deps, req)).status).toBe("SUCCEEDED"); // a failed lookup never fails the run
  });

  describe("credit lookup: a story whose central claim first appeared in a lower-trust source is credited to the trusted page that carries it", () => {
    const yahoo = (over = {}) => fact({ id: "f1", sourceUrl: "https://sports.yahoo.com/articles/titans-winless-123.html", sourceProvider: "Yahoo Sports", sourceTitle: "Titans winless", ...over });
    const story = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f1"], centralFactIds: ["f1"], summary: "A winless team." }], selectedId: "a1" };
    const hit = { url: "https://www.espn.com/nfl/story/_/id/77/titans-fall-to-0-5", title: "Titans fall to 0-5", provider: "ESPN", publishedAt: "2026-10-12T10:00:00.000Z", excerpt: "Tennessee fell to 0-5 with a 26-3 loss to Houston." };
    const verifierWith = (found: (id: string) => typeof hit | null, calls: { lookup: number } = { lookup: 0 }) => ({
      name: "fake",
      verifyFacts: verifierOf(() => "confirmed"),
      findTrustedSources: vi.fn(async (_g: unknown, fs: Array<{ id: string }>) => {
        calls.lookup++;
        return { found: fs.map((f) => ({ factId: f.id, hit: found(f.id) })), usage: usage({ searchCalls: 1, modelCalls: 1 }) };
      }),
    });
    const citesStoryFacts = vi.fn<GamePreviewWriterProvider["write"]>(async (_g, angle) => draftOf({ claims: [{ text: "Tennessee is 0-5 after a 26-3 loss to Houston.", factIds: [angle.factIds[0]] }] }));
    const build = (verifier: ReturnType<typeof verifierWith> | null, extra: Partial<typeof config> = {}) =>
      setup({ providers: { writer: { name: "fake", write: citesStoryFacts }, research: { name: "fake", research: async () => ({ facts: [yahoo()], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, factVerifier: verifier as never }, config: { maxSearchCallsPerGame: 8, ...extra } });

    it("the trusted page becomes the central fact and the public credit; the Yahoo page stays valid evidence", async () => {
      const t = build(verifierWith(() => hit));
      expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
      const [, angleArg, factsArg] = citesStoryFacts.mock.calls[0];
      expect(angleArg.factIds).toEqual(["f1t"]);
      expect(factsArg.find((f) => f.id === "f1t")?.sourceUrl).toBe(hit.url);
      expect((t.saves[0].meta as { primarySourceUrl: string; publicSourceUrls: string[] }).publicSourceUrls).toEqual([hit.url]);
      expect(t.saves[0].sources.find((x) => x.url === hit.url)?.publishedAt).toBe(hit.publishedAt);
      expect((t.runs[0].details as { creditLookups: unknown[] }).creditLookups).toEqual([{ angleId: "a1", factId: "f1", found: hit.url }]);
    });

    it("no trusted page found: that story cannot be credited and the Game is not published (no_trusted_primary_source)", async () => {
      const t = build(verifierWith(() => null));
      expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED", error: "no_trusted_primary_source" });
      expect(t.saves).toHaveLength(0);
    });

    it("a lookup that fails, or cannot run, is recorded in the run details (never silent) and only costs that story", async () => {
      const failing = { ...verifierWith(() => hit), findTrustedSources: vi.fn(async () => { throw new Error("anthropic_api_400: bad request"); }) };
      const t = build(failing as never);
      expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED", error: "no_trusted_primary_source" });
      expect((t.runs[0].details as { creditLookups: Array<{ note?: string }> }).creditLookups[0].note).toMatch(/lookup failed: anthropic_api_400/);
      const noRoom = build(verifierWith(() => hit), { maxSearchCallsPerGame: 3 });
      await generateGamePreview(noRoom.deps, req);
      expect((noRoom.runs[0].details as { creditLookups: Array<{ note?: string }> }).creditLookups[0].note).toMatch(/no searches left/);
    });

    it("a page the lookup returns that is not trusted, not readable, a betting page or an old page for a current-state claim is not used", async () => {
      for (const bad of [{ ...hit, url: "https://random-blog.example/titans" }, { ...hit, url: "https://www.espn.com/nfl/team/injuries/_/name/ten/tennessee-titans" }, { ...hit, url: "https://www.espn.com/betting/nfl/titans-odds-picks" }]) {
        const t = build(verifierWith(() => bad));
        expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED", error: "no_trusted_primary_source" });
      }
      const current = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [yahoo({ kind: "current", publishedAt: "2026-10-17T12:00:00.000Z" })], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, factVerifier: verifierWith(() => ({ ...hit, publishedAt: "2026-10-01T00:00:00.000Z" })) as never }, config: { maxSearchCallsPerGame: 8 } });
      expect(await generateGamePreview(current.deps, req)).toMatchObject({ status: "REJECTED", error: "no_trusted_primary_source" });
    });

    it("the lookup only runs when the search ceiling has room, and not at all for a story that already has a creditable central source", async () => {
      const calls = { lookup: 0 };
      const noRoom = build(verifierWith(() => hit, calls), { maxSearchCallsPerGame: 3 }); // research already used 3
      expect(await generateGamePreview(noRoom.deps, req)).toMatchObject({ status: "REJECTED" });
      expect(calls.lookup).toBe(0);
      const credited = setup({ providers: { factVerifier: verifierWith(() => hit, calls) as never } });
      await generateGamePreview(credited.deps, req);
      expect(calls.lookup).toBe(0);
    });

    it("a comparably strong story that is already creditable is preferred to one that needs a lookup", async () => {
      const calls = { lookup: 0 };
      const two = { ...selection, angles: [{ ...selection.angles[0], id: "a1", factIds: ["f1"], centralFactIds: ["f1"], summary: "Needs a lookup." }, { ...selection.angles[0], id: "a2", type: "HOT_VS_COLD" as const, factIds: ["f3"], centralFactIds: ["f3"], summary: "Already creditable." }], selectedId: "a1" };
      const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [yahoo(), facts[2]], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...two, usage: usage({ modelCalls: 1 }) }) }, factVerifier: verifierWith(() => hit, calls) as never }, config: { maxSearchCallsPerGame: 8 } });
      await generateGamePreview(t.deps, req);
      expect(t.write.mock.calls[0][1].id).toBe("a2");
      expect(calls.lookup).toBe(0);
    });
  });

  it("provenance: one saved Preview per successful generation, with claim evidence, season, phase and the research time", async () => {
    const t = setup();
    await generateGamePreview(t.deps, req);
    expect(t.saves).toHaveLength(1);
    expect(t.saves[0].claims![0]).toMatchObject({ fact_ids: ["f1"], source_urls: [facts[0].sourceUrl] });
    expect(String((t.saves[0].claims![0] as { evidence?: string }).evidence).length).toBeGreaterThan(0);
    expect(t.saves[0].meta).toMatchObject({ season: "2026", phase: "regular_season", researchedAt: NOW.toISOString() });
  });

  it("(test K) a figure the trusted sources disagree about is a verification exception, and an unresolved one does not publish", async () => {
    const verifyFacts = vi.fn<GamePreviewFactVerifierProvider["verifyFacts"]>(async (_g, fs) => ({ checks: fs.map((f) => ({ factId: f.id, status: "disputed" as const, basis: "stored_evidence" as const, retrievalFailed: false, note: "ESPN says 3, KCSN says 4", corroboratingUrl: null })), usage: usage({ modelCalls: 1 }) }));
    const research = { name: "fake", research: async () => ({ facts: facts.map((f) => (f.id === "f1" ? { ...f, disputed: true } : f)), sources, conflicts: [{ topic: "sacks", note: "3 vs 4" }], usage: usage({ searchCalls: 3, modelCalls: 1 }) }) };
    const t = setup({ providers: { research, factVerifier: { name: "fake", verifyFacts } } });
    await generateGamePreview(t.deps, req);
    // The disputed fact is removed; its central story collapses and the next-best supported story is used instead (or the Game is needs_review): the disputed claim is never published.
    expect(t.saves.every((x) => !x.claims!.some((c) => c.fact_ids.includes("f1")))).toBe(true);
    expect((t.runs[0].details as { storyAttempts: Array<{ angleId: string; outcome: string }> }).storyAttempts[0]).toMatchObject({ angleId: "a1", outcome: "collapsed" });
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
