"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/messaging/share";
import { runGamePreviewGenerationFor } from "@/lib/game-previews/automation";
import { adminGenerationReason, getGamePreviewAdminState } from "@/lib/game-previews/repository";

export interface GamePreviewAdminResult {
  success: boolean;
  error: string | null;
  message?: string;
}

const fail = (error: string): GamePreviewAdminResult => ({ success: false, error });

const NUMBER_FIELDS = [
  ["max_chars", "Preview length (characters)", 100, 2000],
  ["hook_max_chars", "Hook length (characters)", 20, 300],
  ["lead_hours", "Prepare a Game this many hours before kickoff", 1, 720],
  ["stale_after_hours", "Stale after (hours)", 1, 720],
  ["min_refresh_interval_hours", "Minimum hours between refreshes", 0, 720],
  ["max_attempts", "Writing attempts per Game", 1, 5],
  ["max_games_per_run", "Games per scheduled run", 1, 50],
  ["max_search_calls_per_game", "Web searches per Game", 1, 50],
  ["current_fact_max_age_hours", "How recent a 'current' source must be (hours)", 1, 8760],
  ["max_cited_facts", "Most facts one Preview may cite", 1, 10],
  ["automation_retry_hours", "Hours before a needs-review Game is retried automatically", 1, 720],
  ["automation_technical_retry_hours", "Hours before a technical failure is retried automatically", 1, 720],
  ["status_refresh_window_hours", "Refresh a status-bearing Preview when the Game is within (hours)", 1, 168],
] as const;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const TOOL_VERSIONS = ["web_search_20250305", "web_search_20260209", "web_search_20260318"];

const domains = (raw: FormDataEntryValue | null) =>
  String(raw ?? "")
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);

/** Super Admin: the Game Preview limits, timings and generation settings in one audited call. Validated as a whole; nothing is partially applied. The API key is never a setting: it comes from the environment. */
export async function setGamePreviewConfigAction(_prev: GamePreviewAdminResult | null, formData: FormData): Promise<GamePreviewAdminResult> {
  const admin = await requireSuperAdmin();
  const config: Record<string, unknown> = {};
  for (const [key, label, min, max] of NUMBER_FIELDS) {
    const raw = String(formData.get(key) ?? "").trim();
    const value = raw === "" ? NaN : Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) return fail(`${label} must be a whole number from ${min} to ${max}.`);
    config[key] = value;
  }
  const provider = String(formData.get("provider") ?? "anthropic");
  if (provider !== "anthropic") return fail("That provider isn't available.");
  const effort = String(formData.get("effort") ?? "medium");
  if (!EFFORTS.includes(effort)) return fail("Choose an effort level from the list.");
  const toolVersion = String(formData.get("web_search_tool_version") ?? "");
  if (!TOOL_VERSIONS.includes(toolVersion)) return fail("Choose a web search version from the list.");
  const minStory = Number(String(formData.get("min_story_score") ?? "").trim());
  if (!Number.isFinite(minStory) || minStory < 1 || minStory > 5) return fail("The minimum story score must be a number from 1 to 5.");
  const model = String(formData.get("model") ?? "").trim();
  if (model.length > 100) return fail("The model name is too long.");
  config.provider = provider;
  config.model = model;
  config.effort = effort;
  config.web_search_tool_version = toolVersion;
  config.min_story_score = minStory;
  config.generation_enabled = formData.get("generation_enabled") === "on";
  config.web_search_enabled = formData.get("web_search_enabled") === "on";
  config.verify_with_model = formData.get("verify_with_model") === "on";
  config.status_refresh_enabled = formData.get("status_refresh_enabled") === "on";
  config.automation_competitions = domains(formData.get("automation_competitions")).map((c) => c.toUpperCase());
  if (config.generation_enabled && !model) return fail("Set a model before turning automatic generation on.");
  config.preferred_domains = domains(formData.get("preferred_domains"));
  config.blocked_domains = domains(formData.get("blocked_domains"));
  const { error } = await createAdminClient().rpc("admin_set_game_preview_config", { p_admin_id: admin.id, p_config: config });
  if (error) return fail("Couldn't save the Game Preview settings.");
  revalidatePath("/admin/game-previews");
  return { success: true, error: null, message: "Saved." };
}

