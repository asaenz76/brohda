import { describe, expect, it, vi } from "vitest";
import { generateGamePreview, verificationReserve, type PipelineDeps } from "@/lib/game-previews/pipeline";
import { addUsage, emptyUsage, type StatusConfirmation, type NumberRefresh, type FactCheck, type GamePreviewAngleProvider, type GamePreviewFactVerifierProvider, type GamePreviewProviders, type GamePreviewResearchProvider, type GamePreviewVerifierProvider, type GamePreviewWriterProvider, type PreviewDraft } from "@/lib/game-previews/providers/types";
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
    const { injury, story } = withFact4({ statusKind: "NONE" });
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
      expect(angleArg.factIds).toEqual(["f1t", "f1"]); // the trusted page leads; the original evidence stays in the story
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

describe("generation attribution: the run record carries the actor only for an ADMIN run", () => {
  it("passes the actor of an ADMIN request to the run record, and never for an AUTOMATIC one", async () => {
    const admin = setup();
    await generateGamePreview(admin.deps, { ...req, actorId: "11111111-2222-4333-8444-555555555555" });
    expect(admin.runs[0].actorId).toBe("11111111-2222-4333-8444-555555555555");
    const automatic = setup();
    await generateGamePreview(automatic.deps, { fixtureId: game.fixtureId, reason: "MISSING", trigger: "AUTOMATIC", actorId: "11111111-2222-4333-8444-555555555555" });
    expect(automatic.runs[0].actorId).toBeNull();
    const unknown = setup();
    await generateGamePreview(unknown.deps, req);
    expect(unknown.runs[0].actorId).toBeNull();
  });
});

const verifierOf = (status: (id: string) => FactCheck["status"], basis: "stored_evidence" | "targeted_search" = "stored_evidence", searches = 0) =>
  vi.fn<GamePreviewFactVerifierProvider["verifyFacts"]>(async (_g, fs) => ({ checks: fs.map((f) => ({ factId: f.id, status: status(f.id), basis, retrievalFailed: false, note: `note ${f.id}`, corroboratingUrl: null })), usage: usage({ searchCalls: searches, modelCalls: 1 }) }));

