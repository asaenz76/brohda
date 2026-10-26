"use server";

import { revalidatePath } from "next/cache";
import { requireAdminOrAbove, requireSuperAdmin } from "@/lib/auth/session";
import { isUuid } from "@/lib/messaging/share";
import { approveRevision, editRevision, rejectRevision, setStoryConfig, withdrawStory } from "@/lib/game-stories/repository";
import { generateStoryForFixture, reverifyRevision } from "@/lib/game-stories/service";

export interface GameStoryAdminResult {
  success: boolean;
  error: string | null;
  message?: string;
}
const fail = (error: string): GameStoryAdminResult => ({ success: false, error });
const ok = (message: string): GameStoryAdminResult => ({ success: true, error: null, message });
const done = () => revalidatePath("/admin/game-stories");

/** Database exceptions are stable codes; show the Admin what they mean. */
const EXPLAIN: Record<string, string> = {
  not_authorized: "You are not allowed to do that.",
  revision_not_found: "That story revision no longer exists.",
  revision_not_reviewable: "That revision is not waiting for review (it may already be decided).",
  revision_not_editable: "Only a revision waiting for review, or the live one, can be edited.",
  verification_required: "This revision was edited by hand: re-verify its facts before approving it.",
  unsupported_claims: "At least one claim is not supported by the evidence, so it cannot be approved.",
  no_claims: "This revision has no verified claims, so it cannot be approved.",
  post_not_found: "The Game has no Post.",
  game_already_started: "This Game has already started: pregame stories are not published or replaced after kickoff.",
  revision_not_awaiting_verification: "That revision is not waiting to be re-verified.",
};
const explain = (message: string): string => {
  if (message.startsWith("game_story_over_length")) return `The story is over the configured length (${message.replace("game_story_over_length: ", "")}).`;
  const code = Object.keys(EXPLAIN).find((c) => message.includes(c));
  return code ? EXPLAIN[code] : "That did not work. Try again, and check the run for details.";
};

export async function generateStoryAction(_prev: GameStoryAdminResult | null, formData: FormData): Promise<GameStoryAdminResult> {
  const admin = await requireAdminOrAbove();
  const fixtureId = String(formData.get("fixtureId") ?? "");
  if (!isUuid(fixtureId)) return fail("Choose a Game.");
  const regenerate = formData.get("regenerate") === "1";
  const result = await generateStoryForFixture({ fixtureId, trigger: regenerate ? "REGENERATE" : "ADMIN", adminId: admin.id });
  done();
  switch (result.outcome) {
    case "disabled": return fail("Story generation is off. Turn it on in the settings first.");
    case "not_eligible": return fail("This Game is not eligible (unsupported sport, already started, or no Post).");
    case "past_cutoff": return fail("This Game is too close to kickoff for a new story (editorial cutoff).");
    case "active_run_exists": return fail("A run for this Game is already in progress.");
    case "recently_researched":
    case "run_limit_reached": return fail("This Game was researched recently.");
    case "failed": return fail(`The run failed (${result.category}). The Game and its Picks are unaffected; try again later.`);
    case "completed":
      return result.decision === "ACCEPTED" ? ok(`A candidate scored ${result.total}/100 and is waiting for your review.`) : ok(result.decision === "NO_STORY" ? "No story: there was not enough verified material for an interesting angle." : `No story was published: ${result.rejectionCode ?? "rejected"}.`);
    default: return fail("That did not run.");
  }
}

export async function approveStoryAction(_prev: GameStoryAdminResult | null, formData: FormData): Promise<GameStoryAdminResult> {
  const admin = await requireAdminOrAbove();
  const revisionId = String(formData.get("revisionId") ?? "");
  if (!isUuid(revisionId)) return fail("Choose a revision.");
  const { data, error } = await approveRevision(admin.id, revisionId);
  if (error) return fail(explain(error.message));
  done();
  return ok(data === "already_approved" ? "That story was already approved." : "Approved. The story is now on the Game's Post.");
}

