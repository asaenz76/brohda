// @vitest-environment node
import Anthropic from "@anthropic-ai/sdk";
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
    expect(String(body.system)).toContain("Propose 1 to 5 candidate angles");
    expect(String(body.system)).toContain("HOT_VS_COLD");
    expect(String(body.system)).toMatch(/tension[\s\S]*surprise[\s\S]*specificity[\s\S]*humanInterest[\s\S]*conversation[\s\S]*recency/);
    expect(String(body.system)).toMatch(/fallback, not a story/);
    expect(String(body.system)).toMatch(/why is this relevant to THIS Game NOW/);
    expect(JSON.stringify(body.messages)).toContain("Tennessee lost 26-3");
    expect(sel.selectedId).toBe("a1");
    expect(sel.angles[0]).toMatchObject({ id: "a1", type: "CONTRAST", factIds: ["f1", "f2", "f3"], scores: { tension: 4, humanInterest: 4 } });
    expect(sel.rejected).toEqual([{ id: "a2", reason: "Records only." }]);
  });

  it("the writer is given the CHOSEN story and only that story's facts, the configured limits and any rejection feedback, plus the editorial tests", async () => {
    const c = client(msg([text({ status: "ready", reason: "", title: goodDraft.hook, caption: goodDraft.preview, claims: goodDraft.claims.map((x) => ({ text: x.text, fact_ids: x.factIds, evidence: "from the fact" })) })]));
    const draft = await new AnthropicGamePreviewProvider(c).write(game, { ...angles[2] }, facts, { model: "configured-model", effort: "medium", maxChars: 650, maxCitedFacts: 3, recentHooks: ["Can the Jets ground this storm?"], feedback: ['The figure "27" is not in the facts.'] });
    const body = calls(c)[0];
    expect(body.output_config).toMatchObject({ format: { type: "json_schema", schema: { required: ["status", "reason", "title", "caption", "claims"] } } });
    expect(body.tools).toBeUndefined(); // writing never searches
    const system = String(body.system);
    expect(system).toContain("at most 3 may be cited");
    expect(system).toMatch(/Seven goals/); // the canonical style references
    expect(system).toMatch(/relevant to THIS Game NOW/);
    expect(system).toMatch(/needs_review/);
    expect(system).toMatch(/em dashes or hashtags/);
    expect(system).not.toMatch(/at most \d+ characters/); // no separate title limit; the combined limit is in the message
    const user = JSON.stringify(body.messages);
    expect(user).toContain(angles[2].summary);
    expect(user).toContain("beat Tennessee 41-20"); // f2, the angle's own fact
    expect(user).not.toContain("26-3 loss to Houston"); // f1 is not part of this story, so the writer never sees it
    expect(user).toContain("previous draft was rejected");
    expect(user).toContain("fewer than 650 characters");
    expect(draft).toMatchObject({ status: "ready", hook: goodDraft.hook, preview: goodDraft.preview, promptVersion: PREVIEW_PROMPT_VERSION });
    expect(draft.claims[0]).toEqual({ text: goodDraft.claims[0].text, factIds: ["f1"], evidence: "from the fact" });
  });

  it("the reviewer returns TWO separate lists — BLOCKING (wrong or misleading) and ADVISORY (taste) — and is told the chosen story and the difference", async () => {
    const c = client(msg([text({ blocking: [{ category: "unsupported_causation", problem: "Bosa is a defender; his absence does not burden the offense." }], advisory: [{ kind: "game_note_feel", note: "It reads like game notes." }] })]));
    const out = await new AnthropicGamePreviewProvider(c).verify(game, angles[0], goodDraft, facts, { model: "configured-model", effort: "medium" });
    expect(out.blocking).toEqual([{ category: "unsupported_causation", problem: "Bosa is a defender; his absence does not burden the offense." }]);
    expect(out.advisory).toEqual([{ kind: "game_note_feel", note: "It reads like game notes." }]);
    const body = calls(c)[0];
    expect(body.output_config).toMatchObject({ format: { type: "json_schema", schema: { required: ["blocking", "advisory"] } } });
    const system = String(body.system);
    expect(system).toContain(angles[0].summary);
    expect(system).toMatch(/BLOCKING: the Preview is wrong or misleading/);
    expect(system).toMatch(/ADVISORY: editorial taste only/);
    expect(system).toMatch(/True facts can be misused/);
    expect(system).toMatch(/defender's absence presented as burdening the offense/);
    expect(system).toMatch(/NEVER block/);
    expect(system).toMatch(/relevant to THIS Game NOW/);
    expect(system).toMatch(/'first chance'/); // number words in ordinary prose are not figures
    // every blocking category and advisory kind is in the schema as an enum
    const schema = (body.output_config as { format: { schema: { properties: { blocking: { items: { properties: { category: { enum: string[] } } } }; advisory: { items: { properties: { kind: { enum: string[] } } } } } } } }).format.schema.properties;
    expect(schema.blocking.items.properties.category.enum).toEqual(expect.arrayContaining(["unsupported_claim", "wrong_figure", "wrong_entity", "wrong_season", "stale_current", "source_conflict", "wrong_game", "wrong_phase", "not_relevant_now", "logical_contradiction", "unsupported_causation", "misleading_implication", "fabricated_quote", "betting_language"]));
    expect(schema.advisory.items.properties.kind.enum).toEqual(expect.arrayContaining(["bland_story", "weak_hook", "game_note_feel", "repetitive_structure", "low_conversation", "wording_tone"]));
    expect(body.tools).toBeUndefined();
  });

  it("a story that rests ONLY on earlier-season facts is reviewed with extra BLOCKING rules: nothing about the present or future without a current fact, and it must be tied to this matchup", async () => {
    const c = client(msg([text({ blocking: [], advisory: [] })]), msg([text({ blocking: [], advisory: [] })]));
    const p = new AnthropicGamePreviewProvider(c);
    await p.verify(game, angles[2], goodDraft, facts, { model: "m", effort: "medium" }); // a3 rests on f2 only: HISTORICAL_CONTEXT
    const system = String(calls(c)[0].system);
    expect(system).toMatch(/THIS STORY RESTS ONLY ON EARLIER-SEASON FACTS/);
    expect(system).toMatch(/is finding out/);
    expect(system).toMatch(/tied to THIS matchup/);
    await p.verify(game, angles[0], goodDraft, facts, { model: "m", effort: "medium" }); // a1 includes this season's facts
    expect(String(calls(c)[1].system)).not.toMatch(/THIS STORY RESTS ONLY ON EARLIER-SEASON FACTS/);
    expect(String(calls(c)[1].system)).toMatch(/no cited fact states/); // the general rule: a claim about the present or the future needs a fact
  });

  it("an unrecognised blocking category still blocks (the reviewer said something is wrong); an unrecognised advisory kind is wording taste; empty findings are dropped", async () => {
    const c = client(msg([text({ blocking: [{ category: "something_new", problem: "a real problem" }, { category: "wrong_figure", problem: "  " }], advisory: [{ kind: "vibes", note: "meh" }, { kind: "weak_hook", note: "" }] })]));
    const out = await new AnthropicGamePreviewProvider(c).verify(game, angles[0], goodDraft, facts, { model: "m", effort: "medium" });
    expect(out.blocking).toEqual([{ category: "unsupported_claim", problem: "a real problem" }]);
    expect(out.advisory).toEqual([{ kind: "wording_tone", note: "meh" }]);
  });

  it("the writer is told, for an ADVISORY rewrite, that the draft is sound and the facts must not change", async () => {
    const c = client(msg([text({ status: "ready", reason: "", title: goodDraft.hook, caption: goodDraft.preview, claims: goodDraft.claims.map((x) => ({ text: x.text, fact_ids: x.factIds, evidence: "from the fact" })) })]));
    await new AnthropicGamePreviewProvider(c).write(game, { ...angles[2] }, facts, { model: "m", effort: "medium", maxChars: 650, maxCitedFacts: 3, recentHooks: [], feedback: ["reads like game notes"], feedbackKind: "advisory" });
    const user = JSON.stringify(calls(c)[0].messages);
    expect(user).toMatch(/factually sound and will be kept unless this rewrite is better/);
    expect(user).toMatch(/Do NOT add, change or drop any fact/);
    expect(user).not.toMatch(/was rejected for these reasons/);
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
    for (const re of [/CONFIRM THE GAME/, /FIND THE STORY FIRST, not statistics/, /matchup history/i, /targeted search/i, /ceiling, not a target/i, /never pick the more dramatic one/i, /Syndicated copies/, /EXPECTED/, /Never infer the season from the calendar year/i]) expect(system).toMatch(re);
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
    expect(system).toMatch(/One inspected trusted source that clearly states what you report is normally enough/);
    expect(system).toMatch(/never a primary source/);
    expect(system).toMatch(/preseason, regular season or playoffs/);
    expect(system).toContain("Approved (trusted) domains: espn.com");
  });

  it("the writer gets the recent hooks to vary from, the anti-template rule, and the no-fabricated-quote rule", async () => {
    const c = client(msg([text({ status: "ready", reason: "", title: goodDraft.hook, caption: goodDraft.preview, claims: goodDraft.claims.map((x) => ({ text: x.text, fact_ids: x.factIds, evidence: "from the fact" })) })]));
    await new AnthropicGamePreviewProvider(c).write(game, { ...angles[2] }, facts, { model: "m", effort: "medium", maxChars: 650, maxCitedFacts: 3, recentHooks: ["Three games. Four goals. Boston, you're next."], feedback: [] });
    const body = calls(c)[0];
    expect(JSON.stringify(body.messages)).toContain("Three games. Four goals. Boston, you're next.");
    expect(String(body.system)).toMatch(/vary the structure/i);
    expect(String(body.system)).toMatch(/not word for word in a cited fact/);
  });

  it("research captures the evidence a later check needs: the page's own identity, season, source type and the team of any person named", async () => {
    const c = client(msg([searchUse(), searchResult([ESPN]), text({ facts: [rawFact({ source_type: "stats_page", page_context: "ESPN Avalanche team statistics page, current regular season", page_season: "2026-27", subject_team: "Colorado Avalanche", excerpt: "Nathan MacKinnon | GP 8 | G 6 | A 10 | PTS 16" }), rawFact({ source_type: "made-up-type", claim: "Other." })] })]));
    const out = await new AnthropicGamePreviewProvider(c).research(game, ctx);
    expect(out.facts[0]).toMatchObject({ sourceType: "stats_page", pageContext: "ESPN Avalanche team statistics page, current regular season", pageSeason: "2026-27", subjectTeam: "Colorado Avalanche" });
    expect(out.facts[1]).toMatchObject({ sourceType: "other", pageContext: null, pageSeason: null, subjectTeam: null });
    expect(String(calls(c)[0].system)).toMatch(/surrounding context/);
    expect(String(calls(c)[0].system)).toMatch(/at most 14 facts/);
    expect(calls(c)[0].max_tokens).toBe(32000);
  });
});