describe("current-number freshness: flag, refresh, update or remove, salvage", () => {
  const ESPN_STORY = "https://www.espn.com/nfl/story/_/id/1/titans-winless";
  const withGames = (completed: Array<{ team: string; completedUtc: string }>) => async () => ({ ...game, lastCompleted: completed });
  // Tennessee played Game 6 on Oct. 18; the number's evidence is from Oct. 12 (after Game 5).
  const afterGame6 = [{ team: "Tennessee Titans", completedUtc: "2026-10-18T03:00:00.000Z" }, { team: "Indianapolis Colts", completedUtc: "2026-10-12T21:00:00.000Z" }];
  const stat = (over = {}) => fact({ id: "f1", kind: "current", numberKind: "CURRENT_STATE", subjectTeam: "Tennessee Titans", sourceUrl: ESPN_STORY, claim: "Tennessee averages 60.4 rushing yards per game through five games.", excerpt: "Tennessee: 60.4 rushing yards per game through 5 games", publishedAt: "2026-10-12T10:00:00.000Z", asOfLabel: "through 5 games", ...over });
  const story = (factIds = ["f1"], central = ["f1"]) => ({ ...selection, angles: [{ ...selection.angles[0], factIds, centralFactIds: central, summary: "Tennessee cannot run." }], selectedId: "a1" });
  const refresher = (r: (f: { id: string }) => NumberRefresh) => vi.fn(async (_g: unknown, fs: Array<{ id: string }>) => ({ results: fs.map(r), usage: usage({ searchCalls: 1, modelCalls: 1 }) }));
  const build = (opts: { facts: ReturnType<typeof fact>[]; refresh?: ReturnType<typeof refresher> | null; angles?: ReturnType<typeof story>; completed?: typeof afterGame6; write?: ReturnType<typeof vi.fn> }) => {
    const verifier = opts.refresh === null ? null : ({ name: "fake", verifyFacts: verifierOf(() => "confirmed"), ...(opts.refresh ? { refreshNumbers: opts.refresh } : {}) } as never);
    return setup({ loadGame: withGames(opts.completed ?? afterGame6), providers: { research: { name: "fake", research: async () => ({ facts: opts.facts, sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...(opts.angles ?? story()), usage: usage({ modelCalls: 1 }) }) }, factVerifier: verifier, ...(opts.write ? { writer: { name: "fake", write: opts.write as never } } : {}) }, config: { maxSearchCallsPerGame: 8 } });
  };
  const draftCiting = (ids: string[], text = "Tennessee averages 60.4 rushing yards per game.") => vi.fn<GamePreviewWriterProvider["write"]>(async (_g, a) => draftOf({ preview: text, claims: ids.filter((i) => a.factIds.includes(i)).map((i) => ({ text, factIds: [i] })) }));

  it("(tests A, B) the 60.4 figure is flagged, refreshed, and the CURRENT value (59.8, through Game 6) replaces it before the writer sees it", async () => {
    const refresh = refresher((f) => ({ factId: f.id, status: "updated", note: "ESPN stats through Game 6", fact: { claim: "Tennessee averages 59.8 rushing yards per game through six games.", excerpt: "Tennessee: 59.8 rushing yards per game through 6 games", sourceUrl: "https://www.espn.com/nfl/story/_/id/9/titans-run-game", sourceTitle: "Titans run game", sourceProvider: "ESPN", publishedAt: "2026-10-19T14:00:00.000Z", asOf: "2026-10-18T06:00:00.000Z", asOfLabel: "through 6 games" } }));
    const write = draftCiting(["f1"], "Tennessee averages 59.8 rushing yards per game.");
    const t = build({ facts: [stat()], refresh, write });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    const sent = write.mock.calls[0][2].find((f: { id: string }) => f.id === "f1")!;
    expect(sent.claim).toMatch(/59\.8/);
    expect(JSON.stringify(write.mock.calls[0][2])).not.toContain("60.4");
    const d = t.runs[0].details as { staleCandidates: Array<{ factId: string; outcome?: string }>; numberRefreshes: Array<{ from: string; to: string }> };
    expect(d.staleCandidates).toEqual([expect.objectContaining({ factId: "f1", outcome: "updated" })]);
    expect(d.numberRefreshes[0]).toMatchObject({ from: expect.stringContaining("60.4"), to: expect.stringContaining("59.8") });
  });

  it("the same value confirmed current through the latest Game is allowed", async () => {
    const write = draftCiting(["f1"]);
    const t = build({ facts: [stat()], refresh: refresher((f) => ({ factId: f.id, status: "confirmed", note: "still 60.4 through Game 6" })), write });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(JSON.stringify(write.mock.calls[0][2])).toContain("60.4");
    expect((t.runs[0].details as { staleCandidates: Array<{ outcome?: string }> }).staleCandidates[0].outcome).toBe("confirmed");
  });

  it("an update whose own evidence still predates the latest Game is not accepted: the number is removed", async () => {
    const refresh = refresher((f) => ({ factId: f.id, status: "updated", note: "x", fact: { claim: "Tennessee averages 61.2 yards through four games.", excerpt: "61.2", sourceUrl: "https://www.espn.com/nfl/story/_/id/8/older", sourceTitle: "older", sourceProvider: "ESPN", publishedAt: "2026-10-05T10:00:00.000Z", asOf: null, asOfLabel: "through 4 games" } }));
    const t = build({ facts: [stat()], refresh });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED", error: "story_not_verified" });
    expect((t.runs[0].details as { staleCandidates: Array<{ outcome?: string }> }).staleCandidates[0].outcome).toBe("removed");
  });

  it("(test C) a FIXED number is never refreshed or removed, however many Games came after it", async () => {
    const fixed = stat({ numberKind: "FIXED", claim: "Tennessee gained 118 rushing yards against Chicago on Oct. 5.", asOfLabel: null });
    const refresh = refresher((f) => ({ factId: f.id, status: "unavailable", note: "should never be called" }));
    const write = draftCiting(["f1"], "Tennessee gained 118 rushing yards against Chicago on Oct. 5.");
    const t = build({ facts: [fixed], refresh, write });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(refresh).not.toHaveBeenCalled();
    expect((t.runs[0].details as { staleCandidates: unknown[] }).staleCandidates).toEqual([]);
  });

  it("(test F) a current source published after the latest completed Game is not flagged", async () => {
    const refresh = refresher((f) => ({ factId: f.id, status: "unavailable", note: "x" }));
    const t = build({ facts: [stat({ publishedAt: "2026-10-18T20:00:00.000Z" })], refresh, write: draftCiting(["f1"]) });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("an opener (no completed Game yet) has nothing to be stale against", async () => {
    const t = build({ facts: [stat({ publishedAt: "2026-09-01T10:00:00.000Z" })], completed: [], refresh: refresher((f) => ({ factId: f.id, status: "unavailable", note: "x" })), write: draftCiting(["f1"]) });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
  });

  it("salvage: a stale PERIPHERAL number that cannot be refreshed is removed and the story is kept without it", async () => {
    const central = fact({ id: "f3", sourceUrl: "https://www.nfl.com/news/colts-steelers-recap" });
    const refresh = refresher((f) => ({ factId: f.id, status: "unavailable", note: "no current value" }));
    const write = draftCiting(["f3"], "Indianapolis is 2-3.");
    const t = build({ facts: [central, stat()], angles: story(["f3", "f1"], ["f3"]), refresh, write });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(write.mock.calls[0][1].factIds).toEqual(["f3"]);
    expect((t.runs[0].details as { factsRemoved: Array<{ factId: string }> }).factsRemoved.some((r) => r.factId === "f1")).toBe(true);
  });

  it("a stale CENTRAL number that cannot be refreshed drops the story; the next-best story is used (attempts unchanged)", async () => {
    const fallback = fact({ id: "f3", sourceUrl: "https://www.nfl.com/news/colts-steelers-recap" });
    const two = { ...selection, angles: [{ ...selection.angles[0], id: "a1", factIds: ["f1"], centralFactIds: ["f1"], summary: "A rushing slump." }, { ...selection.angles[0], id: "a2", type: "HOT_VS_COLD" as const, factIds: ["f3"], centralFactIds: ["f3"], summary: "A recap." }], selectedId: "a1" };
    const write = draftCiting(["f3"], "Indianapolis is 2-3.");
    const t = build({ facts: [stat(), fallback], angles: two, refresh: refresher((f) => ({ factId: f.id, status: "unavailable", note: "none" })), write });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(write.mock.calls[0][1].id).toBe("a2");
    expect((t.runs[0].details as { storyAttempts: Array<{ angleId: string; outcome: string }> }).storyAttempts[0]).toMatchObject({ angleId: "a1", outcome: "collapsed" });
  });

  it("without any refresh capability a stale number is removed, never published as current", async () => {
    const t = build({ facts: [stat()], refresh: undefined });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED" });
    expect(t.saves).toHaveLength(0);
  });

  it("(tests D, E) a FIXED 'entering the season' figure written as the current one is blocked by the reviewer (which is told it is fixed); written as entering-season history it is allowed", async () => {
    const entering = fact({ id: "f1", sourceUrl: ESPN_STORY, numberKind: "FIXED", asOfLabel: "entering the season", claim: "Ovechkin entered the season with 929 career goals.", excerpt: "Ovechkin enters the season with 929 career goals", publishedAt: "2026-10-05T10:00:00.000Z" });
    const already = draftOf({ hook: "Ovechkin already has 929", preview: "Ovechkin already has 929 goals. Can he add one tonight?", claims: [{ text: "Ovechkin has 929 goals.", factIds: ["f1"] }] });
    const honest = draftOf({ hook: "Ovechkin entered the season with 929", preview: "Ovechkin entered the season with 929 career goals. Can he add one tonight?", claims: [{ text: "Ovechkin entered the season with 929 career goals.", factIds: ["f1"] }] });
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async (_g, _a, _f, ctx) => (ctx.feedback.length === 0 ? already : honest));
    const verify = vi.fn<GamePreviewVerifierProvider["verify"]>(async (_g, _a, d, _f, _c, hints) => ({ blocking: /already has/i.test(d.preview) && (hints?.fixedNumbers?.length ?? 0) > 0 ? [{ category: "stale_current" as const, problem: "929 was the entering-season total, written as the current total." }] : [], advisory: [], usage: usage({ modelCalls: 1 }) }));
    const t = setup({ loadGame: withGames(afterGame6), providers: { research: { name: "fake", research: async () => ({ facts: [entering], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story(), usage: usage({ modelCalls: 1 }) }) }, writer: { name: "fake", write }, verifier: { name: "fake", verify } } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(t.saves[0].hook).toBe(honest.hook);
    expect(verify.mock.calls[0][5]?.fixedNumbers?.join(" ")).toMatch(/entering the season/);
  });
});

describe("syndication, credit identity and secondary materiality", () => {
  const YAHOO = "https://sports.yahoo.com/articles/walker-returns-123.html";
  const syndicated = (over = {}) => fact({ id: "f1", sourceUrl: YAHOO, sourceProvider: "ESPN", sourceTitle: "Walker returns", originalPublisher: "ESPN", ...over });
  const only = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f1"], centralFactIds: ["f1"], summary: "A return." }], selectedId: "a1" };
  const buildOne = (f: ReturnType<typeof fact>, extra: Parameters<typeof setup>[0] = {}) => setup({ providers: { research: { name: "fake", research: async () => ({ facts: [f], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...only, usage: usage({ modelCalls: 1 }) }) }, writer: { name: "fake", write: async (_g, a) => draftOf({ claims: [{ text: "Tennessee is 0-5 after a 26-3 loss to Houston.", factIds: [a.factIds[0]] }] }) }, ...(extra.providers ?? {}) }, config: { maxSearchCallsPerGame: 8 } });

  it("a Yahoo page whose original publisher is already trusted satisfies the trust requirement, credited as that publisher with the actual URL kept", async () => {
    const t = buildOne(syndicated());
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(t.saves[0].sources[0]).toMatchObject({ url: YAHOO, provider: "ESPN" });
    expect((t.saves[0].meta as { publicSourceUrls: string[] }).publicSourceUrls).toEqual([YAHOO]);
  });

  it("a Yahoo page with an untrusted or unidentified original publisher stays untrusted (no credit lookup available: not published)", async () => {
    for (const original of ["Chiefs Wire", null]) {
      const t = buildOne(syndicated({ originalPublisher: original, sourceProvider: original ?? "Yahoo Sports" }));
      expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED" });
      expect(t.saves).toHaveLength(0);
    }
  });

  it("the original publisher's own readable page is preferred for the public link when the approved lookup finds it", async () => {
    const original = { url: "https://www.espn.com/nfl/story/_/id/5/walker-returns", title: "Walker returns", provider: "ESPN", publishedAt: "2026-10-19T12:00:00.000Z", excerpt: "Walker returns to Lumen Field." };
    const findTrustedSources = vi.fn(async (_g: unknown, fs: Array<{ id: string }>) => ({ found: fs.map((f) => ({ factId: f.id, hit: original })), usage: usage({ searchCalls: 1, modelCalls: 1 }) }));
    const t = buildOne(syndicated(), { providers: { factVerifier: { name: "fake", verifyFacts: verifierOf(() => "confirmed"), findTrustedSources } as never } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(findTrustedSources).toHaveBeenCalledOnce();
    expect((t.saves[0].meta as { publicSourceUrls: string[] }).publicSourceUrls).toEqual([original.url]);
    expect(t.saves[0].sources.map((x) => x.url)).toEqual(expect.arrayContaining([original.url]));
  });

  it("(test N) a secondary source backing only a claim that is NOT in the public title or caption is not shown; the same source is shown when the caption states its claim", async () => {
    const primary = fact({ id: "f1", sourceUrl: "https://www.espn.com/nfl/story/_/id/1/titans-winless" });
    const schedule = fact({ id: "f3", category: "context", claim: "The game is Sunday, Oct. 25 at 1:25 p.m. at Allegiant Stadium.", excerpt: "Oct. 25, 1:25 p.m., Allegiant Stadium", sourceUrl: "https://www.nfl.com/news/schedule-release-notes", sourceProvider: "NFL.com", sourceTitle: "Schedule release notes" });
    const story = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f1", "f3"], centralFactIds: ["f1"], summary: "A winless team." }], selectedId: "a1" };
    const run = async (preview: string) => {
      const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [primary, schedule], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, writer: { name: "fake", write: async () => draftOf({ hook: "Zero wins in five.", preview, claims: [{ text: "Tennessee is 0-5 after a 26-3 loss to Houston.", factIds: ["f1"] }, { text: "The game is Sunday, Oct. 25 at 1:25 p.m. at Allegiant Stadium.", factIds: ["f3"] }] }) } } });
      await generateGamePreview(t.deps, req);
      return { pub: (t.saves[0].meta as { publicSourceUrls: string[] }).publicSourceUrls, stored: t.saves[0].sources.map((x) => x.url) };
    };
    const hidden = await run("Tennessee is 0-5 after a 26-3 loss to Houston. Does it end in Indianapolis?");
    expect(hidden.pub).toEqual([primary.sourceUrl]);
    expect(hidden.stored).toContain(schedule.sourceUrl); // internal provenance keeps it
    const shown = await run("Tennessee is 0-5 after a 26-3 loss to Houston. The game is Sunday, Oct. 25 at 1:25 p.m. at Allegiant Stadium.");
    expect(shown.pub).toEqual([primary.sourceUrl, schedule.sourceUrl]);
  });
});

describe("D1: subject integrity is a blocking finding handled like any other blocker", () => {
  const sweeney = fact({ id: "f1", sourceUrl: "https://www.espn.com/nba/story/_/id/1/magic-new-coach", claim: "Sean Sweeney was hired as the Orlando Magic head coach to build on the defense and unlock the scoring.", excerpt: "The Magic hired Sean Sweeney to replace Jamahl Mosley." });
  const story = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f1"], centralFactIds: ["f1"], summary: "A new coach." }], selectedId: "a1" };
  const draftWith = (text: string) => draftOf({ hook: "New coach in Orlando", preview: text, claims: [{ text: "Sean Sweeney was hired as the Magic head coach.", factIds: ["f1"] }] });
  // The reviewer is a model; the fake stands in for its semantic call and records what the pipeline does with it.
  const run = async (drafts: string[], reviewer: (d: { preview: string }) => { blocking: Array<{ category: "subject_mismatch"; problem: string }>; advisory: Array<{ kind: "wording_tone"; note: string }> }) => {
    let i = 0;
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async () => draftWith(drafts[Math.min(i++, drafts.length - 1)]));
    const verify = vi.fn<GamePreviewVerifierProvider["verify"]>(async (_g, _a, d) => ({ ...reviewer(d), usage: usage({ modelCalls: 1 }) }));
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [sweeney], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, writer: { name: "fake", write }, verifier: { name: "fake", verify } } });
    const out = await generateGamePreview(t.deps, req);
    return { out, t, write };
  };
  const none = { blocking: [], advisory: [] };

  it("(A) 'The team was hired...' for a coach's hiring is BLOCKED, the writer is told why, and the corrected sentence (B) is saved", async () => {
    const { out, t, write } = await run(["The team was hired to improve the offense.", "Sweeney was hired to help improve Orlando's offense."], (d) => (/^The team was hired/.test(d.preview) ? { blocking: [{ category: "subject_mismatch", problem: "'The team was hired' but the fact says Sean Sweeney, the coach, was hired." }], advisory: [] } : none));
    expect(out.status).toBe("SUCCEEDED");
    expect(write.mock.calls[1][3].feedback.join(" ")).toMatch(/subject_mismatch\] 'The team was hired'/);
    expect(t.saves[0].body).toMatch(/^Sweeney was hired/);
    expect((t.runs[0].details as { blockingCounts: { reviewerByCategory: Record<string, number> } }).blockingCounts.reviewerByCategory.subject_mismatch).toBe(1);
  });

  it("(C) one player's injury attributed to another is BLOCKED on every attempt it appears in: nothing is saved", async () => {
    const { out, t } = await run(["Bosa is out with a hamstring injury and Samuel has a calf strain."], () => ({ blocking: [{ category: "subject_mismatch", problem: "The hamstring injury belongs to Deebo Samuel, not Nick Bosa." }], advisory: [] }));
    expect(out).toMatchObject({ status: "REJECTED", error: "draft_rejected" });
    expect(t.saves).toHaveLength(0);
  });

  it("(D) the right subject in awkward prose is advisory at most: it is saved (after at most one polish rewrite) and never rejected", async () => {
    const { out, t } = await run(["Sweeney, hired by Orlando, being the one who was brought in to fix the offense, is the new coach."], () => ({ blocking: [], advisory: [{ kind: "wording_tone", note: "Clumsy sentence, correct subject." }] }));
    expect(out.status).toBe("SUCCEEDED");
    expect(t.saves).toHaveLength(1);
    expect((t.runs[0].details as { blockingCounts: { reviewer: number } }).blockingCounts.reviewer).toBe(0);
  });
});

