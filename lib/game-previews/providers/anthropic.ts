import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { GamePreviewClaim } from "../types";
import { domainMatches, domainOf } from "../validation";
import {
  ANGLE_TYPES,
  addUsage,
  emptyUsage,
  type AngleSelection,
  type AngleType,
  type CandidateFact,
  type DraftContext,
  type EditorialAngle,
  type GameIdentity,
  type GamePreviewAngleProvider,
  type GamePreviewResearchProvider,
  type GamePreviewVerifierProvider,
  type GamePreviewWriterProvider,
  type PreviewDraft,
  type ProviderUsage,
  type ReachedSource,
  type ResearchContext,
  type ResearchResult,
  type StageContext,
  type VerificationResult,
} from "./types";

/**
 * The V1 provider: Anthropic's Claude Messages API (official SDK) for the four stages — research with Anthropic's server-side web search, editorial angle selection, writing, and an optional independent read. One class implements the
 * four provider-neutral interfaces; nothing outside `providers/` imports it (providers/index.ts selects it from the stored configuration).
 *
 * Nothing vendor-specific is a constant here: the MODEL id, the EFFORT, the web-search TOOL VERSION and the search ceiling all arrive from the stored configuration; the API key comes from the environment (`ANTHROPIC_API_KEY`) and is
 * never logged, returned or stored. There is no silent fallback to another model: if the configured model is unavailable the call fails and the run records why. Sampling parameters are left at their defaults and thinking is
 * not overridden (the current models reject non-default sampling and manage thinking themselves); depth is controlled by `output_config.effort`.
 */

/** Identifies the instruction set that produced a Preview, so a quality change can be traced to a prompt change. Bump it when the prompts below change. */
export const PREVIEW_PROMPT_VERSION = "game-preview-anthropic-2026-10-v7";

/** The slice of the SDK this provider uses — injectable so every stage is tested against a fake without a network. */
export type MessagesClient = Pick<Anthropic, "messages">;

/** Generous: research output (a list of facts with excerpts) and the model's own reasoning share this budget. Streaming is not needed at this size. */
const RESEARCH_MAX_TOKENS = 16000;
const STAGE_MAX_TOKENS = 8000;
/** A paused server-tool turn is resumed, but never without limit. */
const MAX_PAUSE_RESUMES = 4;

type Block = Anthropic.Messages.ContentBlock;

interface CallResult {
  text: string;
  blocks: Block[];
  usage: ProviderUsage;
  stopReason: string | null;
}

/** An API failure becomes a plain error: status and the API's own message, never request headers or the key. */
function toError(error: unknown): Error {
  if (error instanceof Anthropic.APIError) return new Error(`anthropic_api_${error.status ?? "error"}: ${(error.message ?? "").slice(0, 300)}`);
  return error instanceof Error ? error : new Error(String(error));
}

async function call(client: MessagesClient, params: Omit<Anthropic.Messages.MessageCreateParamsNonStreaming, "stream">, countsSearch: boolean): Promise<CallResult> {
  const messages: Anthropic.Messages.MessageParam[] = [...params.messages];
  let usage = emptyUsage();
  const blocks: Block[] = [];
  let last: Anthropic.Messages.Message | null = null;
  for (let resumes = 0; ; resumes++) {
    let response: Anthropic.Messages.Message;
    try {
      response = (await client.messages.create({ ...params, messages })) as Anthropic.Messages.Message;
    } catch (error) {
      throw toError(error);
    }
    last = response;
    blocks.push(...response.content);
    const searched = countsSearch ? (response.usage.server_tool_use?.web_search_requests ?? response.content.filter((b) => b.type === "server_tool_use" && b.name === "web_search").length) : 0;
    usage = addUsage(usage, { searchCalls: searched, modelCalls: 1, inputTokens: response.usage.input_tokens ?? 0, outputTokens: response.usage.output_tokens ?? 0 });
    if (response.stop_reason === "pause_turn") {
      if (resumes >= MAX_PAUSE_RESUMES) throw new Error("anthropic_pause_limit: the search kept pausing");
      messages.push({ role: "assistant", content: response.content as Anthropic.Messages.ContentBlockParam[] });
      continue;
    }
    break;
  }
  if (last.stop_reason === "refusal") throw new Error("anthropic_refusal: the model declined this request");
  if (last.stop_reason === "max_tokens") throw new Error("anthropic_max_tokens: the answer was cut off");
  const text = last.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { text, blocks, usage, stopReason: last.stop_reason };
}