describe("Anthropic provider — the canonical contract inputs and outputs", () => {
  it("every stage is told the Game's season identifier, competition phase and scheduled start with its timezone", async () => {
    const c = client(msg([searchUse(), searchResult([ESPN]), text({ game_check: { confirmed: true, conflict: null }, facts: [rawFact()] })]));
    await new AnthropicGamePreviewProvider(c).research({ ...game, season: "2026-2027", phase: "preseason", timezone: "America/New_York", kickoffUtc: "2026-10-20T23:30:00.000Z" }, ctx);
    const user = JSON.stringify(calls(c)[0].messages);
    expect(user).toContain("Season identifier: 2026-2027");
    expect(user).toContain("Competition phase: preseason");
    expect(user).toMatch(/local: .*7:30 PM America\/New_York/);
    expect(String(calls(c)[0].system)).toContain("game_check");
  });

  it("(test S) research reports a schedule conflict through game_check; a confirmed Game (or no answer) is confirmed", async () => {
    const conflict = client(msg([searchUse(), searchResult([ESPN]), text({ game_check: { confirmed: false, conflict: "The league shows Indianapolis hosting Houston on Oct. 19, not Tennessee on Oct. 18." }, facts: [] })]));
    const out = await new AnthropicGamePreviewProvider(conflict).research(game, ctx);
    expect(out.gameCheck).toEqual({ confirmed: false, conflict: "The league shows Indianapolis hosting Houston on Oct. 19, not Tennessee on Oct. 18." });
    const ok = client(msg([searchUse(), searchResult([ESPN]), text({ facts: [rawFact()] })]));
    expect((await new AnthropicGamePreviewProvider(ok).research(game, ctx)).gameCheck).toEqual({ confirmed: true, conflict: null });
  });

  it("the research prompt carries the currentness rules: current relevance is the primary gate, previous-season material is HISTORICAL_CONTEXT, opening-week context counts as current", async () => {
    const c = client(msg([searchUse(), searchResult([ESPN]), text({ facts: [rawFact()] })]));
    await new AnthropicGamePreviewProvider(c).research(game, ctx);
    const system = String(calls(c)[0].system);
    expect(system).toMatch(/CURRENT RELEVANCE is the primary gate/);
    expect(system).toMatch(/Previous-season material is HISTORICAL_CONTEXT/);
    expect(system).toMatch(/preseason, training camp, offseason trades/);
    expect(system).toMatch(/Priority: 1\) a compelling current-season story/);
  });

  it("the writer can decline: status needs_review with a reason produces no title or caption to publish", async () => {
    const c = client(msg([text({ status: "needs_review", reason: "Only last season's material was found.", title: "", caption: "", claims: [] })]));
    const draft = await new AnthropicGamePreviewProvider(c).write(game, angles[2], facts, { model: "m", effort: "medium", maxChars: 700, maxCitedFacts: 4, recentHooks: [], feedback: [] });
    expect(draft).toMatchObject({ status: "needs_review", reason: "Only last season's material was found.", hook: "", preview: "" });
  });

  it("the reviewer receives code hints as leads to check, and the evidence of each cited fact", async () => {
    const c = client(msg([text({ blocking: [], advisory: [] })]));
    await new AnthropicGamePreviewProvider(c).verify(game, angles[0], goodDraft, facts, { model: "m", effort: "medium" }, { figures: ["9"], seasonClaims: [] });
    expect(JSON.stringify(calls(c)[0].messages)).toContain("Hints from code");
    expect((calls(c)[0].messages as Array<{ content: string }>)[0].content).toContain('"figures":["9"]');
  });
});