describe("D2: the credit lookup enriches provenance and never replaces the evidence that supported the claim", () => {
  const YAHOO = "https://sports.yahoo.com/articles/dybantsa-out-1.html";
  const FULL = "Wizards rookie AJ Dybantsa will miss Wednesday night's season opener against Milwaukee with a mild ankle sprain suffered in Friday's preseason finale.";
  const orig = () => fact({ id: "f1", sourceUrl: YAHOO, sourceProvider: "Yahoo Sports", sourceTitle: "Dybantsa out", claim: "AJ Dybantsa will miss Wednesday's season opener with an ankle sprain.", excerpt: FULL });
  const hit = { url: "https://www.espn.com/nba/story/_/id/50229436/wizards-aj-dybantsa-ankle-miss-season-opener", title: "Dybantsa to miss opener", provider: "ESPN", publishedAt: "2026-10-20T17:10:00.000Z", excerpt: "Dybantsa has a mild ankle sprain and will be day-to-day." };
  const story = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f1"], centralFactIds: ["f1"], summary: "A debut delayed." }], selectedId: "a1" };
  const build = (lookup: ((fs: Array<{ id: string }>) => Array<{ factId: string; hit: typeof hit | null }>) | null, check: FactCheck["status"] = "confirmed", write?: ReturnType<typeof vi.fn>, verify?: ReturnType<typeof vi.fn>) => {
    const findTrustedSources = vi.fn(async (_g: unknown, fs: Array<{ id: string }>) => ({ found: lookup ? lookup(fs) : [], usage: usage({ searchCalls: 1, modelCalls: 1 }) }));
    const t = setup({
      providers: {
        research: { name: "fake", research: async () => ({ facts: [orig()], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) },
        angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) },
        factVerifier: { name: "fake", verifyFacts: verifierOf(() => check), findTrustedSources } as never,
        writer: { name: "fake", write: (write ?? vi.fn(async (_g: unknown, a: { factIds: string[] }) => draftOf({ preview: "Dybantsa will miss the opener.", claims: a.factIds.map((id) => ({ text: "Dybantsa will miss the opener.", factIds: [id] })) }))) as never },
        ...(verify ? { verifier: { name: "fake", verify: verify as never } } : {}),
      },
      config: { maxSearchCallsPerGame: 8 },
    });
    return { t, findTrustedSources };
  };

  it("(A, E) the original passage is preserved and attached to the trusted fact; the canonical claim text and the original fact are not mutated", async () => {
    const write = vi.fn(async (...args: [unknown, { factIds: string[] }, unknown]) => draftOf({ preview: "Dybantsa will miss the opener.", claims: args[1].factIds.map((id) => ({ text: "Dybantsa will miss the opener.", factIds: [id] })) }));
    const { t } = build((fs) => fs.map((f) => ({ factId: f.id, hit })), "confirmed", write);
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    const sent = write.mock.calls[0][2] as ReturnType<typeof fact>[];
    const trusted = sent.find((f) => f.id === "f1t")!;
    const original = sent.find((f) => f.id === "f1")!;
    expect(trusted.excerpt).toBe(hit.excerpt); // the shorter trusted passage
    expect(trusted.alsoSupportedBy?.[0]).toMatchObject({ url: YAHOO, provider: "Yahoo Sports", excerpt: FULL }); // the original passage preserved
    expect(trusted.claim).toBe(orig().claim); // canonical claim text untouched
    expect(original).toMatchObject({ id: "f1", sourceUrl: YAHOO, excerpt: FULL, claim: orig().claim }); // the original fact stays as it was
    expect((write.mock.calls[0][1] as { factIds: string[] }).factIds).toEqual(["f1t", "f1"]); // trusted page first (public credit), original still in the story
  });

  it("(B) both are stored as provenance when both are cited, and the trusted page is the public credit", async () => {
    const { t } = build((fs) => fs.map((f) => ({ factId: f.id, hit })));
    await generateGamePreview(t.deps, req);
    expect(t.saves[0].sources.map((x) => x.url)).toEqual(expect.arrayContaining([hit.url, YAHOO]));
    expect((t.saves[0].meta as { publicSourceUrls: string[] }).publicSourceUrls).toEqual([hit.url]);
  });

  it("(C) a trusted page that does not show the exact sentence does not cost the claim its support: the reviewer is given the facts that carry the original passage too", async () => {
    const verify = vi.fn<GamePreviewVerifierProvider["verify"]>(async () => ({ blocking: [], advisory: [], usage: usage({ modelCalls: 1 }) }));
    const { t } = build((fs) => fs.map((f) => ({ factId: f.id, hit })), "confirmed", undefined, verify);
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    const facts = verify.mock.calls[0][3] as ReturnType<typeof fact>[];
    expect(facts.find((f) => f.id === "f1t")?.alsoSupportedBy?.[0].excerpt).toBe(FULL);
    expect(facts.some((f) => f.id === "f1" && f.excerpt === FULL)).toBe(true);
  });

  it("(D) when the original evidence does not support the claim and the lookup cannot either, the story is still not used", async () => {
    const { t, findTrustedSources } = build((fs) => fs.map((f) => ({ factId: f.id, hit: null })), "unsupported");
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED" });
    expect(findTrustedSources).not.toHaveBeenCalled(); // an unsupported claim is dropped before any credit is looked for
    expect(t.saves).toHaveLength(0);
  });

  it("a lookup that finds nothing leaves the original evidence untouched and the story is not credited", async () => {
    const { t } = build((fs) => fs.map((f) => ({ factId: f.id, hit: null })));
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED", error: "no_trusted_primary_source" });
  });
});