/** The first balanced JSON object in a model answer (models sometimes wrap it in prose or a code fence, or follow it with commentary containing braces). */
export function extractJson<T>(text: string, what: string): T {
  const start = text.indexOf("{");
  if (start === -1) throw new Error(`The ${what} answer contained no JSON. It began: ${text.slice(0, 160).replace(/\s+/g, " ")}`);
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
  throw new Error(`The ${what} answer was not valid JSON. It began: ${text.slice(start, start + 160).replace(/\s+/g, " ")}`);
}

const normUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
};

function describeGame(game: GameIdentity): string {
  return `Sport: ${game.sport}${game.competition ? ` (${game.competition})` : ""}\nMatchup: ${game.awayTeam} at ${game.homeTeam}\nScheduled start (UTC): ${game.kickoffUtc}\nToday (UTC): ${game.asOf}`;
}


const str = { type: "string" } as const;
const strList = { type: "array", items: str } as const;

/** The stages that do not search ask the API for schema-guaranteed JSON (structured outputs), so an answer is always parseable; the research stage cannot (it carries web-search results) and is parsed from the prompt-requested JSON. */
const ANGLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["angles", "selected_id", "selection_reason", "rejected"],
  properties: {
    angles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "summary", "fact_ids", "scores", "note"],
        properties: {
          id: str,
          type: str,
          summary: str,
          fact_ids: strList,
          scores: {
            type: "object",
            additionalProperties: false,
            required: ["tension", "surprise", "specificity", "humanInterest", "conversation", "recency"],
            properties: { tension: { type: "number" }, surprise: { type: "number" }, specificity: { type: "number" }, humanInterest: { type: "number" }, conversation: { type: "number" }, recency: { type: "number" } },
          },
          note: str,
        },
      },
    },
    selected_id: str,
    selection_reason: str,
    rejected: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "reason"], properties: { id: str, reason: str } } },
  },
} as const;

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hook", "preview", "claims"],
  properties: { hook: str, preview: str, claims: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "fact_ids"], properties: { text: str, fact_ids: strList } } } },
} as const;

const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["supported", "editorial_passes", "problems"],
  properties: { supported: { type: "boolean" }, editorial_passes: { type: "boolean" }, problems: strList },
} as const;

const structured = (effort: string, schema: object) => ({ effort: effort as "low" | "medium" | "high" | "xhigh" | "max", format: { type: "json_schema" as const, schema: schema as Record<string, unknown> } });

const outputConfig = (effort: string) => ({ effort: effort as "low" | "medium" | "high" | "xhigh" | "max" });

/** The editorial standard, shared by the angle, writing and verification stages. */
const EDITORIAL_BRIEF = [
  "Your job is to find the most interesting TRUE story around this specific matchup — a tension, a conflict, a curiosity — and use only the facts that story needs. A Game Preview is a story hook, not a miniature game-notes page. It should feel like a sharp human sports editor found the one thing worth knowing about the game.",
  "Good stories: a streak on the line, a player on a run, revenge or unfinished business, a record chase, a historical oddity, a comeback or collapse, a breakout, a major injury or return, an old-team/new-team twist, a contrast between a hot and a cold team, matchup-specific dominance, a milestone, a weird statistic.",
  "CURRENT SEASON vs HISTORY. Current-game context is THIS season only: team record, standings, streaks, recent form, player form, injuries, availability, scoring and defensive trends, milestones, and this season's meetings. Never present a previous season's performance as current form. Earlier seasons are HISTORICAL CONTEXT: head-to-head and rivalry history, prior playoff meetings, franchise records, historical streaks, \"first time since\" facts, long-term milestones, unusual fun facts, and earlier events that directly explain this matchup. Priority: 1) a story built on this season; 2) a this-season story sharpened by historical context; 3) history as the main angle only when this season offers nothing strong, and then only if it is clearly framed as history and directly relevant. Do not mix seasons ambiguously. GOOD: \"The Chargers swept Kansas City last season, snapping a six-game Chiefs streak in the series.\" BAD: \"The Chargers are on a two-game winning streak against Kansas City\" when both wins came last season.",
  "Season records, standings, last-game scores and generic head-to-head history are FALLBACK material: context that can support a stronger story, rarely the story itself. Never choose \"Team A is 4-1 and Team B is 1-4\" if something more interesting exists. \"Both teams are looking for a win\", \"this should be an exciting matchup\" and schedule summaries are filler.",
].join("\n");