describe("final hardening: status certainty, central facts and credit rules reach the prompts", () => {
  it("(tests E, F) the reviewer is told to BLOCK status inflation, with the owner's examples, and receives the hedges found in the cited facts", async () => {
    const c = client(msg([text({ blocking: [{ category: "status_overstated", problem: "'unlikely to play' written as 'missing'." }], advisory: [] })]));
    const hedged = [{ ...facts[0], claim: "Parsons won't practice and is unlikely to play in Week 7; Hargrave is expected back soon.", excerpt: "unlikely to play; expected back" }];
    const out = await new AnthropicGamePreviewProvider(c).verify(game, angles[0], { hook: "Green Bay is missing Parsons", preview: "Hargrave returns.", claims: [{ text: "x", factIds: ["f1"] }] }, hedged, { model: "m", effort: "medium" }, { figures: [], seasonClaims: [], hedges: ['f1: "unlikely"', 'f1: "expected"'] });
    expect(out.blocking).toEqual([{ category: "status_overstated", problem: "'unlikely to play' written as 'missing'." }]);
    const system = String(calls(c)[0].system);
    expect(system).toMatch(/status_overstated/);
    for (const pair of ["'unlikely to play' written as 'out'", "'questionable' as 'will play'", "'expected to return' as 'returns'", "'projected starter' as 'starter'", "'could play' as 'will play'"]) expect(system).toContain(pair);
    expect(JSON.stringify(calls(c)[0].messages)).toContain("unlikely");
    const schema = (calls(c)[0].output_config as { format: { schema: { properties: { blocking: { items: { properties: { category: { enum: string[] } } } } } } } }).format.schema.properties.blocking.items.properties.category.enum;
    expect(schema).toEqual(expect.arrayContaining(["status_overstated", "central_source_mismatch"]));
  });

  it("the reviewer is told that a hedged announcement ('pretty sure') and an as-of statistic ('so far') must not become settled / current (Kings and Packers re-test regressions)", async () => {
    const c = client(msg([text({ blocking: [], advisory: [] })]));
    await new AnthropicGamePreviewProvider(c).verify(game, angles[0], goodDraft, facts, { model: "m", effort: "medium" });
    const system = String(calls(c)[0].system);
    expect(system).toContain("'I'm pretty sure this is my last year' written as 'his final season'");
    expect(system).toContain("a statistic the source gives 'so far' or as of an earlier game or record presented as the current number");
  });

  it("the writer is told status certainty must match source certainty (especially in the title), and which facts are central", async () => {
    const c = client(msg([text({ status: "ready", reason: "", title: "t", caption: "c", claims: [{ text: "x", fact_ids: ["f1"], evidence: "e" }] })]));
    await new AnthropicGamePreviewProvider(c).write(game, { ...angles[0], centralFactIds: ["f1", "f3"] }, facts, { model: "m", effort: "medium", maxChars: 700, maxCitedFacts: 4, recentHooks: [], feedback: [] });
    expect(String(calls(c)[0].system)).toMatch(/Status certainty must match source certainty, especially in the title/);
    expect(JSON.stringify(calls(c)[0].messages)).toContain("Central facts (the story rests on these; cite them): f1, f3");
  });

  it("the reviewer is shown the central story and the credited primary source, so it can block a credit that supports only an incidental claim", async () => {
    const c = client(msg([text({ blocking: [], advisory: [] })]));
    await new AnthropicGamePreviewProvider(c).verify(game, { ...angles[0], centralFactIds: ["f1"] }, goodDraft, facts, { model: "m", effort: "medium" });
    const user = (calls(c)[0].messages as Array<{ content: string }>)[0].content;
    expect(user).toContain("Central story:");
    expect(user).toContain("Credited primary source: ESPN");
    expect(String(calls(c)[0].system)).toMatch(/central_source_mismatch/);
  });

  it("the angle stage separates the facts that establish the central story; the research asks for the trusted original of a republished story and a page-stated date", async () => {
    const withCentral = { angles: angles.map((a) => ({ id: a.id, type: a.type, summary: a.summary, fact_ids: a.factIds, central_fact_ids: [a.factIds[0]], scores: a.scores, note: a.note })), selected_id: "a1", selection_reason: "x", rejected: [] };
    const c = client(msg([text(withCentral)]));
    const sel = await new AnthropicGamePreviewProvider(c).selectAngle(game, facts, { model: "m", effort: "medium" });
    expect(sel.angles[0].centralFactIds).toEqual(["f1"]);
    expect(String(calls(c)[0].system)).toMatch(/central_fact_ids/);
    const r = client(msg([searchUse(), searchResult([ESPN]), text({ facts: [rawFact()] })]));
    await new AnthropicGamePreviewProvider(r).research(game, ctx);
    const system = String(calls(r)[0].system);
    expect(system).toMatch(/republished on Yahoo/);
    expect(system).toMatch(/poor sources to show a reader/);
    expect(system).toMatch(/Never use the crawl date/);
  });
});