describe("last blockers: superseded evidence is not a current conflict (Broncos case)", () => {
  const nbc = fact({ id: "f1", kind: "current", sourceUrl: "https://www.espn.com/nfl/story/_/id/1/pelissero-nfl-reinstates-cooper", sourceProvider: "ESPN", claim: "The NFL reinstated Jonathon Cooper from the commissioner's exempt list.", excerpt: "Pelissero reports the NFL has reinstated Cooper from the commissioner's exempt list. An earlier item said he was on the list.", publishedAt: "2026-10-16T19:44:00.000Z" });
  const story = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f1"], centralFactIds: ["f1"], summary: "A reinstatement." }], selectedId: "a1" };
  const draftOfText = (preview: string) => draftOf({ hook: "Cooper is back", preview, claims: [{ text: "The NFL reinstated Cooper.", factIds: ["f1"] }] });
  const run = async (drafts: string[], review: (d: { preview: string }, conflicts: Array<{ kind: string }> | undefined) => Array<{ category: "stale_conflict"; problem: string }>, conflicts: Array<{ topic: string; note: string; kind: "TRUE_CONFLICT" | "SUPERSEDED" | "HISTORICAL_DIFFERENCE" }>) => {
    let i = 0;
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async () => draftOfText(drafts[Math.min(i++, drafts.length - 1)]));
    const verify = vi.fn<GamePreviewVerifierProvider["verify"]>(async (_g, _a, d, _f, _c, hints) => ({ blocking: review(d, hints?.conflicts), advisory: [], usage: usage({ modelCalls: 1 }) }));
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [nbc], sources, conflicts, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, writer: { name: "fake", write }, verifier: { name: "fake", verify } } });
    return { out: await generateGamePreview(t.deps, req), t, write, verify };
  };
  const superseded = [{ topic: "Cooper's status", note: "Oct 16 NFL.com/NBC: reinstated; an older item listed him as exempt", kind: "SUPERSEDED" as const }];
  // The reviewer is a model; the fake applies the rule it is given: an "unsettled / another report still says" claim is blocked unless the disagreement is a TRUE_CONFLICT.
  const rule = (d: { preview: string }, conflicts: Array<{ kind: string }> | undefined) => (/unsettled|still (lists|says|describes)/i.test(d.preview) && !(conflicts ?? []).some((c) => c.kind === "TRUE_CONFLICT") ? [{ category: "stale_conflict" as const, problem: "the 'still says' item is older than the reinstatement report" }] : []);

  it("(A) 'His status is unsettled because another report still lists him as exempt' is BLOCKED when the disagreement is SUPERSEDED, and the writer is told why", async () => {
    const { out, t, write, verify } = await run(["His status is unsettled because another report still lists him as exempt.", "The NFL reinstated Cooper, who had been on the exempt list."], rule, superseded);
    expect(out.status).toBe("SUCCEEDED");
    expect(write.mock.calls[1][3].feedback.join(" ")).toMatch(/stale_conflict\]/);
    expect(t.saves[0].body).toMatch(/reinstated Cooper/);
    expect(verify.mock.calls[0][5]?.conflicts).toEqual([{ topic: "Cooper's status", kind: "SUPERSEDED", note: expect.any(String) }]); // the classification reaches the reviewer
    expect((t.runs[0].details as { blockingCounts: { reviewerByCategory: Record<string, number> } }).blockingCounts.reviewerByCategory.stale_conflict).toBe(1);
  });

  it("(B) 'He was reinstated after previously being on the exempt list' is allowed", async () => {
    const { out, t } = await run(["He was reinstated after previously being on the exempt list."], rule, superseded);
    expect(out.status).toBe("SUCCEEDED");
    expect(t.saves[0].body).toMatch(/reinstated after previously/);
  });

  it("(C) a genuine same-day disagreement (TRUE_CONFLICT) may be reported cautiously", async () => {
    const { out } = await run(["Two reports disagree on his status, so it is unsettled."], rule, [{ topic: "Cooper's status", note: "two Oct 20 sources disagree", kind: "TRUE_CONFLICT" }]);
    expect(out.status).toBe("SUCCEEDED");
  });
});