/**
 * Super Admin: research and write a Preview for one Game now (the first one, or a regeneration). Allowed whether or not automatic generation is on. It runs the same pipeline the scheduled job would — web research,
 * validation, verification, provenance — and never touches a Game that has started. The result says plainly what happened.
 */
export async function generateGamePreviewAction(_prev: GamePreviewAdminResult | null, formData: FormData): Promise<GamePreviewAdminResult> {
  const admin = await requireSuperAdmin(); // the actor comes from the authenticated server session, never from the form
  const fixtureId = String(formData.get("fixture_id") ?? "");
  if (!isUuid(fixtureId)) return fail("That Game wasn't found.");
  // The reason comes from the canonical STORED state, not the public getter (which hides a Preview whose credit is no longer eligible): a hidden Preview is regenerated, never re-inserted.
  const state = await getGamePreviewAdminState(fixtureId);
  const result = await runGamePreviewGenerationFor(fixtureId, adminGenerationReason(state), "ADMIN", admin.id);
  revalidatePath("/admin/game-previews");
  revalidatePath("/feed");
  if (!result.configured) return fail(result.error);
  // A scheduled (or another Admin) run is generating this Game right now: the two never race. Try again once it has finished.
  if ("busy" in result) return fail("A Preview is already being generated for this Game. Try again in a few minutes.");
  const o = result.outcome;
  if (o.status === "SUCCEEDED") return { success: true, error: null, message: `Saved: “${o.hook}” (${o.usage.searchCalls} searches, ${o.usage.modelCalls} model calls).` };
  const detail = o.problems.length ? ` ${o.problems.slice(0, 3).join(" ")}` : "";
  return fail(`${o.status === "REJECTED" ? "The draft was rejected and nothing was saved." : "It didn't complete and nothing was saved."} (${o.error})${detail}`);
}

/** Super Admin: edit a Preview's hook and story by hand (the sources stay as they are). Needs a note; audited; refused once the Game has started. */
export async function editGamePreviewAction(_prev: GamePreviewAdminResult | null, formData: FormData): Promise<GamePreviewAdminResult> {
  const admin = await requireSuperAdmin();
  const fixtureId = String(formData.get("fixture_id") ?? "");
  const hook = String(formData.get("hook") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  if (!isUuid(fixtureId)) return fail("That Game wasn't found.");
  if (!hook || !body) return fail("The hook and the story can't be empty.");
  if (note.length < 3 || note.length > 500) return fail("Say what you changed and why (3 to 500 characters).");
  const { data, error } = await createAdminClient().rpc("admin_edit_game_preview", { p_admin_id: admin.id, p_fixture_id: fixtureId, p_hook: hook, p_body: body, p_note: note });
  if (error) return fail("Couldn't save the edit.");
  const outcome = (data as { outcome?: string; max?: number } | null)?.outcome;
  if (outcome === "hook_too_long") return fail("The hook is longer than the configured limit.");
  if (outcome === "body_too_long") return fail("The story is longer than the configured limit.");
  if (outcome === "game_started") return fail("This Game has started, so its Preview is frozen.");
  if (outcome !== "edited") return fail("That Game has no Preview to edit.");
  revalidatePath("/admin/game-previews");
  revalidatePath("/feed");
  return { success: true, error: null, message: "Saved." };
}

/** Super Admin: take a Preview that turned out to be wrong off the Post. A reason is required and the action is audited; the text and its sources stay on record. */
export async function withdrawGamePreviewAction(_prev: GamePreviewAdminResult | null, formData: FormData): Promise<GamePreviewAdminResult> {
  const admin = await requireSuperAdmin();
  const fixtureId = String(formData.get("fixture_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(fixtureId)) return fail("That Game wasn't found.");
  if (reason.length < 3 || reason.length > 500) return fail("Say why it is being withdrawn (3 to 500 characters).");
  const { data, error } = await createAdminClient().rpc("admin_withdraw_game_preview", { p_admin_id: admin.id, p_fixture_id: fixtureId, p_reason: reason });
  if (error) return fail("Couldn't withdraw the Preview.");
  if ((data as { outcome?: string } | null)?.outcome !== "withdrawn") return fail("That Game has no Preview.");
  revalidatePath("/admin/game-previews");
  revalidatePath("/feed");
  return { success: true, error: null, message: "Withdrawn. The Post no longer shows it." };
}