describe("credit lookup: searching the trusted domains for the page that carries a claim", () => {
  const lookupCtx = { model: "m", effort: "medium", maxSearchCalls: 3, webSearchToolVersion: "web_search_20250305", blockedDomains: ["reddit.com"], trustedDomains: ["espn.com", "nfl.com"] };
  it("restricts the search to the trusted domains and returns only a page the search reached on one of them, with its excerpt", async () => {
    const good = "https://www.espn.com/nfl/story/_/id/77/titans-fall-to-0-5";
    const c = client(msg([searchUse(), searchResult([good, "https://random-blog.example/x"]), text({ results: [{ fact_id: "f1", url: good, title: "Titans fall to 0-5", provider: "ESPN", published_at: "2026-10-12T10:00:00Z", excerpt: "Tennessee fell to 0-5." }, { fact_id: "f2", url: "https://random-blog.example/x", title: "x", provider: "x", published_at: null, excerpt: "y" }, { fact_id: "f3", url: "https://www.espn.com/never-reached", title: "n", provider: "ESPN", published_at: null, excerpt: "z" }] })]));
    const out = await new AnthropicGamePreviewProvider(c).findTrustedSources(game, facts, lookupCtx);
    const tool = (calls(c)[0].tools as Array<Record<string, unknown>>)[0];
    expect(tool.allowed_domains).toEqual(["espn.com", "nfl.com"]);
    expect(tool.blocked_domains).toBeUndefined(); // the API accepts one of the two
    expect(out.found[0]).toEqual({ factId: "f1", hit: { url: good, title: "Titans fall to 0-5", provider: "ESPN", publishedAt: "2026-10-12T10:00:00.000Z", excerpt: "Tennessee fell to 0-5." } });
    expect(out.found[1].hit).toBeNull(); // not a trusted domain
    expect(out.found[2].hit).toBeNull(); // never reached by the search
    expect(String(calls(c)[0].system)).toMatch(/Search ONLY the allowed trusted domains/);
  });
  it("when the API refuses domains its crawler cannot access (the production 400), the lookup retries once without exactly those domains", async () => {
    const good = "https://www.espn.com/nfl/story/_/id/77/titans-fall-to-0-5";
    const refusal = new Error("anthropic_api_400: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The following domains are not accessible to our user agent: ['apnews.com', 'reuters.com', 'theathletic.com']. Read more");
    const create = vi.fn<(params: Record<string, unknown>) => Promise<Msg>>();
    create.mockRejectedValueOnce(refusal).mockResolvedValueOnce(msg([searchUse(), searchResult([good]), text({ results: [{ fact_id: "f1", url: good, title: "Titans fall to 0-5", provider: "ESPN", published_at: null, excerpt: "Tennessee fell to 0-5." }] })]));
    const c = { messages: { create } } as unknown as ConstructorParameters<typeof AnthropicGamePreviewProvider>[0];
    const out = await new AnthropicGamePreviewProvider(c).findTrustedSources(game, [facts[0]], { ...lookupCtx, trustedDomains: ["espn.com", "apnews.com", "reuters.com", "theathletic.com", "nfl.com"] });
    expect(create).toHaveBeenCalledTimes(2);
    expect(((create.mock.calls[1][0].tools as Array<Record<string, unknown>>)[0]).allowed_domains).toEqual(["espn.com", "nfl.com"]);
    expect(out.found[0].hit?.url).toBe(good);
  });
  it("any other API error is not retried: it propagates (and the pipeline records it)", async () => {
    const create = vi.fn(async () => { throw new Error("anthropic_api_500: overloaded"); });
    const c = { messages: { create } } as unknown as ConstructorParameters<typeof AnthropicGamePreviewProvider>[0];
    await expect(new AnthropicGamePreviewProvider(c).findTrustedSources(game, [facts[0]], lookupCtx)).rejects.toThrow(/anthropic_api_500/);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("makes no call when there is nothing to search with", async () => {
    const c = client();
    const out = await new AnthropicGamePreviewProvider(c).findTrustedSources(game, facts, { ...lookupCtx, maxSearchCalls: 0 });
    expect(out.found.every((f) => f.hit === null)).toBe(true);
    expect(calls(c)).toHaveLength(0);
  });
});

describe("release gate: figure freshness, number classification and syndication reach the provider", () => {
  it("research asks for number_kind / as_of / original_publisher, and parses them; a syndicated page is credited under its original publisher", async () => {
    const yahoo = "https://sports.yahoo.com/articles/walker-returns-123.html";
    const c = client(msg([searchUse(), searchResult([ESPN, yahoo]), text({ facts: [rawFact({ number_kind: "CURRENT_STATE", as_of: "2026-10-12T00:00:00Z", as_of_label: "through 5 games" }), rawFact({ claim: "B", source_url: yahoo, source_provider: "Yahoo Sports", original_publisher: "Sports Illustrated", original_url: "https://www.si.com/nfl/seahawks/onsi/x", number_kind: "FIXED", as_of_label: "entering the season" }), rawFact({ claim: "C", number_kind: "WEIRD" })] })]));
    const out = await new AnthropicGamePreviewProvider(c).research(game, ctx);
    expect(out.facts[0]).toMatchObject({ numberKind: "CURRENT_STATE", asOf: "2026-10-12T00:00:00.000Z", asOfLabel: "through 5 games" });
    expect(out.facts[1]).toMatchObject({ numberKind: "FIXED", sourceUrl: yahoo, sourceProvider: "Sports Illustrated", originalPublisher: "Sports Illustrated", originalUrl: "https://www.si.com/nfl/seahawks/onsi/x" });
    expect(out.facts[2].numberKind).toBeUndefined(); // an unknown class is no class: no gate
    const system = String(calls(c)[0].system);
    expect(system).toMatch(/number_kind/);
    expect(system).toMatch(/Do not treat the words 'so far' as proof the figure is current/);
    expect(system).toMatch(/Originally appeared on/);
  });

  it("every stage is told the latest completed Games before this one", async () => {
    const c = client(msg([searchUse(), searchResult([ESPN]), text({ facts: [rawFact()] })]));
    await new AnthropicGamePreviewProvider(c).research({ ...game, lastCompleted: [{ team: "Green Bay Packers", completedUtc: "2026-10-19T03:00:00.000Z" }] }, ctx);
    expect(JSON.stringify(calls(c)[0].messages)).toContain("Green Bay Packers (2026-10-19T03:00Z)");
    const opener = client(msg([searchUse(), searchResult([ESPN]), text({ facts: [rawFact()] })]));
    await new AnthropicGamePreviewProvider(opener).research({ ...game, lastCompleted: [] }, ctx);
    expect(JSON.stringify(calls(opener)[0].messages)).toContain("No completed Game of these teams before this one is recorded");
  });

  it("when the completed Games could not be read the prompt says so and does not claim an opener", async () => {
    const c = client(msg([searchUse(), searchResult([ESPN]), text({ facts: [rawFact()] })]));
    await new AnthropicGamePreviewProvider(c).research({ ...game, lastCompleted: undefined }, ctx);
    const user = JSON.stringify(calls(c)[0].messages);
    expect(user).toContain("not available");
    expect(user).not.toContain("opener");
  });

  it("the reviewer is told a TRUE number from an older source can be stale, and receives the scope hints", async () => {
    const c = client(msg([text({ blocking: [], advisory: [] })]));
    await new AnthropicGamePreviewProvider(c).verify(game, angles[0], goodDraft, facts, { model: "m", effort: "medium" }, { figures: [], seasonClaims: [], staleNumbers: ["f1: current through through 5 games"], fixedNumbers: ["f2: entering the season"] });
    const system = String(calls(c)[0].system);
    expect(system).toContain("a TRUE number from an older source can still be stale");
    expect(system).toContain("must not be written as the current figure");
    const user = (calls(c)[0].messages as Array<{ content: string }>)[0].content;
    expect(user).toContain("staleNumbers");
    expect(user).toContain("entering the season");
  });

  it("number refresh: confirmed / updated (only a page the search reached) / unavailable, with the old source never confirming itself", async () => {
    const fresh = "https://www.espn.com/nfl/story/_/id/9/titans-run-game";
    const c = client(msg([searchUse(), searchResult([fresh]), text({ results: [
      { fact_id: "f1", status: "updated", note: "ESPN through Game 6", claim: "Tennessee averages 59.8 rushing yards per game through six games.", excerpt: "59.8 per game", source_url: fresh, source_title: "Titans run game", source_provider: "ESPN", published_at: "2026-10-19T14:00:00Z", as_of: "2026-10-18T06:00:00Z", as_of_label: "through 6 games" },
      { fact_id: "f2", status: "updated", note: "x", claim: "Made up.", excerpt: "x", source_url: "https://never-reached.example/x", source_title: "x", source_provider: "x", published_at: null, as_of: null, as_of_label: null },
      { fact_id: "f3", status: "confirmed", note: "still 2-3" },
    ] })]));
    const out = await new AnthropicGamePreviewProvider(c).refreshNumbers(game, facts, { model: "m", effort: "medium", maxSearchCalls: 3, webSearchToolVersion: "web_search_20250305", blockedDomains: ["reddit.com"] });
    expect(out.results[0]).toMatchObject({ factId: "f1", status: "updated", fact: { claim: expect.stringContaining("59.8"), sourceUrl: fresh, asOfLabel: "through 6 games" } });
    expect(out.results[1].status).toBe("unavailable"); // a page the search never reached is not evidence
    expect(out.results[2]).toMatchObject({ factId: "f3", status: "confirmed" });
    expect(String(calls(c)[0].system)).toMatch(/never reuse the old source to confirm itself/i);
    expect((calls(c)[0].tools as Array<Record<string, unknown>>)[0].max_uses).toBe(2);
    const none = client();
    const skipped = await new AnthropicGamePreviewProvider(none).refreshNumbers(game, facts, { model: "m", effort: "medium", maxSearchCalls: 0, webSearchToolVersion: "x", blockedDomains: [] });
    expect(skipped.results.every((r) => r.status === "unavailable")).toBe(true);
    expect(calls(none)).toHaveLength(0);
  });
});

describe("the real SDK accepts the research request", () => {
  it("max_tokens large enough to need streaming does not make the SDK refuse the request client-side (an explicit timeout is passed)", async () => {
    const body = { id: "m", type: "message", role: "assistant", model: "configured-model", content: [searchUse(), searchResult([ESPN]), text({ facts: [rawFact()] })], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 1 } } };
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    const real = new Anthropic({ apiKey: "test-key", fetch: fetchSpy as unknown as typeof fetch, maxRetries: 0 });
    const out = await new AnthropicGamePreviewProvider(real).research(game, ctx);
    expect(out.facts).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledOnce();
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