describe("last blockers: a cut-off stored passage is expanded before it is trusted", () => {
  const CUT = "Sunday's game will be the first time Trey Hendrickson gets his chance at Joe Burrow. Brown said when asked if Hendrickson would have extra motivation.";
  const FULLP = `${CUT} "I imagine he will have a little something extra to play for."`;
  const f = () => fact({ id: "f1", sourceUrl: "https://www.espn.com/nfl/story/_/id/2/revenge-game-orlando-brown-jr", sourceProvider: "ESPN", claim: "Orlando Brown Jr. says Hendrickson should have extra motivation against his former team.", excerpt: CUT, kind: "current", publishedAt: "2026-10-20T10:00:00.000Z" });
  const story = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f1"], centralFactIds: ["f1"], summary: "A revenge game." }], selectedId: "a1" };
  const build = (verifyFacts: ReturnType<typeof vi.fn>, write?: ReturnType<typeof vi.fn>) => setup({ providers: { research: { name: "fake", research: async () => ({ facts: [f()], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, factVerifier: { name: "fake", verifyFacts } as never, ...(write ? { writer: { name: "fake", write: write as never } } : {}) } });
  const checks = (status: "confirmed" | "unsupported", passage: string | null) => vi.fn(async (_g: unknown, fs: Array<{ id: string }>) => ({ checks: fs.map((x) => ({ factId: x.id, status, basis: "targeted_search" as const, retrievalFailed: false, note: "n", corroboratingUrl: null, passage })), usage: usage({ searchCalls: 1, modelCalls: 1 }) }));

  it("(A, B) the cut-off passage makes the fact an exception; the complete passage the targeted search found replaces it, so the writer and reviewer see the answer", async () => {
    const write = vi.fn(async (...args: [unknown, { factIds: string[] }, unknown]) => draftOf({ preview: "Brown says Hendrickson should have extra motivation.", claims: [{ text: "Brown says Hendrickson should have extra motivation.", factIds: [args[1].factIds[0]] }] }));
    const t = build(checks("confirmed", FULLP), write);
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect((t.runs[0].details as { exceptionReasons: Record<string, string[]> }).exceptionReasons.f1.join(" ")).toMatch(/stored passage looks cut off/);
    const sent = (write.mock.calls[0][2] as ReturnType<typeof fact>[]).find((x) => x.id === "f1")!;
    expect(sent.excerpt).toBe(FULLP);
  });

  it("(C) if the passage cannot be expanded, it stays unsupported: the fact is dropped, never trusted", async () => {
    const t = build(checks("unsupported", null));
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED" });
    expect(t.saves).toHaveLength(0);
  });

  it("(E) a concise passage that is complete is NOT sent for extra verification", async () => {
    const verifyFacts = checks("confirmed", null);
    const done = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [{ ...f(), kind: "historical", excerpt: 'Asked whether Hendrickson would have extra motivation, Brown said: "I imagine he will have a little something extra to play for."' }], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, factVerifier: { name: "fake", verifyFacts } as never } });
    await generateGamePreview(done.deps, req);
    expect(verifyFacts).not.toHaveBeenCalled();
  });
});

describe("last blockers: one search is held for the trusted public-credit lookup only when it is needed", () => {
  const YAHOO = "https://sports.yahoo.com/articles/mayfield-thumb-1.html";
  const hit = { url: "https://www.nfl.com/news/mayfield-thumb-update", title: "Mayfield thumb update", provider: "NFL.com", publishedAt: "2026-10-20T15:00:00.000Z", excerpt: "Bowles said Tampa Bay is planning as if Daniels starts; this is an evaluation week for Mayfield's thumb." };
  const afterGame = [{ team: "Tampa Bay Buccaneers", completedUtc: "2026-10-18T22:00:00.000Z" }];
  const stat = (url: string, over = {}) => fact({ id: "f1", kind: "current", numberKind: "CURRENT_STATE", subjectTeam: "Tampa Bay Buccaneers", sourceUrl: url, sourceProvider: "Yahoo Sports", claim: "Tampa Bay is 1-5 and Mayfield has been out since Week 3.", excerpt: "Tampa Bay (1-5) is planning as if Daniels starts.", publishedAt: "2026-10-16T12:00:00.000Z", ...over });
  const story = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f1"], centralFactIds: ["f1"], summary: "A QB question." }], selectedId: "a1" };
  type Ctx = { maxSearchCalls: number };
  const build = (central: ReturnType<typeof fact>, o: { researchSearches?: number; found?: typeof hit | null; ceiling?: number } = {}) => {
    const seen: { refresh: number[]; verify: number[]; lookup: number } = { refresh: [], verify: [], lookup: 0 };
    const factVerifier = {
      name: "fake",
      verifyFacts: vi.fn(async (_g: unknown, fs: Array<{ id: string }>, ctx: Ctx) => { seen.verify.push(ctx.maxSearchCalls); return { checks: fs.map((x) => ({ factId: x.id, status: "confirmed" as const, basis: "targeted_search" as const, retrievalFailed: false, note: "n", corroboratingUrl: null })), usage: usage({ searchCalls: 1, modelCalls: 1 }) }; }),
      refreshNumbers: vi.fn(async (_g: unknown, fs: Array<{ id: string }>, ctx: Ctx) => { seen.refresh.push(ctx.maxSearchCalls); return { results: fs.map((x) => ({ factId: x.id, status: "confirmed" as const, note: "still 1-5" })), usage: usage({ searchCalls: 1, modelCalls: 1 }) }; }),
      findTrustedSources: vi.fn(async (_g: unknown, fs: Array<{ id: string }>) => { seen.lookup++; return { found: fs.map((x) => ({ factId: x.id, hit: o.found === undefined ? hit : o.found })), usage: usage({ searchCalls: 1, modelCalls: 1 }) }; }),
    };
    const t = setup({
      loadGame: async () => ({ ...game, lastCompleted: afterGame }),
      providers: {
        research: { name: "fake", research: async () => ({ facts: [central], sources, usage: usage({ searchCalls: o.researchSearches ?? 5, modelCalls: 1 }) }) },
        angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) },
        factVerifier: factVerifier as never,
        writer: { name: "fake", write: async (_g, a) => draftOf({ preview: "Tampa Bay is planning as if Daniels starts.", claims: [{ text: "Tampa Bay is planning as if Daniels starts.", factIds: [a.factIds[0]] }] }) },
      },
      config: { maxSearchCallsPerGame: o.ceiling ?? 8 },
    });
    return { t, seen, factVerifier };
  };

  it("a supported story that lacks an eligible public primary holds ONE search: freshness and verification cannot take it, so the lookup runs and succeeds", async () => {
    const { t, seen } = build(stat(YAHOO)); // research used 5 of 8; 3 remain
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("SUCCEEDED");
    expect(seen.refresh).toEqual([2]); // 3 left minus the reserve
    expect(seen.verify).toEqual([1]); // 2 left after the refresh, minus the reserve
    expect(seen.lookup).toBe(1);
    expect((t.saves[0].meta as { publicSourceUrls: string[] }).publicSourceUrls).toEqual([hit.url]);
    expect((t.runs[0].details as { creditReserve: Array<{ held: boolean }> }).creditReserve).toEqual([{ angleId: "a1", held: true }]);
  });

  it("a story that already has an eligible trusted public source holds nothing back: the full remaining ceiling is available", async () => {
    const { t, seen } = build(stat("https://www.nfl.com/news/bucs-mayfield-thumb", { sourceProvider: "NFL.com" }));
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(seen.refresh).toEqual([3]);
    expect(seen.lookup).toBe(0);
    expect((t.runs[0].details as { creditReserve: Array<{ held: boolean }> }).creditReserve).toEqual([{ angleId: "a1", held: false }]);
  });

  it("factual safety wins: with a single search left, verification may take it; the story is then not credited and the Game is needs_review", async () => {
    const { t, seen } = build(stat(YAHOO), { researchSearches: 7 }); // 1 left
    const out = await generateGamePreview(t.deps, req);
    expect(seen.refresh).toEqual([1]);
    expect(seen.lookup).toBe(0);
    expect(out).toMatchObject({ status: "REJECTED", error: "no_trusted_primary_source" });
    expect(t.saves).toHaveLength(0);
  });

  it("if the reserved lookup finds no eligible trusted page the Game is needs_review (no_trusted_primary_source); it does not keep searching to force a save", async () => {
    const { t, seen } = build(stat(YAHOO), { found: null });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED", error: "no_trusted_primary_source" });
    expect(seen.lookup).toBe(1);
    expect(t.saves).toHaveLength(0);
  });
});