export async function rejectStoryAction(_prev: GameStoryAdminResult | null, formData: FormData): Promise<GameStoryAdminResult> {
  const admin = await requireAdminOrAbove();
  const revisionId = String(formData.get("revisionId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(revisionId)) return fail("Choose a revision.");
  if (reason.length < 3) return fail("Say why you are rejecting it (a few words).");
  const { error } = await rejectRevision(admin.id, revisionId, reason);
  if (error) return fail(explain(error.message));
  done();
  return ok("Rejected. The Post is unchanged.");
}

export async function editStoryAction(_prev: GameStoryAdminResult | null, formData: FormData): Promise<GameStoryAdminResult> {
  const admin = await requireAdminOrAbove();
  const revisionId = String(formData.get("revisionId") ?? "");
  const hook = String(formData.get("hook") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!isUuid(revisionId)) return fail("Choose a revision.");
  if (hook.length < 5 || body.length < 20) return fail("The hook and body are too short.");
  const { error } = await editRevision(admin.id, revisionId, hook, body);
  if (error) return fail(explain(error.message));
  done();
  return ok("Saved as a new revision. Its facts must be re-verified before it can be approved.");
}

export async function reverifyStoryAction(_prev: GameStoryAdminResult | null, formData: FormData): Promise<GameStoryAdminResult> {
  await requireAdminOrAbove();
  const revisionId = String(formData.get("revisionId") ?? "");
  if (!isUuid(revisionId)) return fail("Choose a revision.");
  try {
    const r = await reverifyRevision(revisionId);
    done();
    return r.result === "verified" ? ok("Every claim in the edited text is supported by the stored evidence. It can now be approved.") : fail(`The edited text is not supported by the stored evidence${r.detail ? `: ${r.detail}` : "."}`);
  } catch (e) {
    return fail(explain(e instanceof Error ? e.message : ""));
  }
}

export async function withdrawStoryAction(_prev: GameStoryAdminResult | null, formData: FormData): Promise<GameStoryAdminResult> {
  const admin = await requireAdminOrAbove();
  const fixtureId = String(formData.get("fixtureId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(fixtureId)) return fail("Choose a Game.");
  if (reason.length < 3) return fail("Say why you are taking the story down.");
  const { error } = await withdrawStory(admin.id, fixtureId, reason);
  if (error) return fail(explain(error.message));
  done();
  return ok("Withdrawn. The Post no longer shows a story.");
}

const NUMBER_FIELDS = [
  ["max_chars", "Story length (characters)", 100, 1000],
  ["min_score", "Minimum score to propose a story", 0, 100],
  ["research_window_hours", "Research a Game this many hours before kickoff", 1, 336],
  ["refresh_interval_minutes", "Minutes between researching the same Game", 15, 10080],
  ["editorial_cutoff_minutes", "No new story within this many minutes of kickoff", 0, 1440],
  ["max_queries_per_game", "Web searches per Game", 0, 30],
  ["max_sources", "Sources kept per Game", 1, 40],
  ["max_attempts", "Drafts per run", 1, 5],
  ["provider_retries", "Retries on a provider error", 0, 3],
  ["request_timeout_seconds", "Provider timeout (seconds)", 10, 290],
  ["max_games_per_run", "Games per scheduled run", 1, 20],
  ["max_runs_per_game", "Scheduled runs per Game", 1, 20],
  ["status_max_age_hours", "How fresh an injury/availability source must be (hours)", 1, 720],
  ["current_fact_max_age_hours", "How fresh a 'current' source must be (hours)", 1, 8760],
] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const TOOL_VERSIONS = ["web_search_20250305", "web_search_20260209", "web_search_20260318"];
const SPORTS = ["american_football", "basketball", "hockey", "baseball"];
const domains = (raw: FormDataEntryValue | null) => String(raw ?? "").split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean);

/** Super Admin: every story setting in one audited call, validated as a whole. The API key is never a setting; auto-publish cannot be turned on. */
export async function setStoryConfigAction(_prev: GameStoryAdminResult | null, formData: FormData): Promise<GameStoryAdminResult> {
  const admin = await requireSuperAdmin();
  const config: Record<string, unknown> = {};
  for (const [key, label, min, max] of NUMBER_FIELDS) {
    const raw = String(formData.get(key) ?? "").trim();
    const value = raw === "" ? NaN : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) return fail(`${label} must be a whole number from ${min} to ${max}.`);
    config[key] = value;
  }
  const effort = String(formData.get("effort") ?? "medium");
  const tool = String(formData.get("web_search_tool_version") ?? "");
  const model = String(formData.get("model") ?? "").trim();
  if (!EFFORTS.includes(effort)) return fail("Choose an effort level from the list.");
  if (!TOOL_VERSIONS.includes(tool)) return fail("Choose a web search version from the list.");
  if (!model || model.length > 100) return fail("Enter a model id (100 characters or fewer).");
  const sports = formData.getAll("supported_sports").map(String);
  if (!sports.every((s) => SPORTS.includes(s))) return fail("Choose sports from the list.");
  Object.assign(config, { effort, web_search_tool_version: tool, model, provider: "anthropic", supported_sports: sports, preferred_domains: domains(formData.get("preferred_domains")), blocked_domains: domains(formData.get("blocked_domains")), generation_enabled: formData.get("generation_enabled") === "on", web_search_enabled: formData.get("web_search_enabled") === "on" });
  const { error } = await setStoryConfig(admin.id, config);
  if (error) return fail(error.message.includes("auto_publish_locked") ? "Automatic publishing cannot be turned on." : "Those settings were not accepted.");
  done();
  return ok("Saved.");
}
