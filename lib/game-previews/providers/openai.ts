import "server-only";
import type { GamePreviewClaim } from "../types";
import { domainMatches, domainOf } from "../validation";
import { addUsage, emptyUsage, type CandidateFact, type DraftContext, type GameIdentity, type GamePreviewResearchProvider, type GamePreviewVerifierProvider, type GamePreviewWriterProvider, type PreviewDraft, type ProviderUsage, type ResearchContext, type ResearchResult, type VerificationResult } from "./types";

/**
 * The v1 provider: the OpenAI Responses API, with its built-in web search for research and the configured model for angle selection, writing and verification. One class implements the three provider-neutral interfaces; nothing
 * else in the product imports it directly (providers/index.ts selects it from the stored configuration). The model id comes from the stored configuration, the API key from the environment — neither is a constant here.
 */

/** Identifies the instruction set that produced a Preview, so a quality change can be traced to a prompt change. Bump it when the prompts below change. */
export const PREVIEW_PROMPT_VERSION = "game-preview-2026-10-v1";

type Fetch = typeof fetch;
export interface OpenAIClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: Fetch;
}

interface ResponsesResult {
  text: string;
  usage: ProviderUsage;
  /** URLs the search really retrieved or cited in this response (from search-call sources and citations). */
  citedUrls: Set<string>;
}