describe("current player status: current, dated, trusted evidence (the Buccaneers regression)", () => {
  const BETTING = "https://www.si.com/betting/titans-vs-colts-prediction-odds-spread-injuries-trends-for-nfl-week-6-2026";
  const ESPN_REPORT = "https://www.espn.com/nfl/story/_/id/77/titans-quarterback-practice-report";
  const TEAM_REPORT = "https://www.colts.com/news/injury-report-friday";
  const NEWEST = "2026-10-17T16:00:00.000Z"; // 4 hours before NOW
  const QUESTIONABLE = "The Titans quarterback is questionable for Sunday.";
  // The one status fact of the story: by default, "questionable" from an UNDATED injury list on a betting page.
  const status = (over = {}) =>
    fact({ id: "f4", kind: "current", category: "injury", statusKind: "CURRENT_PLAYER_STATUS", claim: "SI's injury list shows the Titans quarterback as questionable.", excerpt: "Titans Injury Report. Quarterback - Questionable.", sourceUrl: BETTING, sourceProvider: "SI", sourceTitle: "Titans vs. Colts prediction, odds, spread, injuries", sourceType: "preview", publishedAt: null, subjectTeam: "Tennessee Titans", ...over });
  const withStatus = (central = false) => ({ ...selection, angles: selection.angles.map((a) => (a.id === "a1" ? { ...a, factIds: ["f1", "f3", "f4"], centralFactIds: central ? ["f4"] : ["f1", "f3"] } : a)) });
  const confirmer = (r: (f: { id: string }) => StatusConfirmation) => vi.fn(async (_g: unknown, fs: Array<{ id: string }>) => ({ results: fs.map(r), usage: usage({ searchCalls: 1, modelCalls: 1 }) }));
  const newest = (claim: string, url = ESPN_REPORT, over = {}) => ({ claim, excerpt: `${claim} (full passage)`, sourceUrl: url, sourceTitle: "Titans QB report", sourceProvider: "ESPN", publishedAt: NEWEST, sourceType: "article" as const, ...over });
  const writerOf = () =>
    vi.fn<GamePreviewWriterProvider["write"]>(async (_g, angle, fs) => {
      const st = fs.find((f) => f.id === "f4" && angle.factIds.includes("f4"));
      return draftOf({ claims: [...goodDraft.claims.filter((c) => c.factIds.every((id) => angle.factIds.includes(id))), ...(st ? [{ text: st.claim, factIds: ["f4"] }] : [])] });
    });
  function build(opts: { facts?: ReturnType<typeof fact>[]; story?: ReturnType<typeof withStatus>; confirm?: ReturnType<typeof confirmer> | null; researchSearches?: number; status?: ReturnType<typeof status>; extraVerifier?: Record<string, unknown> } = {}) {
    const st = opts.status ?? status();
    const verifier = { name: "fake", verifyFacts: verifierOf(() => "confirmed"), ...(opts.confirm ? { confirmPlayerStatus: opts.confirm } : {}), ...opts.extraVerifier } as never;
    const write = writerOf();
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: opts.facts ?? [...facts, st], sources, usage: usage({ searchCalls: opts.researchSearches ?? 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...(opts.story ?? withStatus()), usage: usage({ modelCalls: 1 }) }) }, writer: { name: "fake", write }, factVerifier: verifier } });
    return { t, write };
  }
  const checks = (t: ReturnType<typeof setup>) => (t.runs[0].details as { statusChecks: Array<{ factId: string; outcome: string; qualifies: boolean; issues: string[]; newSource?: string }> }).statusChecks;
  const sentFact = (write: ReturnType<typeof writerOf>, id: string) => write.mock.calls[0]?.[2].find((f) => f.id === id);

  it("(A) an undated betting-page 'questionable' cannot establish a current status: a newest-status search is run, it finds nothing, and the designation is REMOVED (the story stands without it)", async () => {
    const confirm = confirmer((f) => ({ factId: f.id, status: "unavailable", note: "no dated trusted report states any designation" }));
    const { t, write } = build({ confirm });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][1].map((f) => f.id)).toEqual(["f4"]);
    expect(sentFact(write, "f4")).toBeUndefined(); // the writer never sees the unsupported designation
    expect(JSON.stringify(t.saves[0].claims)).not.toMatch(/questionable/i);
    expect(checks(t)).toMatchObject([{ factId: "f4", outcome: "removed", qualifies: false }]);
    expect(checks(t)[0].issues.join(" ")).toMatch(/betting/);
    expect((t.runs[0].details as { factsRemoved: Array<{ factId: string }> }).factsRemoved.map((r) => r.factId)).toContain("f4");
  });

  it("(A) with no way to search for a qualifying source at all (no confirmation available, or no search left), the undated betting status is removed, never published", async () => {
    const none = build({ confirm: null });
    expect((await generateGamePreview(none.t.deps, req)).status).toBe("SUCCEEDED");
    expect(sentFact(none.write, "f4")).toBeUndefined();
    const confirm = confirmer((f) => ({ factId: f.id, status: "confirmed", note: "x", fact: newest(QUESTIONABLE) }));
    const spent = build({ confirm, researchSearches: 8 });
    expect((await generateGamePreview(spent.t.deps, req)).status).toBe("SUCCEEDED");
    expect(confirm).not.toHaveBeenCalled();
    expect(sentFact(spent.write, "f4")).toBeUndefined();
  });

  it("(B) a dated official team report that says 'questionable' qualifies on its own: no search is spent, and the status is allowed", async () => {
    const confirm = confirmer((f) => ({ factId: f.id, status: "unavailable", note: "unused" }));
    const { t, write } = build({ confirm, status: status({ claim: QUESTIONABLE, excerpt: "Quarterback (shoulder): questionable.", sourceUrl: TEAM_REPORT, sourceProvider: "Colts", sourceTitle: "Friday injury report", sourceType: "injury_report", publishedAt: NEWEST }) });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(confirm).not.toHaveBeenCalled();
    expect(sentFact(write, "f4")?.claim).toBe(QUESTIONABLE);
    expect(checks(t)).toMatchObject([{ factId: "f4", outcome: "qualified", qualifies: true }]);
  });

  it("(C) a dated trusted article (ESPN) that says 'questionable' qualifies: allowed", async () => {
    const confirm = confirmer((f) => ({ factId: f.id, status: "unavailable", note: "unused" }));
    const { t, write } = build({ confirm, status: status({ claim: QUESTIONABLE, excerpt: "The quarterback is questionable.", sourceUrl: ESPN_REPORT, sourceProvider: "ESPN", sourceTitle: "Titans QB report", sourceType: "article", publishedAt: NEWEST }) });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(confirm).not.toHaveBeenCalled();
    expect(sentFact(write, "f4")?.claim).toBe(QUESTIONABLE);
  });

  it("(D) the betting page says questionable; the dated official source gives a different state: the betting designation does not publish, the official state replaces it", async () => {
    const confirm = confirmer((f) => ({ factId: f.id, status: "updated", note: "the team report gives no designation", fact: newest("The Titans quarterback was a full participant in practice and has no injury designation.", TEAM_REPORT, { sourceProvider: "Colts", sourceType: "injury_report" }) }));
    const { t, write } = build({ confirm });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(sentFact(write, "f4")?.claim).toMatch(/no injury designation/);
    expect(sentFact(write, "f4")?.claim).not.toMatch(/questionable/i);
    expect(JSON.stringify(t.saves[0].claims)).not.toContain(BETTING);
    expect(t.saves[0].sources.map((x) => x.url)).not.toContain(BETTING);
    expect(checks(t)).toMatchObject([{ factId: "f4", outcome: "updated", newSource: TEAM_REPORT }]);
  });

  it("(D) a 'confirming' source that itself does not qualify (undated, betting, untrusted) does not rescue the designation", async () => {
    for (const bad of [newest(QUESTIONABLE, ESPN_REPORT, { publishedAt: null }), newest(QUESTIONABLE, BETTING), newest(QUESTIONABLE, "https://www.randomblog.net/titans-qb-update")]) {
      const confirm = confirmer((f) => ({ factId: f.id, status: "confirmed", note: "x", fact: bad }));
      const { t, write } = build({ confirm });
      expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
      expect(sentFact(write, "f4")).toBeUndefined();
      expect(checks(t)[0].outcome).toBe("removed");
    }
  });

  it("(E) a HISTORICAL fact ('was questionable before Week 3') is not a current status: the gate does not apply, and it is framed as history", async () => {
    const hist = status({ id: "f4", kind: "historical", statusKind: "NONE", claim: "The Titans quarterback was questionable before Week 3 and played.", excerpt: "He was questionable before Week 3.", sourceUrl: ESPN_REPORT, sourceProvider: "ESPN", sourceType: "recap", publishedAt: "2026-09-20T12:00:00.000Z" });
    const confirm = confirmer((f) => ({ factId: f.id, status: "unavailable", note: "unused" }));
    const { t, write } = build({ confirm, status: hist });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(confirm).not.toHaveBeenCalled();
    expect(sentFact(write, "f4")?.claim).toMatch(/was questionable before Week 3/);
    expect(checks(t)).toEqual([]);
    // Same, even from a betting page: history is not gated as a status (it is an exception that is verified like any other).
    const fromBetting = build({ confirm, status: { ...hist, sourceUrl: BETTING, sourceType: "preview" } });
    expect((await generateGamePreview(fromBetting.t.deps, req)).status).toBe("SUCCEEDED");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("(F) an older trusted 'questionable' and a newer trusted 'cleared': the newest credible status wins, and the older one is never written", async () => {
    const OLD = "2026-10-15T14:00:00.000Z";
    const confirm = confirmer((f) => ({ factId: f.id, status: "updated", note: "ESPN, 4 hours ago, says he was cleared", fact: newest("The Titans quarterback has been cleared and is expected to start.") }));
    const { t, write } = build({ confirm, status: status({ claim: QUESTIONABLE, excerpt: "Quarterback questionable.", sourceUrl: "https://www.nfl.com/news/titans-qb-questionable", sourceProvider: "NFL.com", sourceTitle: "Titans QB questionable", sourceType: "article", publishedAt: OLD }) });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(confirm).toHaveBeenCalledOnce(); // a qualifying but older report is checked for a newer status
    expect(sentFact(write, "f4")?.claim).toMatch(/cleared/);
    expect(JSON.stringify(t.saves[0].claims)).not.toMatch(/questionable/i);
    expect(checks(t)[0]).toMatchObject({ outcome: "updated", qualifies: true });
  });

  it("(F) the newest-status search never replaces a qualifying report with an OLDER one", async () => {
    const OLD = "2026-10-15T14:00:00.000Z";
    const confirm = confirmer((f) => ({ factId: f.id, status: "updated", note: "found an older report", fact: newest("The Titans quarterback was limited.", ESPN_REPORT, { publishedAt: "2026-10-14T10:00:00.000Z" }) }));
    const { t, write } = build({ confirm, status: status({ claim: QUESTIONABLE, excerpt: "Quarterback questionable.", sourceUrl: "https://www.nfl.com/news/titans-qb-questionable", sourceProvider: "NFL.com", sourceTitle: "Titans QB questionable", sourceType: "article", publishedAt: OLD }) });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(sentFact(write, "f4")?.claim).toBe(QUESTIONABLE);
  });

  it("(G) an unsupported status that is not central is removed and the story is SALVAGED: same story, supported wording, no new story needed", async () => {
    const confirm = confirmer((f) => ({ factId: f.id, status: "unavailable", note: "nothing qualifying" }));
    const { t } = build({ confirm });
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("SUCCEEDED");
    const d = t.runs[0].details as { storyAttempts: Array<{ angleId: string; outcome: string }>; chosenAngleId: string };
    expect(d.storyAttempts).toEqual([{ angleId: "a1", outcome: "used" }]);
    expect(d.chosenAngleId).toBe("a1");
  });

  it("(H) an unsupported status that IS the central fact collapses its story; with no supported alternative the Game is needs_review (current_status_not_supported)", async () => {
    const only = { ...selection, angles: [{ ...selection.angles[0], factIds: ["f4", "f1"], centralFactIds: ["f4"], summary: "The Titans quarterback's status decides the game." }], selectedId: "a1", rejected: [] };
    const confirm = confirmer((f) => ({ factId: f.id, status: "unavailable", note: "nothing qualifying" }));
    const { t } = build({ confirm, story: only as never });
    const out = await generateGamePreview(t.deps, req);
    expect(out).toMatchObject({ status: "REJECTED", error: "current_status_not_supported" });
    expect(t.saves).toHaveLength(0);
  });

  it("(H) with a supported alternative story, the next-best story is used instead of the one that rested on the unsupported status", async () => {
    const two = { ...selection, angles: [{ ...selection.angles[0], id: "a1", factIds: ["f4", "f1"], centralFactIds: ["f4"], summary: "The Titans quarterback's status decides the game." }, { ...selection.angles[0], id: "a2", type: "STREAK_ON_THE_LINE" as const, factIds: ["f1", "f3"], centralFactIds: ["f1"], summary: "Tennessee is winless." }], selectedId: "a1", rejected: [] };
    const confirm = confirmer((f) => ({ factId: f.id, status: "unavailable", note: "nothing qualifying" }));
    const { t } = build({ confirm, story: two as never });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    // The status story has no creditable primary (a betting page), so the supported story is preferred outright; either way the unsupported designation is never written.
    expect((t.runs[0].details as { storyAttempts: Array<{ angleId: string; outcome: string }> }).storyAttempts.map((a) => `${a.angleId}:${a.outcome}`)).toContain("a2:used");
    expect(JSON.stringify(t.saves[0].claims)).not.toMatch(/questionable/i);
  });

  it("the reviewer receives, for every cited fact, whether it is a status claim, its publisher, type, date, trust and whether it qualifies", async () => {
    const confirm = confirmer((f) => ({ factId: f.id, status: "unavailable", note: "unused" }));
    const { t } = build({ confirm, status: status({ claim: QUESTIONABLE, excerpt: "The quarterback is questionable.", sourceUrl: ESPN_REPORT, sourceProvider: "ESPN", sourceTitle: "Titans QB report", sourceType: "article", publishedAt: NEWEST }) });
    await generateGamePreview(t.deps, req);
    const hints = t.verify.mock.calls[0][5]!;
    expect(hints.statusEvidence).toContainEqual({ factId: "f4", statusClaim: true, publisher: "ESPN", sourceType: "article", publishedAt: NEWEST, trusted: true, qualifies: true, issues: [] });
    expect(hints.statusEvidence!.find((e) => e.factId === "f1")).toMatchObject({ statusClaim: false });
  });

  it("a search-result age is not a publication date: a fact dated only by the search tool cannot qualify, however recent", async () => {
    const confirm = confirmer((f) => ({ factId: f.id, status: "unavailable", note: "nothing qualifying" }));
    const { t, write } = build({ confirm, status: status({ claim: QUESTIONABLE, excerpt: "The quarterback is questionable.", sourceUrl: ESPN_REPORT, sourceProvider: "ESPN", sourceTitle: "Titans QB report", sourceType: "article", publishedAt: NEWEST, dateSource: "search_age" }) });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(confirm).toHaveBeenCalledOnce();
    expect(sentFact(write, "f4")).toBeUndefined();
    expect(checks(t)[0].issues.join(" ")).toMatch(/no reliable publication/);
  });
});