/** Illustrations of tone and of story selection. Never reuse their facts for another Game. */
const STYLE_EXAMPLES = [
  'Tone examples (style only — never reuse their facts):',
  'Hook: "Seven goals. Your move, Washington." Preview: "The Devils crushed the Rangers 7-1. Today, they chase a third straight win against the Capitals. Who takes it?"',
  'Hook: "Can the Jets ground this storm?" Preview: "Six straight wins. Carolina rolls into Winnipeg chasing No. 7 today. Are the Jets stopping the streak or becoming its next victim?"',
  'Hook: "Two games. Six goals. Seattle, you\'re next." Preview: "Brady Tkachuk enters today\'s matchup with back-to-back natural hat tricks. Against Vancouver, he scored all three Florida goals, including the overtime winner, to turn a 2-0 deficit into a 3-2 win. But Seattle has earned points in five straight meetings with the Panthers (3-0-2). Can the Kraken cool him off, or is another hat trick coming?"',
  "Story selection, from the SAME facts: weak = Hook \"Houston has its first win. Jacksonville has three straight.\" (records recited like game notes). Better = Hook \"Houston finally won. Jacksonville wants to make it a one-week story.\" — the same facts, but built around one tension. The improvement comes from choosing and shaping the story, never from adding facts.",
].join("\n");

const RESEARCH_SCHEMA_TEXT =
  'Return ONLY a JSON object: {"facts":[{"kind":"current"|"historical","season_scope":"CURRENT_SEASON"|"HISTORICAL_CONTEXT","category":"streak|milestone|head_to_head|player_form|injury|record|result|rivalry|context|other","claim":"one statement a single source directly supports","excerpt":"the passage of the source that supports it","source_url":"...","source_provider":"...","source_title":"...","published_at":"ISO date or null","relevance":0-1,"game_association":"how it ties to this exact game"}]}';

export class AnthropicGamePreviewProvider implements GamePreviewResearchProvider, GamePreviewAngleProvider, GamePreviewWriterProvider, GamePreviewVerifierProvider {
  readonly name = "anthropic";
  constructor(private readonly client: MessagesClient) {}

