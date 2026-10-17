import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { OpenAIGamePreviewProvider, PREVIEW_PROMPT_VERSION } from "@/lib/game-previews/providers/openai";
import { createGamePreviewProviders } from "@/lib/game-previews/providers";
import { config, facts, game, goodDraft } from "./fixtures";

const ESPN = "https://www.espn.com/nfl/game/_/gameId/401872984";

function responses(body: unknown, status = 200) {
  return vi.fn<(url: string, init: { body?: string; headers?: Record<string, string> }) => Promise<Response>>(async () => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response);
}
const message = (json: unknown, annotations: Array<{ type: string; url: string }> = []) => ({ type: "message", content: [{ type: "output_text", text: JSON.stringify(json), annotations }] });
const searchCall = (urls: string[]) => ({ type: "web_search_call", action: { sources: urls.map((url) => ({ url })) } });
const rawFact = (over: Record<string, unknown> = {}) => ({ kind: "historical", claim: "Tennessee lost 26-3 to Houston.", excerpt: "Texans 26, Titans 3", source_url: ESPN, source_provider: "ESPN", source_title: "Texans 26, Titans 3", published_at: "2026-10-11T22:00:00Z", relevance: 0.9, game_association: "Titans' last game", ...over });
const ctx = { model: "configured-model", maxSearchCalls: 6, preferredDomains: ["espn.com"], blockedDomains: ["reddit.com"] };

describe("OpenAI provider — research", () => {
  it("calls the Responses API with the CONFIGURED model, mandatory web search, a call ceiling and a strict JSON schema, using the key from configuration", async () => {
    const fetchImpl = responses({ output: [searchCall([ESPN]), message({ facts: [rawFact()] })], usage: { input_tokens: 800, output_tokens: 200 } });
    const provider = new OpenAIGamePreviewProvider({ apiKey: "sk-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    await provider.research(game, ctx);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.headers).toMatchObject({ Authorization: "Bearer sk-test" });
    const body = JSON.parse(init.body!);
    expect(body.model).toBe("configured-model");
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.tool_choice).toBe("required"); // it must actually search
    expect(body.max_tool_calls).toBe(6);
    expect(body.include).toContain("web_search_call.action.sources");
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(body.instructions).toMatch(/must use web search/i);
    expect(body.instructions).toContain("Preferred domains: espn.com");
    expect(body.instructions).toContain("Never use these domains: reddit.com");
    expect(body.input).toContain("Tennessee Titans at Indianapolis Colts");
    expect(body.input).toContain(game.kickoffUtc);
  });

  it("returns structured facts, counts the searches and tokens, and stamps the retrieval time", async () => {
    const fetchImpl = responses({ output: [searchCall([ESPN]), searchCall([ESPN]), message({ facts: [rawFact(), rawFact({ claim: "Indianapolis is 2-3.", kind: "historical" })] }, [{ type: "url_citation", url: ESPN }])], usage: { input_tokens: 800, output_tokens: 200 } });
    const out = await new OpenAIGamePreviewProvider({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch }).research(game, ctx);
    expect(out.usage).toEqual({ searchCalls: 2, modelCalls: 1, inputTokens: 800, outputTokens: 200 });
    expect(out.facts.map((f) => f.id)).toEqual(["f1", "f2"]);
    expect(out.facts[0]).toMatchObject({ kind: "historical", sourceProvider: "ESPN", retrievedAt: game.asOf, publishedAt: "2026-10-11T22:00:00.000Z", relevance: 0.9 });
  });

  it("drops a fact whose source the search never reached (a fabricated citation) and a fact from a blocked domain", async () => {
    const fetchImpl = responses({
      output: [searchCall([ESPN, "https://www.reddit.com/r/nfl/x"]), message({ facts: [rawFact(), rawFact({ claim: "Invented.", source_url: "https://www.espn.com/never-fetched" }), rawFact({ claim: "Rumor.", source_url: "https://www.reddit.com/r/nfl/x" })] })],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const out = await new OpenAIGamePreviewProvider({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch }).research(game, ctx);
    expect(out.facts.map((f) => f.claim)).toEqual(["Tennessee lost 26-3 to Houston."]);
  });

  it("surfaces an API error, and an unparseable answer, as errors (the pipeline records them as a failed run)", async () => {
    await expect(new OpenAIGamePreviewProvider({ apiKey: "k", fetchImpl: responses({ error: { message: "bad key" } }, 401) as unknown as typeof fetch }).research(game, ctx)).rejects.toThrow(/401/);
    const garbage = responses({ output: [searchCall([ESPN]), { type: "message", content: [{ type: "output_text", text: "not json" }] }] });
    await expect(new OpenAIGamePreviewProvider({ apiKey: "k", fetchImpl: garbage as unknown as typeof fetch }).research(game, ctx)).rejects.toThrow(/not valid JSON/);
  });
});

describe("OpenAI provider — writing and verification", () => {
  it("the writer gets only the facts, the configured limits and any rejection feedback; and returns claims mapped to fact ids", async () => {
    const fetchImpl = responses({ output: [message({ hook: goodDraft.hook, preview: goodDraft.preview, claims: goodDraft.claims.map((c) => ({ text: c.text, fact_ids: c.factIds })) })], usage: { input_tokens: 500, output_tokens: 120 } });
    const provider = new OpenAIGamePreviewProvider({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    const draft = await provider.write(game, facts, { model: "configured-model", maxChars: 700, hookMaxChars: 120, feedback: ["The figure \"27\" is not in the facts."] });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body!);
    expect(body.tools).toBeUndefined(); // writing never searches
    expect(body.model).toBe("configured-model");
    expect(body.instructions).toContain("at most 700 characters");
    expect(body.instructions).toContain("at most 120 characters");
    expect(body.instructions).toMatch(/most interesting TRUE story/);
    expect(body.instructions).toMatch(/Do not manufacture drama/);
    expect(body.input).toContain("previous draft was rejected");
    expect(body.input).toContain('"27"');
    expect(draft).toMatchObject({ hook: goodDraft.hook, promptVersion: PREVIEW_PROMPT_VERSION, usage: { searchCalls: 0, modelCalls: 1, inputTokens: 500, outputTokens: 120 } });
    expect(draft.claims[0]).toEqual({ text: goodDraft.claims[0].text, factIds: ["f1"] });
  });

  it("the verifier reports unsupported statements", async () => {
    const fetchImpl = responses({ output: [message({ supported: false, problems: ["'unbeaten at home' is not supported"] })], usage: { input_tokens: 300, output_tokens: 40 } });
    const out = await new OpenAIGamePreviewProvider({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch }).verify(game, goodDraft, facts, { model: "configured-model" });
    expect(out).toMatchObject({ supported: false, problems: ["'unbeaten at home' is not supported"] });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body!);
    expect(body.instructions).toMatch(/strict fact-checker/);
    expect(body.tools).toBeUndefined();
  });
});

describe("provider selection", () => {
  it("is built from the stored provider, with credentials ONLY from the environment; no key means 'not configured'", () => {
    expect(createGamePreviewProviders(config, {})).toBeNull();
    const p = createGamePreviewProviders(config, { OPENAI_API_KEY: "sk-x" })!;
    expect(p.research.name).toBe("openai");
    expect(p.verifier).not.toBeNull();
    expect(createGamePreviewProviders({ ...config, verifyWithModel: false }, { OPENAI_API_KEY: "sk-x" })!.verifier).toBeNull();
    expect(createGamePreviewProviders({ ...config, provider: "unknown" }, { OPENAI_API_KEY: "sk-x" })).toBeNull();
  });
});
