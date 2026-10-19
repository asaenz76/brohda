// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { AnthropicGamePreviewProvider, PREVIEW_PROMPT_VERSION, extractJson } from "@/lib/game-previews/providers/anthropic";
import { createGamePreviewProviders } from "@/lib/game-previews/providers";
import { angles, config, facts, game, goodDraft } from "./fixtures";

const ESPN = "https://www.espn.com/nfl/game/_/gameId/401872984";
const ctx = { model: "configured-model", effort: "medium", maxSearchCalls: 3, webSearchToolVersion: "web_search_20250305", preferredDomains: ["espn.com"], blockedDomains: ["reddit.com"] };

type Msg = { content: unknown[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number; server_tool_use?: { web_search_requests: number } } };
const text = (t: unknown, citations: unknown[] = []) => ({ type: "text", text: typeof t === "string" ? t : JSON.stringify(t), citations });
const searchUse = () => ({ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "x" } });
const searchResult = (urls: string[]) => ({ type: "web_search_tool_result", tool_use_id: "s1", content: urls.map((url) => ({ type: "web_search_result", url, title: `T ${url}`, page_age: null, encrypted_content: "x" })) });
const msg = (content: unknown[], over: Partial<Msg> = {}): Msg => ({ content, stop_reason: "end_turn", usage: { input_tokens: 800, output_tokens: 200, server_tool_use: { web_search_requests: 2 } }, ...over });
function client(...responses: Msg[]) {
  const create = vi.fn<(params: Record<string, unknown>) => Promise<Msg>>(async () => responses.shift() ?? msg([text({})]));
  return { messages: { create } } as unknown as ConstructorParameters<typeof AnthropicGamePreviewProvider>[0] & { messages: { create: typeof create } };
}
const calls = (c: ReturnType<typeof client>) => (c.messages.create as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls.map((x) => x[0]);
const rawFact = (over: Record<string, unknown> = {}) => ({ kind: "historical", season_scope: "CURRENT_SEASON", category: "result", claim: "Tennessee lost 26-3 to Houston.", excerpt: "Texans 26, Titans 3", source_url: ESPN, source_provider: "ESPN", source_title: "Texans 26, Titans 3", published_at: "2026-10-11T22:00:00Z", relevance: 0.9, game_association: "Titans' last game", ...over });

describe("Anthropic provider — research", () => {
  it("calls the Messages API with the CONFIGURED model and effort, the configured web-search tool version and ceiling, blocked domains, and no sampling or thinking overrides", async () => {
    const c = client(msg([searchUse(), searchResult([ESPN]), text({ facts: [rawFact()] })]));
    await new AnthropicGamePreviewProvider(c).research(game, ctx);
    const body = calls(c)[0];
    expect(body.model).toBe("configured-model");
    expect(body.output_config).toEqual({ effort: "medium" });
    expect(body.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 3, blocked_domains: ["reddit.com"] }]);
    for (const k of ["temperature", "top_p", "top_k", "thinking"]) expect(body, k).not.toHaveProperty(k);
    expect(String(body.system)).toMatch(/must use web search/i);
    expect(String(body.system)).toContain("Approved (trusted) domains: espn.com");
    expect(String(body.system)).toContain("Never use these domains: reddit.com");
    expect(String(body.system)).toMatch(/most interesting TRUE story/);
    expect(JSON.stringify(body.messages)).toContain("Tennessee Titans at Indianapolis Colts");
  });

  it("the tool version, effort and ceiling follow the stored settings (nothing is a constant)", async () => {
    const c = client(msg([searchUse(), searchResult([ESPN]), text({ facts: [rawFact()] })]));
    await new AnthropicGamePreviewProvider(c).research(game, { ...ctx, webSearchToolVersion: "web_search_20260318", effort: "high", maxSearchCalls: 7, blockedDomains: [] });
    const body = calls(c)[0];
    expect(body.tools).toEqual([{ type: "web_search_20260318", name: "web_search", max_uses: 7 }]);
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("returns structured facts with category and kind, counts searches and tokens from the API's own usage, stamps the retrieval time, and reports which sources were reached, used and not used", async () => {
    const other = "https://www.nfl.com/news/x";
    const c = client(msg([searchUse(), searchResult([ESPN, other]), text({ facts: [rawFact(), rawFact({ claim: "Indianapolis is 2-3.", category: "record" })] }, [{ type: "web_search_result_location", url: ESPN, title: "x", cited_text: "y" }])]));
    const out = await new AnthropicGamePreviewProvider(c).research(game, ctx);
    expect(out.usage).toEqual({ searchCalls: 2, modelCalls: 1, inputTokens: 800, outputTokens: 200 });
    expect(out.facts.map((f) => [f.id, f.category, f.kind])).toEqual([["f1", "result", "historical"], ["f2", "record", "historical"]]);
    expect(out.facts[0]).toMatchObject({ sourceProvider: "ESPN", retrievedAt: game.asOf, publishedAt: "2026-10-11T22:00:00.000Z", relevance: 0.9 });
    expect(out.sources).toEqual([
      { url: ESPN, title: `T ${ESPN}`, status: "accepted" },
      { url: other, title: `T ${other}`, status: "rejected", reason: "no usable fact taken from it" },
    ]);
  });

  it("classifies each fact's season: this season's stays CURRENT_SEASON; earlier seasons, a missing label and an unknown label are HISTORICAL_CONTEXT; a current-state fact is always this season's", async () => {
    const c = client(msg([searchUse(), searchResult([ESPN]), text({ facts: [rawFact(), rawFact({ season_scope: "HISTORICAL_CONTEXT", claim: "Chargers swept the Chiefs." }), rawFact({ season_scope: undefined, claim: "No label." }), rawFact({ season_scope: "LAST_YEAR", claim: "Odd label." }), rawFact({ kind: "current", season_scope: "HISTORICAL_CONTEXT", claim: "Out Sunday." })] })]));
    const out = await new AnthropicGamePreviewProvider(c).research(game, ctx);
    expect(out.facts.map((f) => f.seasonScope)).toEqual(["CURRENT_SEASON", "HISTORICAL_CONTEXT", "HISTORICAL_CONTEXT", "HISTORICAL_CONTEXT", "CURRENT_SEASON"]);
  });

  it("keeps only facts from sources the search ACTUALLY reached: a fabricated citation or a blocked domain is dropped and recorded", async () => {
    const c = client(msg([searchUse(), searchResult([ESPN, "https://www.reddit.com/r/nfl/x"]), text({ facts: [rawFact(), rawFact({ claim: "Invented.", source_url: "https://www.espn.com/never-fetched" }), rawFact({ claim: "Rumor.", source_url: "https://www.reddit.com/r/nfl/x" })] })]));
    const out = await new AnthropicGamePreviewProvider(c).research(game, ctx);
    expect(out.facts.map((f) => f.claim)).toEqual(["Tennessee lost 26-3 to Houston."]);
    const reasons = Object.fromEntries(out.sources.map((s) => [s.url, s.reason ?? s.status]));
    expect(reasons["https://www.reddit.com/r/nfl/x"]).toBe("blocked domain");
    expect(reasons["https://www.espn.com/never-fetched"]).toMatch(/never reached/);
  });

  it("resumes a paused server-tool turn (without an extra user message) and adds up the usage of every request", async () => {
    const paused = msg([searchUse()], { stop_reason: "pause_turn", usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 1 } } });
    const done = msg([searchResult([ESPN]), text({ facts: [rawFact()] })], { usage: { input_tokens: 200, output_tokens: 20, server_tool_use: { web_search_requests: 1 } } });
    const c = client(paused, done);
    const out = await new AnthropicGamePreviewProvider(c).research(game, ctx);
    expect(calls(c)).toHaveLength(2);
    const second = calls(c)[1].messages as Array<{ role: string }>;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant"]); // the paused turn is re-sent as-is
    expect(out.usage).toEqual({ searchCalls: 2, modelCalls: 2, inputTokens: 300, outputTokens: 30 });
    expect(out.facts).toHaveLength(1);
  });

  it("fails — rather than inventing anything — on a search error, a refusal, a cut-off answer, or an answer that is not JSON", async () => {
    const run = (m: Msg) => new AnthropicGamePreviewProvider(client(m)).research(game, ctx);
    await expect(run(msg([searchUse(), { type: "web_search_tool_result", tool_use_id: "s1", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }, text({ facts: [] })]))).rejects.toThrow(/web_search_error: unavailable/);
    await expect(run(msg([text("no")], { stop_reason: "refusal" }))).rejects.toThrow(/anthropic_refusal/);
    await expect(run(msg([text("{")], { stop_reason: "max_tokens" }))).rejects.toThrow(/anthropic_max_tokens/);
    await expect(run(msg([searchUse(), searchResult([ESPN]), text("I could not find anything.")]))).rejects.toThrow(/no JSON/);
  });

  it("an unavailable model fails with the API's own error and NO fallback to another model", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const create = vi.fn(async () => {
      throw new Anthropic.NotFoundError(404, { type: "error", error: { type: "not_found_error", message: "model: claude-nope" } }, "model: claude-nope", new Headers());
    });
    const c = { messages: { create } } as unknown as ConstructorParameters<typeof AnthropicGamePreviewProvider>[0];
    await expect(new AnthropicGamePreviewProvider(c).research(game, ctx)).rejects.toThrow(/anthropic_api_404/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("never puts the API key anywhere an error or a request body could carry it", async () => {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const create = vi.fn(async () => {
      throw new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "invalid x-api-key", new Headers({ "x-api-key": "sk-ant-secret" }));
    });
    const c = { messages: { create } } as unknown as ConstructorParameters<typeof AnthropicGamePreviewProvider>[0];
    const error = await new AnthropicGamePreviewProvider(c).research(game, ctx).catch((e: Error) => e);
    expect(String((error as Error).message)).not.toMatch(/sk-ant/);
    expect(JSON.stringify((create.mock.calls[0] as unknown[])[0])).not.toMatch(/sk-ant/);
  });
});