  async research(game: GameIdentity, ctx: ResearchContext): Promise<ResearchResult> {
    const system = [
      "You research one specific upcoming game for a sports app and return VERIFIED FACTS only. You must use web search; never answer from memory.",
      "Search specifically for this exact matchup: both teams, the date of the game, each team's recent results, meaningful player or team news, injuries and returns, streaks, milestones, record chases, head-to-head history, unusual statistics, rookie, coaching or old-team stories, revenge or rivalry context, dramatic recent performances. You do not need every category; you are looking for the strongest TRUE story.",
      "Prefer, in order: the official league, the official team, ESPN and other major established sports reporting, established local or beat reporting, trusted statistics providers. Never use content farms, social-media posts, forums or rumors as sources.",
      ctx.preferredDomains.length ? `Preferred domains: ${ctx.preferredDomains.join(", ")}.` : "",
      ctx.blockedDomains.length ? `Never use these domains: ${ctx.blockedDomains.join(", ")}.` : "",
      'Each fact is ONE statement a single page directly supports, with the supporting passage. kind="current" is ONLY for things that can change before the game and are reported as of the source\'s date (injuries, returns, availability, who is expected to start) AND league standings of any kind — \"leads the league in\", \"tied for the most\", \"ranks 29th\", \"last unbeaten team\", \"first in the division\" — because another team\'s game changes them (give those the source\'s date). For any streak or count of games ("N straight games", "in N consecutive"), check the game log and say in the claim whether the run is entirely this season or reaches into last season (for example "six straight games, five this season and one last season"); if you cannot tell, do not mention a season in the claim and label it HISTORICAL_CONTEXT. Separately, set season_scope for every fact: CURRENT_SEASON only for this season\'s record, standing, streak, form, injury, availability, trend, milestone or meeting; HISTORICAL_CONTEXT for anything from an earlier season or a long-run frame (head-to-head history, rivalry, prior playoff meetings, franchise records, "first time since"). A storyline created by this season\'s events — a new coach facing his old team for the first time, a player facing his former club, a return from injury — is CURRENT_SEASON even though it mentions the past; label HISTORICAL_CONTEXT only a fact that itself comes from an earlier season. Look first for current-season story material (this season\'s form, injuries and availability, streaks, milestones); collect historical context to support or sharpen it. Everything that follows from completed games — results, scores, records, streaks, standings after a game, head-to-head, milestones already reached — is kind="historical". For a current fact you MUST give the source\'s real publication date (as the page or search result shows it); if the page shows no date, do not report that fact at all — an undated "current" statement cannot be used.',
      "Team attribution is where research goes wrong: an injury report or preview page often lists BOTH teams. Every fact that names a player, coach or injury must name that person\'s own team, taken from the page\'s own heading, roster or list for that team — never inferred from the matchup. If the page does not make the team unambiguous, omit the fact. Only report what a page you actually retrieved says. If you cannot find something, omit it. Do not infer, estimate or round. Rate relevance by how interesting and specific the fact is for THIS matchup; collect the story-bearing facts, and include a bare record only as supporting context.",
      EDITORIAL_BRIEF,
      RESEARCH_SCHEMA_TEXT,
    ]
      .filter(Boolean)
      .join("\n\n");
    const tool: Record<string, unknown> = { type: ctx.webSearchToolVersion, name: "web_search", max_uses: ctx.maxSearchCalls };
    if (ctx.blockedDomains.length) tool.blocked_domains = ctx.blockedDomains;
    const result = await call(
      this.client,
      { model: ctx.model, max_tokens: RESEARCH_MAX_TOKENS, system, output_config: outputConfig(ctx.effort), tools: [tool as unknown as Anthropic.Messages.ToolUnion], messages: [{ role: "user", content: `Research this game and return the facts.\n${describeGame(game)}` }] },
      true,
    );

    // What the search actually reached: every result page, plus every page the model cited.
    const reached = new Map<string, { url: string; title: string; pageAge: string | null }>();
    for (const block of result.blocks) {
      if (block.type === "web_search_tool_result") {
        if (Array.isArray(block.content)) for (const r of block.content) reached.set(normUrl(r.url), { url: r.url, title: r.title, pageAge: r.page_age });
        else if (!reached.size) throw new Error(`anthropic_web_search_error: ${(block.content as { error_code?: string }).error_code ?? "unknown"}`);
      }
      if (block.type === "text") for (const c of block.citations ?? []) if (c.type === "web_search_result_location" && !reached.has(normUrl(c.url))) reached.set(normUrl(c.url), { url: c.url, title: c.title ?? c.url, pageAge: null });
    }

    const parsed = extractJson<{ facts?: Array<Record<string, unknown>> }>(result.text, "research");
    const facts: CandidateFact[] = [];
    const usedUrls = new Set<string>();
    const rejectedReasons = new Map<string, { url: string; reason: string }>();
    for (const raw of parsed.facts ?? []) {
      const url = String(raw.source_url ?? "");
      const key = normUrl(url);
      const claim = String(raw.claim ?? "").trim();
      if (!claim || !url) continue;
      const hit = reached.get(key);
      if (!hit) {
        rejectedReasons.set(key, { url, reason: "cited by the model but never reached by the search" });
        continue;
      }
      if (domainMatches(domainOf(url), ctx.blockedDomains)) {
        rejectedReasons.set(key, { url, reason: "blocked domain" });
        continue;
      }
      const published = raw.published_at ? new Date(String(raw.published_at)) : hit.pageAge ? new Date(hit.pageAge) : null;
      facts.push({
        id: `f${facts.length + 1}`,
        kind: raw.kind === "current" ? "current" : "historical",
        seasonScope: raw.kind === "current" || raw.season_scope === "CURRENT_SEASON" ? "CURRENT_SEASON" : "HISTORICAL_CONTEXT", // unknown stays history: it must be framed as such, never passed off as current form
        category: String(raw.category ?? "other").slice(0, 40),
        claim,
        excerpt: raw.excerpt ? String(raw.excerpt).trim().slice(0, 1000) : null,
        sourceUrl: hit.url,
        sourceProvider: String(raw.source_provider ?? "").trim() || domainOf(hit.url),
        sourceTitle: String(raw.source_title ?? "").trim() || hit.title,
        publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
        retrievedAt: game.asOf,
        relevance: Math.max(0, Math.min(1, Number(raw.relevance) || 0)),
        gameAssociation: String(raw.game_association ?? "").trim(),
      });
      usedUrls.add(key);
    }
    const sources: ReachedSource[] = [...reached.entries()].map(([key, r]) => (usedUrls.has(key) ? { url: r.url, title: r.title, status: "accepted" as const } : { url: r.url, title: r.title, status: "rejected" as const, reason: rejectedReasons.get(key)?.reason ?? "no usable fact taken from it" }));
    for (const [key, r] of rejectedReasons) if (!reached.has(key)) sources.push({ url: r.url, title: r.url, status: "rejected", reason: r.reason });
    return { facts, sources, usage: result.usage };
  }