async function callResponses(opts: OpenAIClientOptions, body: Record<string, unknown>, countsAsSearch: boolean): Promise<ResponsesResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(`${(opts.baseUrl ?? "https://api.openai.com").replace(/\/$/, "")}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI Responses API ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    output?: Array<{ type: string; action?: { sources?: Array<{ url?: string }> }; content?: Array<{ type: string; text?: string; annotations?: Array<{ type: string; url?: string }> }> }>;
    output_text?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string } | null;
    status?: string;
  };
  if (json.error?.message) throw new Error(`OpenAI error: ${json.error.message}`);
  const output = json.output ?? [];
  let searchCalls = 0;
  const citedUrls = new Set<string>();
  let text = "";
  for (const item of output) {
    if (item.type === "web_search_call") {
      searchCalls += 1;
      for (const s of item.action?.sources ?? []) if (s.url) citedUrls.add(s.url);
    }
    if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text") {
          text += c.text ?? "";
          for (const a of c.annotations ?? []) if (a.type === "url_citation" && a.url) citedUrls.add(a.url);
        }
      }
    }
  }
  if (!text && json.output_text) text = json.output_text;
  return {
    text,
    citedUrls,
    usage: { searchCalls: countsAsSearch ? searchCalls : 0, modelCalls: 1, inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
  };
}

function parseJson<T>(text: string, what: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(`The ${what} response was not valid JSON.`);
  }
}

const str = { type: "string" };
const nullableStr = { type: ["string", "null"] };

const RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "claim", "excerpt", "source_url", "source_provider", "source_title", "published_at", "relevance", "game_association"],
        properties: {
          kind: { type: "string", enum: ["current", "historical"] },
          claim: str,
          excerpt: nullableStr,
          source_url: str,
          source_provider: str,
          source_title: str,
          published_at: nullableStr,
          relevance: { type: "number" },
          game_association: str,
        },
      },
    },
  },
} as const;

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hook", "preview", "claims"],
  properties: {
    hook: str,
    preview: str,
    claims: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "fact_ids"], properties: { text: str, fact_ids: { type: "array", items: str } } } },
  },
} as const;

const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["supported", "problems"],
  properties: { supported: { type: "boolean" }, problems: { type: "array", items: str } },
} as const;

const jsonFormat = (name: string, schema: object) => ({ format: { type: "json_schema", name, strict: true, schema } });

function describeGame(game: GameIdentity): string {
  return `Sport: ${game.sport}${game.competition ? ` (${game.competition})` : ""}\nMatchup: ${game.awayTeam} at ${game.homeTeam}\nScheduled start (UTC): ${game.kickoffUtc}\nToday (UTC): ${game.asOf}`;
}

export class OpenAIGamePreviewProvider implements GamePreviewResearchProvider, GamePreviewWriterProvider, GamePreviewVerifierProvider {
  readonly name = "openai";
  constructor(private readonly opts: OpenAIClientOptions) {}

  async research(game: GameIdentity, ctx: ResearchContext): Promise<ResearchResult> {
    const instructions = [
      "You research one specific upcoming game for a sports-prediction app and return VERIFIED FACTS only. You must use web search; never answer from memory.",
      "Search specifically for: both teams and this exact matchup; the date of the game; each team's most recent games and results; meaningful player or team news; injuries and returns where relevant; streaks; milestones; head-to-head history; unusual verified statistics.",
      "Prefer, in order: the official league, the official team, ESPN and other major established sports reporting, established local beat reporting, trusted statistics providers.",
      ctx.preferredDomains.length ? `Preferred domains: ${ctx.preferredDomains.join(", ")}.` : "",
      ctx.blockedDomains.length ? `Never use these domains: ${ctx.blockedDomains.join(", ")}. Never treat social-media posts, rumors or forum threads as sources.` : "",
      'Each fact is ONE statement that a single source directly supports, with the passage that supports it. kind="current" is ONLY for things that can change before the game and are reported as of the source\'s date: injuries, returns, lineup or availability status, who is expected to start. Everything that follows from completed games — results, scores, records, streaks, standings after a game, head-to-head history, milestones already reached — is kind="historical". For current facts report the source\'s real publication time; for historical facts it may be null.',
      "Only report what a retrieved page actually says. If you cannot find something, omit it. Do not infer, estimate or round. Rate relevance 0 to 1 by how interesting and specific the fact is for previewing THIS matchup.",
      "Return facts ONLY about these two teams, their players, or the games between them.",
    ]
      .filter(Boolean)
      .join("\n");
    const result = await callResponses(
      this.opts,
      {
        model: ctx.model,
        instructions,
        input: `Research this game.\n${describeGame(game)}`,
        tools: [{ type: "web_search" }],
        tool_choice: "required",
        max_tool_calls: ctx.maxSearchCalls,
        include: ["web_search_call.action.sources"],
        text: jsonFormat("game_preview_research", RESEARCH_SCHEMA),
      },
      true,
    );
    const parsed = parseJson<{ facts: Array<{ kind: "current" | "historical"; claim: string; excerpt: string | null; source_url: string; source_provider: string; source_title: string; published_at: string | null; relevance: number; game_association: string }> }>(result.text, "research");
    const retrievedAt = game.asOf;
    const facts: CandidateFact[] = [];
    for (const raw of parsed.facts ?? []) {
      // A fact whose source the search never actually reached is a fabricated citation: drop it. So is one from a blocked domain.
      if (!result.citedUrls.has(raw.source_url)) continue;
      if (domainMatches(domainOf(raw.source_url), ctx.blockedDomains)) continue;
      if (!raw.claim?.trim() || !raw.source_url) continue;
      facts.push({
        id: `f${facts.length + 1}`,
        kind: raw.kind === "current" ? "current" : "historical",
        claim: raw.claim.trim(),
        excerpt: raw.excerpt?.trim() || null,
        sourceUrl: raw.source_url,
        sourceProvider: raw.source_provider?.trim() || domainOf(raw.source_url),
        sourceTitle: raw.source_title?.trim() || raw.source_url,
        publishedAt: raw.published_at && !Number.isNaN(new Date(raw.published_at).getTime()) ? new Date(raw.published_at).toISOString() : null,
        retrievedAt,
        relevance: Math.max(0, Math.min(1, Number(raw.relevance) || 0)),
        gameAssociation: raw.game_association?.trim() || "",
      });
    }
    return { facts, usage: result.usage };
  }

  async write(game: GameIdentity, facts: CandidateFact[], ctx: DraftContext): Promise<PreviewDraft> {
    const instructions = [
      "You write the Game Preview for one upcoming game in a sports-prediction app.",
      "Your task: find the most interesting TRUE story around this specific matchup among the facts provided — a streak, a milestone, revenge, a player's run, a historical matchup, an unusual stat, a major injury or return, a record chase. Do not summarize the matchup. Do not manufacture drama.",
      "Use ONLY the facts provided. Every statement of fact (every number, result, name, streak or claim) must come from them. If there is no strong angle, write a simpler verified factual preview. Never add anything from memory.",
      "A fact flagged kind=current may be stated as current only because its source is recent; a historical fact is stated as what happened (\"after a 26-3 loss\"), never as an ongoing condition. Do not describe an old injury or roster state as current.",
      `Hook: one short, compelling headline, at most ${ctx.hookMaxChars} characters. Preview: a short factual story that leads into the question of who wins, at most ${ctx.maxChars} characters; prefer shorter when the story supports it. Plain text, no emoji, no hashtags, no betting language (no odds, spreads, picks).`,
      "Also return `claims`: every material statement you made, each with the ids of the facts that support it.",
    ].join("\n");
    const feedback = ctx.feedback.length ? `\n\nYour previous draft was rejected for these reasons. Fix every one:\n- ${ctx.feedback.join("\n- ")}` : "";
    const result = await callResponses(
      this.opts,
      {
        model: ctx.model,
        instructions,
        input: `${describeGame(game)}\n\nFacts (the only material you may use):\n${JSON.stringify(facts.map((f) => ({ id: f.id, kind: f.kind, claim: f.claim, excerpt: f.excerpt, source: f.sourceProvider, published_at: f.publishedAt, relevance: f.relevance })))}${feedback}`,
        text: jsonFormat("game_preview_draft", DRAFT_SCHEMA),
      },
      false,
    );
    const parsed = parseJson<{ hook: string; preview: string; claims: Array<{ text: string; fact_ids: string[] }> }>(result.text, "writer");
    const claims: GamePreviewClaim[] = (parsed.claims ?? []).map((c) => ({ text: c.text ?? "", factIds: c.fact_ids ?? [] }));
    return { hook: parsed.hook ?? "", preview: parsed.preview ?? "", claims, promptVersion: PREVIEW_PROMPT_VERSION, usage: result.usage };
  }

  async verify(game: GameIdentity, draft: Pick<PreviewDraft, "hook" | "preview" | "claims">, facts: CandidateFact[], ctx: { model: string }): Promise<VerificationResult> {
    const byId = new Map(facts.map((f) => [f.id, f]));
    const cited = new Set(draft.claims.flatMap((c) => c.factIds));
    const material = [...cited].map((id) => byId.get(id)).filter((f): f is CandidateFact => Boolean(f)).map((f) => ({ id: f.id, claim: f.claim, excerpt: f.excerpt, published_at: f.publishedAt, kind: f.kind }));
    const result = await callResponses(
      this.opts,
      {
        model: ctx.model,
        instructions:
          "You are a strict fact-checker. Given a game preview and the only facts it may rest on, decide whether EVERY factual statement in the hook and the preview is directly supported by those facts. Flag any statement, number, name or implication that the facts do not support, any current-state wording resting on a historical fact, and any statement that goes beyond the facts. Do not use outside knowledge.",
        input: `${describeGame(game)}\n\nHook: ${draft.hook}\nPreview: ${draft.preview}\n\nFacts:\n${JSON.stringify(material)}`,
        text: jsonFormat("game_preview_verification", VERIFY_SCHEMA),
      },
      false,
    );
    const parsed = parseJson<{ supported: boolean; problems: string[] }>(result.text, "verifier");
    return { supported: parsed.supported === true && (parsed.problems ?? []).length === 0, problems: parsed.problems ?? [], usage: result.usage };
  }
}

export { addUsage, emptyUsage };