describe("Anthropic provider — angles, writing, verification", () => {
  const selectionJson = {
    angles: angles.map((a) => ({ id: a.id, type: a.type, summary: a.summary, fact_ids: a.factIds, scores: a.scores, note: a.note })),
    selected_id: "a1",
    selection_reason: "Streak against dominance.",
    rejected: [{ id: "a2", reason: "Records only." }],
  };

  it("the angle stage gets only verified facts, the editorial rubric and the angle vocabulary, uses no tools, and returns scored angles", async () => {
    const c = client(msg([text(selectionJson)]));
    const sel = await new AnthropicGamePreviewProvider(c).selectAngle(game, facts, { model: "configured-model", effort: "medium" });
    const body = calls(c)[0];
    expect(body.tools).toBeUndefined();
    // Stages without search ask for schema-guaranteed JSON (structured outputs), so the answer is always parseable.
    expect(body.output_config).toMatchObject({ effort: "medium", format: { type: "json_schema", schema: { type: "object", additionalProperties: false, required: ["angles", "selected_id", "selection_reason", "rejected"] } } });
    expect(String(body.system)).toContain("3 to 5 candidate editorial angles");
    expect(String(body.system)).toContain("HOT_VS_COLD");
    expect(String(body.system)).toMatch(/tension[\s\S]*surprise[\s\S]*specificity[\s\S]*humanInterest[\s\S]*conversation[\s\S]*recency/);
    expect(String(body.system)).toMatch(/FALLBACK material/);
    expect(JSON.stringify(body.messages)).toContain("Tennessee lost 26-3");
    expect(sel.selectedId).toBe("a1");
    expect(sel.angles[0]).toMatchObject({ id: "a1", type: "CONTRAST", factIds: ["f1", "f2", "f3"], scores: { tension: 4, humanInterest: 4 } });
    expect(sel.rejected).toEqual([{ id: "a2", reason: "Records only." }]);
  });

  it("the writer is given the CHOSEN story and only that story's facts, the configured limits and any rejection feedback, plus the editorial tests", async () => {
    const c = client(msg([text({ hook: goodDraft.hook, preview: goodDraft.preview, claims: goodDraft.claims.map((x) => ({ text: x.text, fact_ids: x.factIds })) })]));
    const draft = await new AnthropicGamePreviewProvider(c).write(game, { ...angles[2] }, facts, { model: "configured-model", effort: "medium", maxChars: 650, hookMaxChars: 90, maxCitedFacts: 3, recentHooks: ["Can the Jets ground this storm?"], feedback: ['The figure "27" is not in the facts.'] });
    const body = calls(c)[0];
    expect(body.output_config).toMatchObject({ format: { type: "json_schema", schema: { required: ["hook", "preview", "claims"] } } });
    expect(body.tools).toBeUndefined(); // writing never searches
    const system = String(body.system);
    expect(system).toContain("at most 650 characters");
    expect(system).toContain("at most 90 characters");
    expect(system).toContain("at most 3 may be cited");
    expect(system).toMatch(/stop scrolling/);
    expect(system).toMatch(/swapping team names|changing the team names/);
    expect(system).toMatch(/Do NOT force a question/);
    expect(system).toMatch(/Do not put a record or score in the hook/);
    expect(system).toMatch(/never reuse their facts/i);
    const user = JSON.stringify(body.messages);
    expect(user).toContain(angles[2].summary);
    expect(user).toContain("beat Tennessee 41-20"); // f2, the angle's own fact
    expect(user).not.toContain("26-3 loss to Houston"); // f1 is not part of this story, so the writer never sees it
    expect(user).toContain("previous draft was rejected");
    expect(draft).toMatchObject({ hook: goodDraft.hook, promptVersion: PREVIEW_PROMPT_VERSION });
    expect(draft.claims[0]).toEqual({ text: goodDraft.claims[0].text, factIds: ["f1"] });
  });

  it("the verifier judges both support and editorial quality, and is told the chosen story", async () => {
    const c = client(msg([text({ supported: true, editorial_passes: false, problems: ["It reads like game notes."] })]));
    const out = await new AnthropicGamePreviewProvider(c).verify(game, angles[0], goodDraft, facts, { model: "configured-model", effort: "medium" });
    expect(out).toMatchObject({ supported: true, editorialPasses: false, problems: ["It reads like game notes."] });
    const system = String(calls(c)[0].system);
    expect(calls(c)[0].output_config).toMatchObject({ format: { type: "json_schema", schema: { required: ["supported", "editorial_passes", "problems"] } } });
    expect(system).toMatch(/strict fact-checker AND a sports editor/);
    expect(system).toContain(angles[0].summary);
    expect(calls(c)[0].tools).toBeUndefined();
  });

  it("extractJson tolerates prose, code fences and trailing commentary that contains braces; and a failure says how the answer began", () => {
    expect(extractJson<{ a: number }>('Here you go:\n```json\n{"a":1}\n```', "x")).toEqual({ a: 1 });
    expect(extractJson<{ a: string }>('{"a":"} not the end"} and a note {like this}', "x")).toEqual({ a: "} not the end" });
    expect(extractJson<{ a: { b: number } }>('{"a":{"b":2}}', "x")).toEqual({ a: { b: 2 } });
    expect(() => extractJson("nothing at all", "angle")).toThrow(/no JSON.*began: nothing at all/);
    expect(() => extractJson('{"a": 1,, }', "angle")).toThrow(/not valid JSON.*began: \{"a": 1,,/);
  });
});

describe("Anthropic provider — story-first research and fact verification", () => {
  it("the research instructions are staged: resolve the Game, stories before statistics, then history, follow the story, stop early, and never pick the more dramatic of two disputed numbers", async () => {
    const c = client(msg([searchUse(), searchResult([ESPN]), text({ facts: [rawFact()] })]));
    await new AnthropicGamePreviewProvider(c).research(game, ctx);
    const system = String(calls(c)[0].system);
    for (const re of [/canonical Game/i, /STORIES, not statistics/, /matchup history/i, /targeted follow-up/i, /ceiling, not a target/i, /never pick the more dramatic one/i]) expect(system).toMatch(re);
  });

  it("returns the leads (tied to the facts that were kept) and the source conflicts the research reported", async () => {
    const other = "https://www.nfl.com/news/x";
    const c = client(msg([searchUse(), searchResult([ESPN, other]), text({ facts: [rawFact(), rawFact({ source_url: "https://not-reached.example/x", claim: "Never reached." }), rawFact({ claim: "Indianapolis is 2-3.", source_url: other })], leads: [{ summary: "Winless Tennessee meets a Colts team that owned it.", fact_numbers: [1, 3] }, { summary: "Rests only on a dropped fact.", fact_numbers: [2] }, { summary: "", fact_numbers: [1] }], conflicts: [{ topic: "Colts sacks", note: "ESPN says 3, KCSN says 4" }] })]));
    const out = await new AnthropicGamePreviewProvider(c).research(game, ctx);
    expect(out.facts.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(out.leads).toEqual([{ summary: "Winless Tennessee meets a Colts team that owned it.", factIds: ["f1", "f2"] }]);
    expect(out.conflicts).toEqual([{ topic: "Colts sacks", note: "ESPN says 3, KCSN says 4" }]);
  });

  const vctx = { model: "configured-model", effort: "medium", maxSearchCalls: 2, webSearchToolVersion: "web_search_20250305", blockedDomains: ["reddit.com"] };

  const verdicts = (v: Array<[string, string, string?]>) => text({ verdicts: v.map(([fact_id, verdict, to_establish = ""]) => ({ fact_id, verdict, note: `note ${fact_id}`, to_establish })) });

  it("EVIDENCE FIRST: facts the captured evidence proves are confirmed from it, in ONE call, with no search tool at all", async () => {
    const c = client(msg([verdicts([["f1", "proves"], ["f2", "proves"], ["f3", "proves"]])], { usage: { input_tokens: 500, output_tokens: 90 } }));
    const out = await new AnthropicGamePreviewProvider(c).verifyFacts(game, facts, vctx);
    expect(out.checks.map((k) => [k.factId, k.status, k.basis])).toEqual([["f1", "confirmed", "stored_evidence"], ["f2", "confirmed", "stored_evidence"], ["f3", "confirmed", "stored_evidence"]]);
    expect(calls(c)).toHaveLength(1);
    const body = calls(c)[0];
    expect(body).not.toHaveProperty("tools");
    expect((body.output_config as { format?: { type: string } }).format?.type).toBe("json_schema");
    expect(out.usage).toEqual({ searchCalls: 0, modelCalls: 1, inputTokens: 500, outputTokens: 90 });
  });

  it("the evidence check understands source semantics: page identity can establish the season; an undated biography or archive cannot; and what was captured is what the judge sees", async () => {
    const c = client(msg([verdicts([["f1", "proves"]])]));
    const rich = { ...facts[0], sourceType: "stats_page" as const, pageContext: "ESPN Avalanche team statistics page, current regular season", pageSeason: "2026-27", subjectTeam: "Colorado Avalanche" };
    await new AnthropicGamePreviewProvider(c).verifyFacts(game, [rich], vctx);
    const body = calls(c)[0];
    const system = String(body.system);
    expect(system).toMatch(/from the evidence already captured/i);
    expect(system).toMatch(/Do NOT mark a fact insufficient merely because the visible text omits a date/);
    expect(system).toMatch(/undated generic biography, archive article, prospect profile or historical page does NOT establish/i);
    expect(system).toMatch(/Never use outside knowledge/);
    const sent = JSON.stringify(body.messages);
    for (const needle of ["stats_page", "ESPN Avalanche team statistics page, current regular season", "2026-27", "Colorado Avalanche", rich.retrievedAt]) expect(sent).toContain(needle);
  });

  it("only what the captured evidence could not settle gets a TARGETED search (within what is left); a contradiction is disputed from the evidence, without a search", async () => {
    const c = client(
      msg([verdicts([["f1", "proves"], ["f2", "insufficient", "Nathan MacKinnon 16 points 6 goals 10 assists 2026-27"], ["f3", "contradicted"]])]),
      msg([searchUse(), searchResult([ESPN]), text({ checks: [{ fact_id: "f2", status: "confirmed", note: "ESPN stats page shows 16 PTS", corroborating_url: ESPN, retrieval_failed: false }] })], { usage: { input_tokens: 700, output_tokens: 120, server_tool_use: { web_search_requests: 1 } } }),
    );
    const out = await new AnthropicGamePreviewProvider(c).verifyFacts(game, facts, vctx);
    expect(out.checks.map((k) => [k.factId, k.status, k.basis])).toEqual([["f1", "confirmed", "stored_evidence"], ["f2", "confirmed", "targeted_search"], ["f3", "disputed", "stored_evidence"]]);
    const [, targeted] = calls(c);
    expect(targeted.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 1, blocked_domains: ["reddit.com"] }]); // one unresolved claim -> at most one search, however many remain
    expect(JSON.stringify(targeted.messages)).toContain("Nathan MacKinnon 16 points 6 goals 10 assists 2026-27");
    expect(JSON.stringify(targeted.messages)).not.toContain(facts[0].claim); // f1 was settled: it is not searched again
    expect(String(targeted.system)).toMatch(/EXACT unresolved claim/);
    expect(String(targeted.system)).toMatch(/not evidence the claim is false/);
    expect(out.usage.searchCalls).toBe(1);
    expect(out.usage.modelCalls).toBe(2);
  });

  it("a page that cannot be retrieved during verification is recorded as a retrieval failure, not as a false claim — and still does not confirm", async () => {
    const c = client(msg([verdicts([["f1", "insufficient", "the exact score"]])]), msg([searchUse(), searchResult([]), text({ checks: [{ fact_id: "f1", status: "unsupported", note: "could not retrieve the page; no other source found", corroborating_url: null, retrieval_failed: true }] })]));
    const out = await new AnthropicGamePreviewProvider(c).verifyFacts(game, [facts[0]], vctx);
    expect(out.checks[0]).toMatchObject({ status: "unsupported", basis: "targeted_search", retrievalFailed: true });
  });

  it("with no searches left, an unsettled fact is NOT confirmed and the check says why; no second call is made", async () => {
    const c = client(msg([verdicts([["f1", "insufficient", "the season"]])]));
    const out = await new AnthropicGamePreviewProvider(c).verifyFacts(game, [facts[0]], { ...vctx, maxSearchCalls: 0 });
    expect(out.checks[0]).toMatchObject({ status: "unsupported", basis: "none" });
    expect(out.checks[0].note).toMatch(/no verification search was available/);
    expect(calls(c)).toHaveLength(1);
  });

  it("a fact the evidence check did not answer for is unresolved, not confirmed", async () => {
    const c = client(msg([verdicts([["f1", "proves"]])]));
    const out = await new AnthropicGamePreviewProvider(c).verifyFacts(game, [facts[0], facts[1]], { ...vctx, maxSearchCalls: 0 });
    expect(out.checks.map((k) => k.status)).toEqual(["confirmed", "unsupported"]);
    expect(out.checks[1].note).toMatch(/no verdict returned/);
  });

  it("research reports the exception flags per fact (ambiguous / surprising / disputed), and tells the model that one approved source is normally enough and which sources are trusted", async () => {
    const c = client(msg([searchUse(), searchResult([ESPN]), text({ facts: [rawFact({ ambiguous: true }), rawFact({ claim: "B", surprising: true }), rawFact({ claim: "C", disputed: true }), rawFact({ claim: "D" })] })]));
    const out = await new AnthropicGamePreviewProvider(c).research(game, ctx);
    expect(out.facts.map((f) => [f.ambiguous, f.surprising, f.disputed])).toEqual([[true, false, false], [false, true, false], [false, false, true], [false, false, false]]);
    const system = String(calls(c)[0].system);
    expect(system).toMatch(/One approved source that clearly states what you report is normally enough/);
    expect(system).toMatch(/never primary support/);
    expect(system).toMatch(/not a preseason game/);
    expect(system).toContain("Approved (trusted) domains: espn.com");
  });

  it("the writer gets the recent hooks to vary from, the anti-template rule, and the no-fabricated-quote rule", async () => {
    const c = client(msg([text({ hook: goodDraft.hook, preview: goodDraft.preview, claims: goodDraft.claims.map((x) => ({ text: x.text, fact_ids: x.factIds })) })]));
    await new AnthropicGamePreviewProvider(c).write(game, { ...angles[2] }, facts, { model: "m", effort: "medium", maxChars: 650, hookMaxChars: 90, maxCitedFacts: 3, recentHooks: ["Three games. Four goals. Boston, you're next."], feedback: [] });
    const body = calls(c)[0];
    expect(JSON.stringify(body.messages)).toContain("Three games. Four goals. Boston, you're next.");
    expect(String(body.system)).toMatch(/do not turn the style references into a formula/i);
    expect(String(body.system)).toMatch(/Never put a quote in the Preview unless it appears word for word/);
  });

  it("research captures the evidence a later check needs: the page's own identity, season, source type and the team of any person named", async () => {
    const c = client(msg([searchUse(), searchResult([ESPN]), text({ facts: [rawFact({ source_type: "stats_page", page_context: "ESPN Avalanche team statistics page, current regular season", page_season: "2026-27", subject_team: "Colorado Avalanche", excerpt: "Nathan MacKinnon | GP 8 | G 6 | A 10 | PTS 16" }), rawFact({ source_type: "made-up-type", claim: "Other." })] })]));
    const out = await new AnthropicGamePreviewProvider(c).research(game, ctx);
    expect(out.facts[0]).toMatchObject({ sourceType: "stats_page", pageContext: "ESPN Avalanche team statistics page, current regular season", pageSeason: "2026-27", subjectTeam: "Colorado Avalanche" });
    expect(out.facts[1]).toMatchObject({ sourceType: "other", pageContext: null, pageSeason: null, subjectTeam: null });
    expect(String(calls(c)[0].system)).toMatch(/surrounding context/);
  });
});

describe("provider selection", () => {
  it("is built from the stored provider, with credentials ONLY from the environment; no key means 'not configured'", () => {
    expect(createGamePreviewProviders(config, {})).toBeNull();
    const p = createGamePreviewProviders(config, { ANTHROPIC_API_KEY: "sk-ant-test" })!;
    expect(p.research.name).toBe("anthropic");
    expect(p.angles.name).toBe("anthropic");
    expect(p.verifier).not.toBeNull();
    expect(createGamePreviewProviders({ ...config, verifyWithModel: false }, { ANTHROPIC_API_KEY: "sk-ant-test" })!.verifier).toBeNull();
    expect(createGamePreviewProviders({ ...config, provider: "someone-else" }, { ANTHROPIC_API_KEY: "sk-ant-test" })).toBeNull();
  });
});