  async selectAngle(game: GameIdentity, facts: CandidateFact[], ctx: StageContext): Promise<AngleSelection> {
    const system = [
      EDITORIAL_BRIEF,
      `Before anything is written, propose 3 to 5 candidate editorial angles from the verified facts only. Angle types (internal vocabulary): ${ANGLE_TYPES.join(", ")}. Use SEASON_RECORD only for a records-and-standings angle.`,
      "Score each angle 1-5 on: tension (does something meaningful collide?), surprise (would a fan find it unexpected?), specificity (could it only belong to this matchup?), humanInterest (a player, coach, streak, comeback or emotion?), conversation (does it make someone want to take a side?), recency (is it relevant right now?). Penalize heavily simple records, standings, last-game recaps with no larger story, generic head-to-head, and schedule summaries. Choose the strongest overall angle; use editorial judgement, not just the arithmetic. One Game, one story. Build the primary angle on facts whose season_scope is CURRENT_SEASON; HISTORICAL_CONTEXT facts support or sharpen it, and a story resting only on history is a fallback for a Game whose season offers nothing strong.",
      'Each angle lists the fact ids it needs (only those; fewer is better). The one-sentence summary may contain a number, score or record ONLY if a fact in that angle\'s fact_ids holds it — list every fact behind every figure and name in the summary. Return ONLY a JSON object: {"angles":[{"id":"a1","type":"...","summary":"the story in one plain sentence","fact_ids":["f1"],"scores":{"tension":1-5,"surprise":1-5,"specificity":1-5,"humanInterest":1-5,"conversation":1-5,"recency":1-5},"note":"why it is or is not worth a Member\'s time"}],"selected_id":"a1","selection_reason":"why this one","rejected":[{"id":"a2","reason":"..."}]}',
    ].join("\n\n");
    const material = facts.map((f) => ({ id: f.id, season_scope: f.seasonScope, kind: f.kind, category: f.category, claim: f.claim, excerpt: f.excerpt, published_at: f.publishedAt, relevance: f.relevance, association: f.gameAssociation }));
    const result = await call(this.client, { model: ctx.model, max_tokens: STAGE_MAX_TOKENS, system, output_config: structured(ctx.effort, ANGLE_SCHEMA), messages: [{ role: "user", content: `${describeGame(game)}\n\nVerified facts (the only material you may use):\n${JSON.stringify(material)}` }] }, false);
    const parsed = extractJson<{ angles?: Array<Record<string, unknown>>; selected_id?: string; selection_reason?: string; rejected?: Array<{ id?: string; reason?: string }> }>(result.text, "angle");
    const angles: EditorialAngle[] = (parsed.angles ?? []).map((a) => {
      const s = (a.scores ?? {}) as Record<string, unknown>;
      return {
        id: String(a.id ?? ""),
        type: String(a.type ?? "") as AngleType,
        summary: String(a.summary ?? "").trim(),
        factIds: Array.isArray(a.fact_ids) ? a.fact_ids.map(String) : [],
        scores: { tension: Number(s.tension), surprise: Number(s.surprise), specificity: Number(s.specificity), humanInterest: Number(s.humanInterest), conversation: Number(s.conversation), recency: Number(s.recency) },
        note: String(a.note ?? "").trim(),
      };
    });
    return {
      angles,
      selectedId: String(parsed.selected_id ?? ""),
      selectionReason: String(parsed.selection_reason ?? "").trim(),
      rejected: (parsed.rejected ?? []).map((r) => ({ id: String(r.id ?? ""), reason: String(r.reason ?? "") })),
      usage: result.usage,
    };
  }

