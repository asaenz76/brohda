import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  ANGLE_SCHEMA, DRAFT_SCHEMA, FORMAT_RETRY, SCORE_SCHEMA, VERIFY_SCHEMA, anglesSystem, describeGame, draftSystem, evidenceForModel, extractClaimsSystem, researchSystem, scoreSystem, untrustedBlock, verifySystem,
} from "../prompts";
import { BUILT_IN_BLOCKED_DOMAINS, canonicalUrl } from "../source-policy";
import {
  ANGLE_TYPES, AVAILABILITY_STATUSES, CLAIM_TYPES, addUsage, emptyUsage,
  type Angle, type AngleType, type AvailabilityStatus, type ClaimType, type Draft, type DraftClaim, type EvidenceItem, type GameContext, type ModelClaimVerdict, type ModelScore, type ProviderUsage, type RawEvidence,
  type ResearchContext, type ResearchResult, type StoryAngleProvider, type StoryDraftProvider, type StoryResearchProvider, type StoryScorerProvider, type StoryVerifierProvider, type SubjectTeam,
} from "../types";

/**
 * The Anthropic implementation of the five story stages. One class implements the provider-neutral interfaces; nothing outside `providers/` imports it.
 *
 * Nothing vendor-specific is a constant: MODEL, EFFORT and the web-search TOOL VERSION arrive from the stored configuration (game_story_config); the API key comes from the environment
 * (`ANTHROPIC_API_KEY`, server-side only) and is never logged, stored or returned. There is no silent fallback to another model. Errors are reduced to a category plus the API's own short message.
 * Requests have an explicit timeout; transient failures (rate limit, overload, 5xx, connection, timeout) get a bounded retry with backoff; nothing else is retried.
 */
export type MessagesClient = Pick<Anthropic, "messages">;

export type ProviderErrorCategory = "rate_limit" | "timeout" | "provider_unavailable" | "provider_error" | "search_quota" | "refusal" | "truncated" | "structured_output" | "credentials_missing";
export class StoryProviderError extends Error {
  constructor(readonly category: ProviderErrorCategory, message: string) {
    super(message);
    this.name = "StoryProviderError";
  }
}

const RESEARCH_MAX_TOKENS = 16000;
const STAGE_MAX_TOKENS = 6000;
const MAX_PAUSE_RESUMES = 4;
/** A multi-search research session legitimately takes minutes (the legacy engine allowed 290 s): research never gets less than this, whatever the per-request setting. The route itself is capped at 300 s. */
export const RESEARCH_MIN_TIMEOUT_MS = 240_000;

interface CallResult {
  text: string;
  blocks: Anthropic.Messages.ContentBlock[];
  usage: ProviderUsage;
  request: Omit<Anthropic.Messages.MessageCreateParamsNonStreaming, "stream" | "tools">;
}

export function classifyError(error: unknown): StoryProviderError {
  if (error instanceof StoryProviderError) return error;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new StoryProviderError("timeout", "anthropic_timeout: the request timed out");
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    const msg = `anthropic_api_${status || "error"}: ${(error.message ?? "").slice(0, 300)}`;
    if (status === 429) return new StoryProviderError("rate_limit", msg);
    if (status === 529 || status >= 500) return new StoryProviderError("provider_unavailable", msg);
    return new StoryProviderError("provider_error", msg);
  }
  if (error instanceof Error && /timed? ?out|timeout|ETIMEDOUT/i.test(error.message)) return new StoryProviderError("timeout", `anthropic_timeout: ${error.message.slice(0, 200)}`);
  return new StoryProviderError("provider_error", error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300));
}
const retryable = (c: ProviderErrorCategory): boolean => c === "rate_limit" || c === "provider_unavailable" || c === "timeout";

export interface ProviderOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  retries: number;
  timeoutMs: number;
  webSearchToolVersion: string;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const structured = (effort: string, schema: object) => ({ effort: effort as ProviderOptions["effort"], format: { type: "json_schema" as const, schema: schema as Record<string, unknown> } });

export function extractJson<T>(text: string, what: string): T {
  const start = text.indexOf("{");
  if (start === -1) throw new StoryProviderError("structured_output", `The ${what} answer contained no JSON.`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as T;
      } catch {
        break;
      }
    }
  }
  throw new StoryProviderError("structured_output", `The ${what} answer was not valid JSON.`);
}