describe("JSON reliability at the pipeline: a recovered format retry continues the run and is recorded; a terminal one fails cleanly", () => {
  const recovery = { stage: "fact_check_targeted", model: "test-model", firstError: "The targeted check answer was not valid JSON.", retried: true, recovered: true };
  const withExceptionFact = () => {
    const injury = fact({ id: "f4", kind: "current", statusKind: "NONE", category: "record", claim: "Indianapolis is 3-3.", publishedAt: null });
    const story = { ...selection, angles: selection.angles.map((a) => (a.id === "a1" ? { ...a, factIds: ["f1", "f4"] } : a)) };
    return { injury, story };
  };
  const buildWith = (verifyFacts: GamePreviewFactVerifierProvider["verifyFacts"]) => {
    const { injury, story } = withExceptionFact();
    return setup({ providers: { research: { name: "fake", research: async () => ({ facts: [...facts, injury], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, factVerifier: { name: "fake", verifyFacts } } });
  };

  it("a recovered format retry does not stop the generation: the Preview is saved and the recovery is in the run record", async () => {
    const t = buildWith(async (_g, fs) => ({ checks: fs.map((f) => ({ factId: f.id, status: "confirmed" as const, basis: "targeted_search" as const, retrievalFailed: false, note: "ok", corroboratingUrl: null })), usage: usage({ searchCalls: 1, modelCalls: 3 }), parseRecoveries: [recovery] }));
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect((t.runs[0].details as { parseRecoveries: unknown[] }).parseRecoveries).toEqual([recovery]);
    expect(t.runs[0].searchCalls).toBe(4); // research 3 + the one verification search: the retry added none
  });

  it("a format retry that also fails is the existing controlled failure (fact_verification_failed), with nothing saved and the failed recovery recorded", async () => {
    const failed = { ...recovery, recovered: false, retryError: "no JSON" };
    const t = buildWith(async () => {
      throw Object.assign(new Error("The targeted check answer was not valid JSON, and the one format retry did not recover it."), { recovery: failed });
    });
    const out = await generateGamePreview(t.deps, req);
    expect(out).toMatchObject({ status: "FAILED" });
    expect((out as { error: string }).error).toMatch(/^fact_verification_failed: .*one format retry did not recover it/);
    expect(t.saves).toHaveLength(0);
    expect((t.runs[0].details as { parseRecoveries: unknown[] }).parseRecoveries).toEqual([failed]);
  });

  it("an unrecovered answer confirms nothing: a fact whose check never parsed is not treated as verified", async () => {
    const t = buildWith(async () => {
      throw Object.assign(new Error("not valid JSON"), { recovery: { ...recovery, recovered: false } });
    });
    await generateGamePreview(t.deps, req);
    expect(t.saves).toHaveLength(0);
    expect(t.write).not.toHaveBeenCalled();
  });
});

describe("scheduled (AUTOMATIC) runs use exactly the same pipeline, with their own identity and provenance", () => {
  const auto = { ...req, trigger: "AUTOMATIC" as const, actorId: "11111111-aaaa-4aaa-8aaa-111111111111", invocation: { id: "inv-123", kind: "REFRESH" as const } };

  it("(O) an automatic run never carries a human actor, even if one is passed, is recorded as AUTOMATIC with its scheduler invocation, and its outcome carries the run id", async () => {
    const t = setup();
    t.deps.recordRun = async (run) => {
      t.runs.push(run);
      return "run-abc";
    };
    const out = await generateGamePreview(t.deps, auto);
    expect(out.status).toBe("SUCCEEDED");
    expect(t.runs[0]).toMatchObject({ trigger: "AUTOMATIC", actorId: null });
    expect((t.runs[0].details as { invocation: unknown }).invocation).toEqual({ id: "inv-123", kind: "REFRESH" });
    expect(out.runId).toBe("run-abc");
    expect(t.saves[0].meta).toMatchObject({ trigger: "AUTOMATIC" });
  });

  it("an Admin run has no invocation (so the two kinds of run stay distinguishable)", async () => {
    const t = setup();
    await generateGamePreview(t.deps, req);
    expect((t.runs[0].details as { invocation: unknown }).invocation).toBeNull();
  });

  it("(U) the per-Game search ceiling is the stored one for a scheduled run too: research is handed it, nothing raises it", async () => {
    const t = setup();
    await generateGamePreview(t.deps, auto);
    expect(t.research.mock.calls[0][1].maxSearchCalls).toBe(config.maxSearchCallsPerGame);
    expect(config.maxSearchCallsPerGame).toBe(8);
  });

  it("(V) a scheduled run cannot publish without an eligible public primary source: the same rule as an Admin run", async () => {
    const betting = facts.map((f, i) => (i === 0 ? { ...f, sourceUrl: "https://www.si.com/betting/titans-colts-odds", sourceTitle: "Titans vs. Colts odds" } : f));
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: betting, sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...selection, angles: selection.angles.map((a) => (a.id === "a1" ? { ...a, factIds: ["f1"], centralFactIds: ["f1"] } : { ...a, scores: { tension: 1, surprise: 1, specificity: 1, humanInterest: 1, conversation: 1, recency: 1 } })), usage: usage({ modelCalls: 1 }) }) } } });
    const out = await generateGamePreview(t.deps, auto);
    expect(out.status).toBe("REJECTED");
    expect((out as { error: string }).error).toMatch(/no_trusted_primary_source|no_public_source|story_not_verified/);
    expect(t.saves).toHaveLength(0);
  });

  it("(T) the PR #120 JSON format retry behaves identically for a scheduled run: a recovered answer continues and is recorded, an unrecovered one is the same controlled failure", async () => {
    const recovery = { stage: "fact_check_targeted", model: "test-model", firstError: "not valid JSON", retried: true, recovered: true };
    const injury = fact({ id: "f4", kind: "current", statusKind: "NONE", category: "record", claim: "Indianapolis is 3-3.", publishedAt: null });
    const story = { ...selection, angles: selection.angles.map((a) => (a.id === "a1" ? { ...a, factIds: ["f1", "f4"] } : a)) };
    const build = (verifyFacts: GamePreviewFactVerifierProvider["verifyFacts"]) => setup({ providers: { research: { name: "fake", research: async () => ({ facts: [...facts, injury], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, factVerifier: { name: "fake", verifyFacts } } });
    const good = build(async (_g, fs) => ({ checks: fs.map((f) => ({ factId: f.id, status: "confirmed" as const, basis: "targeted_search" as const, retrievalFailed: false, note: "ok", corroboratingUrl: null })), usage: usage({ searchCalls: 1, modelCalls: 3 }), parseRecoveries: [recovery] }));
    expect((await generateGamePreview(good.deps, auto)).status).toBe("SUCCEEDED");
    expect((good.runs[0].details as { parseRecoveries: unknown[] }).parseRecoveries).toEqual([recovery]);
    const bad = build(async () => {
      throw Object.assign(new Error("The targeted check answer was not valid JSON, and the one format retry did not recover it."), { recovery: { ...recovery, recovered: false } });
    });
    const out = await generateGamePreview(bad.deps, auto);
    expect(out).toMatchObject({ status: "FAILED" });
    expect(bad.saves).toHaveLength(0);
  });

  it("a reviewer block is a rejection for a scheduled run exactly as for an Admin run: nothing is saved, whatever the trigger", async () => {
    const verify = vi.fn<GamePreviewVerifierProvider["verify"]>(async () => ({ blocking: [{ category: "unsupported_claim" as const, problem: "no support" }], advisory: [], usage: usage({ modelCalls: 1 }) }));
    const t = setup({ providers: { verifier: { name: "fake", verify } }, config: { maxAttempts: 2 } });
    const out = await generateGamePreview(t.deps, auto);
    expect(out.status).toBe("REJECTED");
    expect(t.saves).toHaveLength(0);
  });

  it("(J) the stored Preview says whether it states a current player status and when that status was last established, so the scheduler knows when it ages", async () => {
    const st = fact({ id: "f4", kind: "current", category: "injury", statusKind: "CURRENT_PLAYER_STATUS", claim: "The Titans quarterback is questionable.", excerpt: "The quarterback is questionable.", sourceUrl: "https://www.espn.com/nfl/story/_/id/77/titans-qb-report", sourceProvider: "ESPN", sourceTitle: "Titans QB report", sourceType: "article", publishedAt: "2026-10-17T16:00:00.000Z" });
    const story = { ...selection, angles: selection.angles.map((a) => (a.id === "a1" ? { ...a, factIds: ["f1", "f3", "f4"], centralFactIds: ["f1", "f3"] } : a)) };
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async () => draftOf({ claims: [...goodDraft.claims.filter((c) => c.factIds[0] !== "f2"), { text: st.claim, factIds: ["f4"] }] }));
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [...facts, st], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) }, angles: { name: "fake", selectAngle: async () => ({ ...story, usage: usage({ modelCalls: 1 }) }) }, writer: { name: "fake", write } } });
    expect((await generateGamePreview(t.deps, auto)).status).toBe("SUCCEEDED");
    expect((t.saves[0].meta as { status: Record<string, unknown> }).status).toMatchObject({ hasStatusClaim: true, asOf: "2026-10-17T16:00:00.000Z", claims: [{ factId: "f4", sourceUrl: st.sourceUrl, verifiedNewest: false }] });
    const plain = setup();
    await generateGamePreview(plain.deps, auto);
    expect((plain.saves[0].meta as { status: Record<string, unknown> }).status).toMatchObject({ hasStatusClaim: false, asOf: null, claims: [] });
  });
});