  async write(game: GameIdentity, angle: EditorialAngle, facts: CandidateFact[], ctx: DraftContext): Promise<PreviewDraft> {
    const system = [
      EDITORIAL_BRIEF,
      `Write the Game Preview for the CHOSEN story below, using ONLY the facts provided (they are the facts this story needs) — and never anything from memory. Every figure, result, name, streak or claim must come from them; the one-line story below is only the theme — take no figure from it, only from the facts. If a provided fact does not strengthen the story, leave it out: three excellent facts beat eight mediocre ones, and at most ${ctx.maxCitedFacts} may be cited.`,
      "Given, not researched: who plays whom and which team is the home team (\"Away at Home\"). Not given: the venue's name, the time of day, the weather, the crowd. Name a venue only as part of a fact that states it; never write \"tonight\", \"this afternoon\" or any time of day (say \"today\" or nothing); never add a time frame the facts do not state — a streak or count of games may reach into last season, so \"this season\" or \"this year\" appears only if a fact says it; never attribute wants, feelings, motives or intentions (\"wants that loss back\", \"is determined\") unless a fact says so — let the facts imply the tension.",
      "Structure: open with the central story; support it with 1-3 verified facts; connect them directly to today's matchup; end with tension or an implication when useful. Do not chronologically dump facts. One story only.",
      `Hook (at most ${ctx.hookMaxChars} characters): would it make someone stop scrolling if they already knew the two teams were playing? If not, find another way into the same story. It should feel like sports conversation — a challenge, a contrast, an understatement, an implication, a short dramatic statement, a question or direct address — never like ESPN metadata, an SEO headline, a sportsbook headline or a press release. Do not put a record or score in the hook.`,
      `Preview (at most ${ctx.maxChars} characters; shorter is better, never pad): specific enough that changing the team names could not reuse it for another game; it should make a reader want an opinion. Do NOT force a question: use one only if it sharpens this story's tension, and never end with "Who will win?" or "Can they do it?". Plain text; no emoji, no hashtags, no betting language (no odds, spreads, favorites, picks).`,
      "Seasons: lead with CURRENT_SEASON facts. A HISTORICAL_CONTEXT fact is framed explicitly as history (\"last season\", \"in 2025\", \"the last time\", \"in the series\") and never as current form, a current streak or this season's trend; never blur the two in one sentence. A claim that rests only on HISTORICAL_CONTEXT facts must say it is history.",
      "A fact flagged kind=current may be stated as current only because its source is recent; a historical fact is stated as what happened (\"after a 26-3 loss\"), never as an ongoing condition. Do not describe an old injury or roster state as current.",
      STYLE_EXAMPLES,
      'Also return `claims`: every material statement you made that rests on a fact, each with the ids of the facts that support it (never an empty list; the matchup itself — who plays whom, where, today — is given and is not a claim). Return ONLY a JSON object: {"hook":"...","preview":"...","claims":[{"text":"...","fact_ids":["f1"]}]}',
    ].join("\n\n");
    const used = facts.filter((f) => angle.factIds.includes(f.id)).map((f) => ({ id: f.id, season_scope: f.seasonScope, kind: f.kind, category: f.category, claim: f.claim, excerpt: f.excerpt, published_at: f.publishedAt }));
    const feedback = ctx.feedback.length ? `\n\nYour previous draft was rejected for these reasons. Fix every one:\n- ${ctx.feedback.join("\n- ")}` : "";
    const result = await call(this.client, { model: ctx.model, max_tokens: STAGE_MAX_TOKENS, system, output_config: structured(ctx.effort, DRAFT_SCHEMA), messages: [{ role: "user", content: `${describeGame(game)}\n\nChosen story: ${angle.summary}\n\nFacts for this story:\n${JSON.stringify(used)}${feedback}` }] }, false);
    const parsed = extractJson<{ hook?: string; preview?: string; claims?: Array<{ text?: string; fact_ids?: string[] }> }>(result.text, "writer");
    const claims: GamePreviewClaim[] = (parsed.claims ?? []).map((c) => ({ text: String(c.text ?? ""), factIds: Array.isArray(c.fact_ids) ? c.fact_ids.map(String) : [] }));
    return { hook: String(parsed.hook ?? ""), preview: String(parsed.preview ?? ""), claims, promptVersion: PREVIEW_PROMPT_VERSION, usage: result.usage };
  }