const asStr = (v: unknown, max = 600): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asIdList = (v: unknown): string[] => asList(v).filter((x): x is string => typeof x === "string");
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);

export class AnthropicStoryProvider implements StoryResearchProvider, StoryAngleProvider, StoryDraftProvider, StoryVerifierProvider, StoryScorerProvider {
  readonly name = "anthropic";
  constructor(private readonly client: MessagesClient, private readonly options: ProviderOptions) {}

  private async call(params: Omit<Anthropic.Messages.MessageCreateParamsNonStreaming, "stream">, countsSearch: boolean, timeoutMs: number = this.options.timeoutMs): Promise<CallResult> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const messages: Anthropic.Messages.MessageParam[] = [...params.messages];
    let usage: ProviderUsage = emptyUsage();
    const blocks: Anthropic.Messages.ContentBlock[] = [];
    let last: Anthropic.Messages.Message | null = null;
    for (let resumes = 0; ; resumes++) {
      let response: Anthropic.Messages.Message | null = null;
      for (let attempt = 0; ; attempt++) {
        try {
          response = (await this.client.messages.create({ ...params, messages }, { timeout: timeoutMs })) as Anthropic.Messages.Message;
          break;
        } catch (error) {
          const e = classifyError(error);
          if (!retryable(e.category) || attempt >= this.options.retries) throw e;
          await sleep(Math.min(500 * 2 ** attempt, 4000));
        }
      }
      last = response;
      blocks.push(...response.content);
      const searched = countsSearch ? (response.usage.server_tool_use?.web_search_requests ?? response.content.filter((b) => b.type === "server_tool_use" && b.name === "web_search").length) : 0;
      usage = addUsage(usage, { modelCalls: 1, searchCalls: searched, inputTokens: response.usage.input_tokens ?? 0, outputTokens: response.usage.output_tokens ?? 0 });
      if (response.stop_reason === "pause_turn") {
        if (resumes >= MAX_PAUSE_RESUMES) throw new StoryProviderError("search_quota", "anthropic_pause_limit: the search kept pausing");
        messages.push({ role: "assistant", content: response.content as Anthropic.Messages.ContentBlockParam[] });
        continue;
      }
      break;
    }
    if (last!.stop_reason === "refusal") throw new StoryProviderError("refusal", "anthropic_refusal: the model declined this request");
    if (last!.stop_reason === "max_tokens") throw new StoryProviderError("truncated", "anthropic_max_tokens: the answer was cut off");
    const text = last!.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text").map((b) => b.text).join("");
    const request: CallResult["request"] & { tools?: unknown } = { ...params };
    delete request.tools;
    return { text, blocks, usage, request };
  }

  private async structuredCall<T>(system: string, user: string, schema: object, what: string): Promise<{ value: T; usage: ProviderUsage }> {
    const result = await this.call({ model: this.options.model, max_tokens: STAGE_MAX_TOKENS, system, output_config: structured(this.options.effort, schema), messages: [{ role: "user", content: user }] }, false);
    return { value: extractJson<T>(result.text, what), usage: result.usage };
  }

  // ---- research ---------------------------------------------------------------------------------------------------------------------------------------
  async research(game: GameContext, ctx: ResearchContext): Promise<ResearchResult> {
    const { config } = ctx;
    const blocked = [...new Set([...BUILT_IN_BLOCKED_DOMAINS, ...config.blockedDomains])];
    const tool: Record<string, unknown> = { type: this.options.webSearchToolVersion, name: "web_search", max_uses: config.maxQueriesPerGame, blocked_domains: blocked };
    const first = await this.call(
      { model: this.options.model, max_tokens: RESEARCH_MAX_TOKENS, system: researchSystem(game, config.maxQueriesPerGame, blocked), output_config: { effort: this.options.effort }, tools: [tool as unknown as Anthropic.Messages.ToolUnion], messages: [{ role: "user", content: `Research this Game and return the facts.\n${describeGame(game)}\nToday (UTC): ${ctx.now.toISOString()}` }] },
      true,
      Math.min(290_000, Math.max(this.options.timeoutMs, RESEARCH_MIN_TIMEOUT_MS)),
    );
    // pages the search actually reached: a fact is accepted only if its URL is one of them (the model cannot cite a page it did not retrieve)
    const reached = new Set<string>();
    let resultsSeen = 0;
    for (const b of first.blocks) {
      if (b.type !== "web_search_tool_result") continue;
      if (Array.isArray(b.content)) for (const r of b.content) { reached.add(canonicalUrl(r.url)); resultsSeen++; }
      else {
        const code = (b.content as { error_code?: string }).error_code ?? "unknown";
        if (!resultsSeen && !reached.size) throw new StoryProviderError(/too_many|max_uses|quota/.test(code) ? "search_quota" : "provider_unavailable", `anthropic_web_search_error: ${code}`);
      }
    }
    let usage = first.usage;
    let parsed: { facts?: unknown };
    try {
      parsed = extractJson(first.text, "research");
    } catch {
      // ONE bounded format retry, with no tools: the model is shown its own answer and asked to return the same findings as valid JSON.
      const retry = await this.call({ ...first.request, messages: [...first.request.messages, { role: "assistant", content: first.text.trim() || "(no answer)" }, { role: "user", content: FORMAT_RETRY }] }, false, this.options.timeoutMs);
      usage = addUsage(usage, retry.usage);
      parsed = extractJson(retry.text, "research");
    }
    const items: RawEvidence[] = [];
    for (const f of asList(parsed.facts)) {
      if (!f || typeof f !== "object") continue;
      const o = f as Record<string, unknown>;
      const url = asStr(o.url, 600);
      const factText = asStr(o.fact_text, 600);
      if (!url || !factText || !reached.has(canonicalUrl(url))) continue;
      items.push({
        url,
        publisher: asStr(o.publisher, 200) || null,
        title: asStr(o.title, 400) || null,
        publishedAt: asStr(o.published_at, 40) || null,
        evidenceType: o.evidence_type === "OFFICIAL_STATEMENT" ? "OFFICIAL_STATEMENT" : "ARTICLE",
        factKey: asStr(o.fact_key, 200) || null,
        factValue: asStr(o.fact_value, 100) || null,
        subjectTeam: oneOf<SubjectTeam>(o.subject_team, ["HOME", "AWAY", "BOTH", "NEITHER"], "NEITHER"),
        factText,
        excerpt: asStr(o.excerpt, 400) || null,
        asOf: asStr(o.as_of, 40) || null,
      });
    }
    return { items, usage, queriesUsed: usage.searchCalls };
  }

  // ---- angles ------------------------------------------------------------------------------------------------------------------------------------------
  async propose(game: GameContext, evidence: EvidenceItem[], ctx: ResearchContext): Promise<{ angles: Angle[]; usage: ProviderUsage }> {
    const { value, usage } = await this.structuredCall<{ angles?: unknown }>(anglesSystem(), `${describeGame(game)}\nToday (UTC): ${ctx.now.toISOString()}\n\n${untrustedBlock("evidence", evidenceForModel(evidence))}`, ANGLE_SCHEMA, "angles");
    const angles: Angle[] = [];
    for (const a of asList(value.angles)) {
      if (!a || typeof a !== "object") continue;
      const o = a as Record<string, unknown>;
      angles.push({ type: oneOf<AngleType>(o.type, ANGLE_TYPES, "OTHER"), summary: asStr(o.summary, 400), evidenceIds: asIdList(o.evidence_ids) });
    }
    return { angles, usage };
  }

  // ---- drafting ----------------------------------------------------------------------------------------------------------------------------------------
  private parseClaims(list: unknown): DraftClaim[] {
    const claims: DraftClaim[] = [];
    for (const c of asList(list)) {
      if (!c || typeof c !== "object") continue;
      const o = c as Record<string, unknown>;
      const quoteText = asStr(o.quote_text, 400);
      claims.push({
        id: "",
        text: asStr(o.text, 400),
        type: oneOf<ClaimType>(o.type, CLAIM_TYPES, "CONTEXT"),
        subjectTeam: oneOf<SubjectTeam>(o.subject_team, ["HOME", "AWAY", "BOTH", "NEITHER"], "NEITHER"),
        evidenceIds: asIdList(o.evidence_ids),
        availabilityStatus: o.availability_status ? oneOf<AvailabilityStatus>(o.availability_status, AVAILABILITY_STATUSES, "QUESTIONABLE") : null,
        quote: quoteText ? { text: quoteText, speaker: asStr(o.quote_speaker, 100) } : null,
      });
    }
    return claims;
  }

  async draft(game: GameContext, angle: Angle, evidence: EvidenceItem[], ctx: ResearchContext & { feedback: string[]; recentHooks: string[] }): Promise<{ draft: Draft; usage: ProviderUsage }> {
    const user = [
      describeGame(game),
      `Today (UTC): ${ctx.now.toISOString()}`,
      `Chosen angle (${angle.type}): ${angle.summary}`,
      `Evidence ids the angle rests on: ${angle.evidenceIds.join(", ")}`,
      ctx.recentHooks.length ? `Recent hooks (do not echo their wording): ${JSON.stringify(ctx.recentHooks.slice(0, 10))}` : "",
      ctx.feedback.length ? `Feedback on the previous attempt (fix this): ${ctx.feedback.join(" | ")}` : "",
      untrustedBlock("evidence", evidenceForModel(evidence)),
    ].filter(Boolean).join("\n\n");
    const { value, usage } = await this.structuredCall<{ hook?: unknown; body?: unknown; claims?: unknown }>(draftSystem(ctx.config.maxChars), user, DRAFT_SCHEMA, "draft");
    return { draft: { hook: asStr(value.hook, 400), body: asStr(value.body, 2000), claims: this.parseClaims(value.claims) }, usage };
  }

  async extractClaims(game: GameContext, hook: string, body: string, evidence: EvidenceItem[], ctx: ResearchContext): Promise<{ claims: DraftClaim[]; usage: ProviderUsage }> {
    const user = [describeGame(game), `Today (UTC): ${ctx.now.toISOString()}`, `Hook: ${hook}\nBody: ${body}`, untrustedBlock("evidence", evidenceForModel(evidence))].join("\n\n");
    const { value, usage } = await this.structuredCall<{ claims?: unknown }>(extractClaimsSystem(), user, { ...DRAFT_SCHEMA, required: ["claims"], properties: { claims: DRAFT_SCHEMA.properties.claims } }, "claim extraction");
    return { claims: this.parseClaims(value.claims), usage };
  }

  // ---- verification and scoring --------------------------------------------------------------------------------------------------------------------------
  async verifyClaims(game: GameContext, claims: DraftClaim[], evidence: EvidenceItem[], ctx: ResearchContext): Promise<{ verdicts: ModelClaimVerdict[]; usage: ProviderUsage }> {
    const byId = new Map(evidence.map((e) => [e.id, e]));
    const payload = claims.map((c) => ({ claim_id: c.id, claim: c.text, type: c.type, subject_team: c.subjectTeam, availability_status: c.availabilityStatus, quote: c.quote, cited_evidence: evidenceForModel(c.evidenceIds.map((id) => byId.get(id)).filter((e): e is EvidenceItem => !!e)) }));
    const { value, usage } = await this.structuredCall<{ verdicts?: unknown }>(verifySystem(), `${describeGame(game)}\nToday (UTC): ${ctx.now.toISOString()}\n\n${untrustedBlock("claims and their cited evidence", payload)}`, VERIFY_SCHEMA, "verification");
    const verdicts: ModelClaimVerdict[] = [];
    for (const v of asList(value.verdicts)) {
      if (!v || typeof v !== "object") continue;
      const o = v as Record<string, unknown>;
      verdicts.push({ claimId: asStr(o.claim_id, 80), verdict: oneOf(o.verdict, ["SUPPORTED", "PARTIAL", "UNSUPPORTED", "CONTRADICTED"] as const, "UNSUPPORTED"), note: asStr(o.note, 500) });
    }
    return { verdicts, usage };
  }

  async score(game: GameContext, draft: Draft, evidence: EvidenceItem[], ctx: ResearchContext): Promise<{ score: ModelScore; usage: ProviderUsage }> {
    const cited = new Set(draft.claims.flatMap((c) => c.evidenceIds));
    const used = evidence.filter((e) => cited.has(e.id));
    const user = `${describeGame(game)}\nToday (UTC): ${ctx.now.toISOString()}\n\nHook: ${draft.hook}\nBody: ${draft.body}\n\n${untrustedBlock("evidence the story rests on", evidenceForModel(used))}`;
    const { value, usage } = await this.structuredCall<Record<string, unknown>>(scoreSystem(), user, SCORE_SCHEMA, "scoring");
    return {
      score: { dims: { relevance: value.relevance, evidence: value.evidence, debate: value.debate, originality: value.originality, freshness: value.freshness }, generic: value.generic === true, safetyFlags: asIdList(value.safety_flags).map((s) => s.slice(0, 40)), rationale: asStr(value.rationale, 600) },
      usage,
    };
  }
}
