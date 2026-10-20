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
  const write = vi.fn<GamePreviewWriterProvider["write"]>(async () => draftOf());
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

  it("an EDITORIAL-TASTE finding (a hook that merely states a record) is ADVISORY: it is never published as-is without a chance to polish, but never rejected either — ONE rewrite uses the note, and the valid rewrite is saved", async () => {
    const write = vi.fn<GamePreviewWriterProvider["write"]>(async (_g, _a, _f, ctx) => (ctx.feedback.length === 0 ? draftOf({ hook: "Tennessee is 0-5, Indianapolis is 2-3" }) : draftOf()));
    const t = setup({ providers: { writer: { name: "fake", write } } });
    expect((await generateGamePreview(t.deps, req)).status).toBe("SUCCEEDED");
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][3]).toMatchObject({ feedbackKind: "advisory" });
    expect(write.mock.calls[1][3].feedback.join(" ")).toMatch(/states a record or score/);
    expect(t.saves[0].hook).toBe(goodDraft.hook);
    const d = t.runs[0].details as { advisoryRewrite: string; advisoryNotes: Array<{ attempt: number; source: string; note: string }> };
    expect(d.advisoryRewrite).toBe("kept_rewrite");
    expect(d.advisoryNotes[0]).toMatchObject({ attempt: 1, source: "deterministic" });
  });

  it("a current fact with no dated source never reaches the angle or the writer, and the run record says why", async () => {
    const undated = fact({ id: "f4", kind: "current", category: "injury", claim: "The quarterback practiced in full.", publishedAt: null });
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [...facts, undated], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out.status).toBe("SUCCEEDED");
    expect(t.selectAngle.mock.calls[0][1].map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
    expect(t.write.mock.calls[0][2].map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
    const recorded = (t.runs[0].details as { facts: Array<{ id: string; excluded?: string }> }).facts;
    expect(recorded.find((f) => f.id === "f4")?.excluded).toMatch(/no publication time/);
    expect(recorded.find((f) => f.id === "f1")?.excluded).toBeUndefined();
  });

  it("when only undated current facts were found the run is REJECTED before any story is written", async () => {
    const undated = fact({ id: "f1", kind: "current", publishedAt: null });
    const t = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [undated], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) } } });
    expect(await generateGamePreview(t.deps, req)).toMatchObject({ status: "REJECTED", error: "no_usable_facts" });
    expect(t.selectAngle).not.toHaveBeenCalled();
    expect(t.saves).toHaveLength(0);
  });

  it("a figure named in the chosen story is backed: the fact that holds it is handed to the writer", async () => {
    const narrow = { ...selection, angles: selection.angles.map((a) => (a.id === "a1" ? { ...a, summary: "Indianapolis beat Tennessee 41-20.", factIds: ["f1"] } : a)) };
    const t = setup({ providers: { angles: { name: "fake", selectAngle: async () => ({ ...narrow, usage: usage({ modelCalls: 1 }) }) } } });
    await generateGamePreview(t.deps, req);
    expect(t.write.mock.calls[0][1].factIds).toEqual(["f1", "f2"]);
    expect((t.runs[0].details as { angleFactsAdded: string[] }).angleFactsAdded).toEqual(["f2"]);
  });

  it("a fact that is plainly from an earlier season is reclassified as history, whatever the research called it, and the record shows it", async () => {
    const old = fact({ id: "f4", claim: "The Chargers swept the Chiefs in 2025.", seasonScope: "CURRENT_SEASON" });
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

  it("a flagged fact that does not verify takes its story with it: the next story with a trusted primary source is written, and the writer never sees the failed fact", async () => {
    const verifyFacts = verifierOf((id) => (id === "f2" ? "unsupported" : "confirmed"));
    const t = setup({ providers: { research: flagged("f2"), factVerifier: { name: "fake", verifyFacts } } });
    const out = await generateGamePreview(t.deps, req);
    const [, angleArg, factsArg] = t.write.mock.calls[0];
    expect(angleArg.id).toBe("a2"); // a1 and a3 both needed f2; a2 stands
    expect(factsArg.map((f) => f.id)).not.toContain("f2");
    const d = t.runs[0].details as { facts: Array<{ id: string; excluded?: string }>; angleOverridden: boolean };
    expect(d.facts.find((f) => f.id === "f2")?.excluded).toMatch(/failed verification \(unsupported: note f2\)/);
    expect(verifyFacts).toHaveBeenCalledTimes(1);
    expect(d.angleOverridden).toBe(true);
    expect(out.status).not.toBe("FAILED");
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
    expect((t1.runs[0].details as { primaryReordered: string[] }).primaryReordered).toEqual(["a1", "a2"]);
    // both current-season facts are blogs: a1 and a2 (about this season) have no eligible CURRENT primary; only the history-only a3 (f2, espn.com) is publishable.
    const t2 = setup({ providers: { research: { name: "fake", research: async () => ({ facts: [blog(facts[0]), facts[1], blog(facts[2])], sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) } } });
    await generateGamePreview(t2.deps, req);
    expect(t2.write.mock.calls[0][1].id).toBe("a3");
    expect((t2.runs[0].details as { angleOverridden: boolean }).angleOverridden).toBe(true);
    const allBlogs = { name: "fake", research: async () => ({ facts: facts.map(blog), sources, usage: usage({ searchCalls: 3, modelCalls: 1 }) }) };
    const t3 = setup({ providers: { research: allBlogs } });
    expect(await generateGamePreview(t3.deps, req)).toMatchObject({ status: "REJECTED", error: "no_trusted_primary_source" });
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
    const bad = draftOf({ preview: `${goodDraft.preview} The Colts are heavy favorites on the moneyline.` });
    const t = setup({ providers: { writer: { name: "fake", write: async () => bad } } });
    const out = await generateGamePreview(t.deps, req);
    expect(out).toMatchObject({ status: "REJECTED", error: "draft_rejected" });
    expect(out.status !== "SUCCEEDED" && out.problems.join(" ")).toMatch(/Sportsbook language/);
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
    expect(await generateGamePreview(t2.deps, req)).toMatchObject({ status: "REJECTED", error: "no_trusted_primary_source" });
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