  async verify(game: GameIdentity, angle: EditorialAngle, draft: Pick<PreviewDraft, "hook" | "preview" | "claims">, facts: CandidateFact[], ctx: StageContext): Promise<VerificationResult> {
    const byId = new Map(facts.map((f) => [f.id, f]));
    const material = [...new Set(draft.claims.flatMap((c) => c.factIds))].map((id) => byId.get(id)).filter((f): f is CandidateFact => Boolean(f)).map((f) => ({ id: f.id, season_scope: f.seasonScope, kind: f.kind, claim: f.claim, excerpt: f.excerpt, published_at: f.publishedAt }));
    const system = [
      "You are a strict fact-checker AND a sports editor. Given a game preview and the only facts it may rest on, judge two things independently, without outside knowledge. The matchup in the message is GIVEN and counts as supported: which two teams play, which is the home team (\"Away at Home\"), and that the game is today/upcoming. Nothing else about the venue, time of day, weather or crowd is given.",
      "0) attribution: for every player, coach or injury the preview names, check the fact\'s claim AGAINST ITS OWN EXCERPT: the excerpt must show that person on the team the preview says (a player on one team\'s injury report is not the other team\'s). Flag any person attributed to a team the excerpt does not support. 1) supported: is EVERY factual statement in the hook and the preview directly supported by those facts? Flag any statement, number, name or implication the facts do not support, any current-state wording resting on a historical fact, anything that goes beyond the facts, any time frame the facts do not state (a streak or count of games may reach into the previous season, so \"this season\" or \"this year\" needs a fact that says it), and any statement resting on a HISTORICAL_CONTEXT fact that is not clearly framed as history or could be read as this season's form (mixing seasons ambiguously).",
      `2) editorial: does it tell ONE specific story (${angle.summary})? Would the hook stop the scroll for someone who already knew the teams were playing? Could the preview be reused for another matchup by swapping team names (if so it fails)? Does it read like a sharp editor and not like automated game notes, a list of statistics, or sportsbook copy? Does it make a reader want an opinion?`,
      'Return ONLY a JSON object: {"supported":true|false,"editorial_passes":true|false,"problems":["each specific problem, empty if none"]}',
    ].join("\n\n");
    const result = await call(this.client, { model: ctx.model, max_tokens: STAGE_MAX_TOKENS, system, output_config: structured(ctx.effort, VERIFY_SCHEMA), messages: [{ role: "user", content: `${describeGame(game)}\n\nHook: ${draft.hook}\nPreview: ${draft.preview}\n\nFacts:\n${JSON.stringify(material)}` }] }, false);
    const parsed = extractJson<{ supported?: boolean; editorial_passes?: boolean; problems?: string[] }>(result.text, "verifier");
    const problems = (parsed.problems ?? []).map(String);
    return { supported: parsed.supported === true, editorialPasses: parsed.editorial_passes === true, problems, usage: result.usage };
  }
}
