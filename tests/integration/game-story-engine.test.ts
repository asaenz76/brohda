/**
 * Game Story Engine (migration 216) against a real local Supabase: what the DATABASE enforces regardless of application code (defaults OFF, auto-publish locked, length, score arithmetic, accepted-only-if-supported,
 * one active run per Game, one approved story per Game, append-only history, audited approvals), who can touch any of it (nobody but the service role), the idempotency/concurrency guarantees (parallel starts, racing approvals),
 * and the pipeline end to end with fake providers: accepted → reviewed → approved onto the canonical Post, rejected → Post untouched, failed → the Game, its Market, Picks and comments untouched.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { resetIntegrationWorld } from "./helpers/isolation";
import { seedGame, seedPick, seedUser, setFixture } from "./helpers/game-seed";
import { generateStoryForFixture, runScheduledStories } from "@/lib/game-stories/service";
import { StoryProviderError } from "@/lib/game-stories/providers/anthropic";
import { getApprovedStoryForFixture } from "@/lib/game-stories/repository";
import { claim, fakeDeps, GOOD_SCORE } from "../support/game-stories";
import type { Draft, EvidenceItem } from "@/lib/game-stories/types";

const admin = getTestAdminClient();
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const PASSWORD = "integration-test-password-123";

const setConfig = async (values: Row) => {
  const { error } = await admin.from("game_story_config").update(values).eq("id", true);
  if (error) throw error;
};
const enable = (over: Row = {}) => setConfig({ generation_enabled: true, ...over });

async function makeAdmin(role = "admin"): Promise<string> {
  const id = await seedUser(`story-${role}`);
  await admin.from("user_profiles").update({ role }).eq("id", id);
  return id;
}
async function game(startsInMinutes = 24 * 60, over: Row = {}) {
  const g = await seedGame({ startsInMinutes, sport: "basketball", homeName: "Boston Celtics", awayName: "New York Knicks", ...over });
  const { data, error } = await admin.from("posts").insert({ fixture_id: g.fixtureId, published_at: new Date().toISOString() }).select("id").single();
  if (error) throw error;
  return { ...g, postId: data!.id as string };
}
const ev = (runId: string, fixtureId: string, over: Row = {}) => ({ id: randomUUID(), position: 0, source_kind: "STRUCTURED_DATA", authority: 95, canonical_id: `brohda:fixtures:${randomUUID()}`, url: null, publisher: "Brohda game data", title: "t", published_at: null, retrieved_at: new Date().toISOString(), evidence_type: "STRUCTURED", fact_key: null, fact_value: null, subject_team: "BOTH", fact_text: "Boston has won the last 3 meetings.", excerpt: null, as_of: null, status: "USABLE", status_reason: null, ...over });
/** A valid accepted payload: two usable evidence items, two SUPPORTED claims, dims totalling 87. */
function accepted(over: Row = {}) {
  const e1 = ev("", "");
  const e2 = ev("", "", { fact_text: "Boston has won 5 straight games." });
  const c = (text: string, evidence: string[], verdict = "SUPPORTED") => ({ id: randomUUID(), position: 0, text, type: "HISTORY", subject_team: "BOTH", availability_status: null, quote_text: null, verdict, deterministic_ok: true, model_verdict: "SUPPORTED", note: "ok", evidence_ids: evidence });
  return {
    decision: "ACCEPTED", rejection_code: null, rejection_detail: null, candidate_hook: "Five straight for Boston.", candidate_body: "Boston has won five straight and three meetings in a row against New York. Does it get a sixth?",
    dims: { relevance: 27, evidence: 23, debate: 17, originality: 13, freshness: 9 }, counters: { queries: 0, model_calls: 4, search_calls: 0, input_tokens: 1000, output_tokens: 500 }, elapsed_ms: 1234, prompt_version: "test", research_version: "test",
    details: {}, evidence: [e1, e2], claims: [c("Boston has won 3 meetings in a row", [e1.id]), c("Boston has won 5 straight games", [e2.id])],
    revision: { hook: "Five straight for Boston.", body: "Boston has won five straight and three meetings in a row against New York. Does it get a sixth?" }, ...over,
  } as Row;
}
const start = async (fixtureId: string, trigger = "SCHEDULED", adminId: string | null = null) => {
  const { data, error } = await admin.rpc("start_game_story_run", { p_fixture_id: fixtureId, p_trigger: trigger, p_admin_id: adminId });
  if (error) throw error;
  return (data as Row[])[0] as { run_id: string | null; outcome: string };
};
const save = (runId: string, payload: Row) => admin.rpc("save_game_story_run_result", { p_run_id: runId, p_payload: payload });
/** A run saved as ACCEPTED: returns the run id and its revision id. */
async function reviewable(fixtureId: string, adminId: string | null = null) {
  const s = await start(fixtureId, adminId ? "ADMIN" : "SCHEDULED", adminId);
  expect(s.outcome).toBe("started");
  const r = await save(s.run_id!, accepted());
  expect(r.error).toBeNull();
  const { data } = await admin.from("game_story_revisions").select("id").eq("run_id", s.run_id!).single();
  return { runId: s.run_id!, revisionId: data!.id as string };
}

let staff: string;
beforeEach(async () => {
  await resetIntegrationWorld();
  staff = await makeAdmin();
});
afterEach(async () => {
  await admin.from("user_profiles").update({ role: "player" }).eq("id", staff);
});

describe("shipped defaults and privileges (migration 216 alone starts nothing and publishes nothing)", () => {
  it("generation OFF, auto-publish OFF, 300 characters, 80 points, no run exists", async () => {
    const { data } = await admin.from("game_story_config").select("*").eq("id", true).single();
    expect(data).toMatchObject({ generation_enabled: false, auto_publish_enabled: false, max_chars: 300, min_score: 80, provider: "anthropic" });
    expect((await admin.from("game_story_runs").select("id", { count: "exact", head: true })).count).toBe(0);
  });
  it("auto-publish cannot be turned on: not through the Super Admin function and not by writing the row", async () => {
    const sa = await makeAdmin("super_admin");
    expect((await admin.rpc("admin_set_game_story_config", { p_admin_id: sa, p_config: { auto_publish_enabled: true } })).error?.message).toMatch(/auto_publish_locked/);
    expect((await admin.from("game_story_config").update({ auto_publish_enabled: true }).eq("id", true)).error?.message).toMatch(/game_story_auto_publish_locked/);
    await admin.from("user_profiles").update({ role: "player" }).eq("id", sa);
  });
  it("an Admin who is not a Super Admin cannot change the settings; a Super Admin can, and it is audited", async () => {
    expect((await admin.rpc("admin_set_game_story_config", { p_admin_id: staff, p_config: { max_chars: 250 } })).error?.message).toMatch(/not_authorized/);
    const sa = await makeAdmin("super_admin");
    const { data, error } = await admin.rpc("admin_set_game_story_config", { p_admin_id: sa, p_config: { max_chars: 250, min_score: 85 } });
    expect(error).toBeNull();
    expect(data).toMatchObject({ max_chars: 250, min_score: 85 });
    expect((await admin.rpc("admin_set_game_story_config", { p_admin_id: sa, p_config: { nope: 1 } })).error?.message).toMatch(/unknown_setting/);
    const { data: audit } = await admin.from("audit_logs").select("action").eq("actor_id", sa).eq("action", "game_story.config_updated");
    expect(audit).toHaveLength(1);
    await admin.from("user_profiles").update({ role: "player" }).eq("id", sa);
  });
  it("no client role can read or write any story table or call any story function", async () => {
    const email = `member-${randomUUID()}@test.local`;
    const { data: created } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    await admin.from("user_profiles").insert({ id: created.user!.id, display_name: "member", role: "player", is_active: true });
    const member = getTestAnonClient();
    expect((await member.auth.signInWithPassword({ email, password: PASSWORD })).error).toBeNull();
    for (const client of [getTestAnonClient(), member]) {
      for (const table of ["game_story_config", "game_story_runs", "game_story_evidence", "game_story_claims", "game_story_claim_evidence", "game_story_revisions"]) {
        const read = await client.from(table).select("*").limit(1);
        expect(read.error !== null || (read.data ?? []).length === 0, `${table} must not be readable`).toBe(true);
        expect((await client.from(table).insert({}).select()).error, `${table} must not be writable`).not.toBeNull();
      }
      for (const [fn, args] of [["start_game_story_run", { p_fixture_id: randomUUID(), p_trigger: "SCHEDULED" }], ["approve_game_story_revision", { p_admin_id: staff, p_revision_id: randomUUID() }], ["withdraw_game_story", { p_admin_id: staff, p_fixture_id: randomUUID(), p_reason: "x" }], ["admin_set_game_story_config", { p_admin_id: staff, p_config: {} }], ["game_story_candidates", { p_limit: 5 }], ["game_story_metrics", { p_since: new Date().toISOString() }]] as const) {
        expect((await client.rpc(fn, args as never)).error, `${fn} must not be callable`).not.toBeNull();
      }
    }
  });
  it("history is append-only: nothing in the story tables can be deleted", async () => {
    const g = await game();
    await enable();
    const { runId } = await reviewable(g.fixtureId);
    // the service role has no DELETE privilege on these tables at all (and a trigger refuses it for any other writer)
    expect((await admin.from("game_story_runs").delete().eq("id", runId)).error?.message).toMatch(/permission denied|append-only/);
    expect((await admin.from("game_story_evidence").delete().eq("run_id", runId)).error?.message).toMatch(/permission denied|append-only/);
    expect((await admin.from("game_story_revisions").delete().eq("run_id", runId)).error?.message).toMatch(/permission denied|append-only/);
  });
});

describe("starting a run: eligibility, cutoff, idempotency, concurrency", () => {
  it("is refused while generation is off, and creates nothing", async () => {
    const g = await game();
    expect((await start(g.fixtureId)).outcome).toBe("disabled");
    expect((await admin.from("game_story_runs").select("id", { count: "exact", head: true })).count).toBe(0);
  });
  it("refuses Games that are not eligible: unsupported sport, already started, no Post; and Games inside the editorial cutoff", async () => {
    await enable();
    const soccer = await game(24 * 60, { sport: "football", provider: "api_football" });
    const started = await game(24 * 60);
    await setFixture(started.fixtureId, { internal_status: "LIVE" });
    const { fixtureId: noPost } = await seedGame({ sport: "basketball" });
    const close = await game(60);
    expect((await start(soccer.fixtureId)).outcome).toBe("not_eligible");
    expect((await start(started.fixtureId)).outcome).toBe("not_eligible");
    expect((await start(noPost)).outcome).toBe("not_eligible");
    expect((await start(close.fixtureId)).outcome).toBe("past_cutoff");
    // an Admin trigger does not bypass the cutoff
    expect((await start(close.fixtureId, "ADMIN", staff)).outcome).toBe("past_cutoff");
  });
  it("an Admin trigger needs an Admin", async () => {
    await enable();
    const g = await game();
    const member = await seedUser("plain");
    expect((await admin.rpc("start_game_story_run", { p_fixture_id: g.fixtureId, p_trigger: "ADMIN", p_admin_id: member })).error?.message).toMatch(/not_authorized/);
  });
  it("two parallel starts for one Game produce exactly one active run", async () => {
    await enable();
    const g = await game();
    const results = await Promise.all(Array.from({ length: 6 }, () => start(g.fixtureId)));
    expect(results.filter((r) => r.outcome === "started")).toHaveLength(1);
    expect(results.filter((r) => r.outcome !== "started").every((r) => ["active_run_exists", "recently_researched"].includes(r.outcome))).toBe(true);
    expect((await admin.from("game_story_runs").select("id", { count: "exact", head: true }).eq("fixture_id", g.fixtureId)).count).toBe(1);
  });
  it("repeated scheduled starts are idempotent within the refresh interval, and bounded by runs per Game", async () => {
    await enable({ refresh_interval_minutes: 15, max_runs_per_game: 2 });
    const g = await game();
    const a = await start(g.fixtureId);
    expect(a.outcome).toBe("started");
    await admin.from("game_story_runs").update({ status: "FAILED", completed_at: new Date().toISOString() }).eq("id", a.run_id!);
    expect((await start(g.fixtureId)).outcome).toBe("recently_researched");
    await admin.from("game_story_runs").update({ started_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", a.run_id!);
    const b = await start(g.fixtureId);
    expect(b.outcome).toBe("started");
    await admin.from("game_story_runs").update({ status: "FAILED", completed_at: new Date().toISOString(), started_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", b.run_id!);
    expect((await start(g.fixtureId)).outcome).toBe("run_limit_reached");
    // an Admin can still regenerate
    expect((await start(g.fixtureId, "REGENERATE", staff)).outcome).toBe("started");
  });
  it("a run that stopped reporting is closed so it cannot block the Game forever", async () => {
    await enable();
    const g = await game();
    const a = await start(g.fixtureId);
    await admin.from("game_story_runs").update({ heartbeat_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", a.run_id!);
    expect((await start(g.fixtureId, "REGENERATE", staff)).outcome).toBe("started");
    const { data } = await admin.from("game_story_runs").select("status, error_category").eq("id", a.run_id!).single();
    expect(data).toMatchObject({ status: "FAILED", error_category: "stale_run" });
  });
  it("candidates: only supported, upcoming, published Games inside the window and outside the cutoff, those without a story first", async () => {
    await enable({ research_window_hours: 48, editorial_cutoff_minutes: 120 });
    const soon = await game(6 * 60);
    const far = await game(100 * 60);
    const tooClose = await game(30);
    const hockey = await game(10 * 60, { sport: "hockey", provider: "api_nhl" });
    const { data } = await admin.rpc("game_story_candidates", { p_limit: 10 });
    const ids = (data as Row[]).map((r) => r.fixture_id);
    expect(ids).toContain(soon.fixtureId);
    expect(ids).toContain(hockey.fixtureId);
    expect(ids).not.toContain(far.fixtureId);
    expect(ids).not.toContain(tooClose.fixtureId);
    expect(ids.indexOf(hockey.fixtureId)).toBeGreaterThan(-1);
    // generation off: no candidates at all
    await setConfig({ generation_enabled: false });
    expect(((await admin.rpc("game_story_candidates", { p_limit: 10 })).data as Row[]).length).toBe(0);
  });
});

describe("saving a result: the database refuses an unverified or over-limit candidate", () => {
  it("an accepted candidate becomes a REVIEW_REQUIRED revision with its evidence, claims and links; the score total is computed by the database", async () => {
    await enable();
    const g = await game();
    const { runId, revisionId } = await reviewable(g.fixtureId);
    const { data: run } = await admin.from("game_story_runs").select("status, decision, total_score, min_score_applied, sources_kept, model_calls").eq("id", runId).single();
    expect(run).toMatchObject({ status: "REVIEW_REQUIRED", decision: "ACCEPTED", total_score: 89, min_score_applied: 80, sources_kept: 2, model_calls: 4 });
    expect((await admin.from("game_story_claims").select("verdict").eq("revision_id", revisionId)).data).toHaveLength(2);
    expect((await admin.from("game_story_claim_evidence").select("claim_id", { count: "exact", head: true })).count).toBe(2);
    const { data: post } = await admin.from("posts").select("story_revision_id").eq("id", g.postId).single();
    expect(post!.story_revision_id).toBeNull(); // generation is never publication
  });
  it.each([
    ["an unsupported claim", (p: Row) => ({ ...p, claims: [{ ...p.claims[0], verdict: "UNSUPPORTED" }, p.claims[1]] }), /accepted_with_unsupported_claim/],
    ["no claims at all", (p: Row) => ({ ...p, claims: [] }), /accepted_requires_claims/],
    ["a score below the minimum", (p: Row) => ({ ...p, dims: { relevance: 10, evidence: 10, debate: 10, originality: 10, freshness: 10 } }), /accepted_below_minimum_score/],
    ["no scores", (p: Row) => ({ ...p, dims: null }), /accepted_requires_scores/],
    ["a story over the configured length", (p: Row) => ({ ...p, revision: { hook: "Five straight for Boston.", body: "x".repeat(400) } }), /game_story_over_length/],
  ])("refuses to accept a candidate with %s, and saves nothing", async (_n, mutate, message) => {
    await enable();
    const g = await game();
    const s = await start(g.fixtureId);
    const r = await save(s.run_id!, mutate(accepted()));
    expect(r.error?.message).toMatch(message);
    expect((await admin.from("game_story_revisions").select("id", { count: "exact", head: true })).count).toBe(0);
    expect((await admin.from("game_story_evidence").select("id", { count: "exact", head: true })).count).toBe(0); // the whole save rolled back
    expect((await admin.from("game_story_runs").select("status").eq("id", s.run_id!).single()).data!.status).not.toBe("REVIEW_REQUIRED");
  });
  it("score dimensions are range-checked by the database", async () => {
    await enable();
    const g = await game();
    const s = await start(g.fixtureId);
    expect((await admin.from("game_story_runs").update({ dim_relevance: 31 }).eq("id", s.run_id!)).error?.message).toMatch(/dim_relevance/);
  });
  it("a rejection stores the evidence, claims and the reason, creates no revision, and leaves the Post unchanged", async () => {
    await enable();
    const g = await game();
    const s = await start(g.fixtureId);
    const p = accepted({ decision: "REJECTED", rejection_code: "UNSUPPORTED_CLAIM", rejection_detail: "The claim states 9, which the evidence does not contain.", dims: null, revision: null });
    p.claims[0].verdict = "UNSUPPORTED";
    expect((await save(s.run_id!, p)).data).toBe("rejected");
    const { data: run } = await admin.from("game_story_runs").select("status, decision, rejection_code, candidate_hook").eq("id", s.run_id!).single();
    expect(run).toMatchObject({ status: "REJECTED", decision: "REJECTED", rejection_code: "UNSUPPORTED_CLAIM", candidate_hook: "Five straight for Boston." });
    expect((await admin.from("game_story_revisions").select("id", { count: "exact", head: true })).count).toBe(0);
    expect((await admin.from("game_story_evidence").select("id", { count: "exact", head: true }).eq("run_id", s.run_id!)).count).toBe(2);
    expect((await admin.from("posts").select("story_revision_id").eq("id", g.postId).single()).data!.story_revision_id).toBeNull();
    // a finished run's result cannot be rewritten
    expect((await admin.from("game_story_runs").update({ candidate_hook: "Changed" }).eq("id", s.run_id!)).error?.message).toMatch(/immutable/);
  });
});

describe("approval: the only way a story reaches the Post; audited, serialised, versioned", () => {
  it("approving puts the story on the canonical Post (no new Post), is audited, and is idempotent", async () => {
    await enable();
    const g = await game();
    const { revisionId } = await reviewable(g.fixtureId);
    const posts = (await admin.from("posts").select("id", { count: "exact", head: true })).count;
    expect((await admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: revisionId })).data).toBe("approved");
    expect((await admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: revisionId })).data).toBe("already_approved");
    expect((await admin.from("posts").select("id", { count: "exact", head: true })).count).toBe(posts);
    const { data: post } = await admin.from("posts").select("story_revision_id").eq("id", g.postId).single();
    expect(post!.story_revision_id).toBe(revisionId);
    const { data: rev } = await admin.from("game_story_revisions").select("status, approved_by, approved_at, post_id").eq("id", revisionId).single();
    expect(rev).toMatchObject({ status: "APPROVED", approved_by: staff, post_id: g.postId });
    expect(rev!.approved_at).not.toBeNull();
    const { data: audit } = await admin.from("audit_logs").select("action, entity_id").eq("action", "game_story.approved").eq("actor_id", staff);
    expect(audit).toHaveLength(1);
    expect(await getApprovedStoryForFixture(g.fixtureId)).toMatchObject({ hook: "Five straight for Boston." });
  });
  it("only an Admin can approve; a revision that is not waiting for review cannot be", async () => {
    await enable();
    const g = await game();
    const { revisionId } = await reviewable(g.fixtureId);
    const member = await seedUser("plain");
    expect((await admin.rpc("approve_game_story_revision", { p_admin_id: member, p_revision_id: revisionId })).error?.message).toMatch(/not_authorized/);
    expect((await admin.rpc("reject_game_story_revision", { p_admin_id: staff, p_revision_id: revisionId, p_reason: "off topic" })).data).toBe("rejected");
    expect((await admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: revisionId })).error?.message).toMatch(/revision_not_reviewable/);
    expect((await admin.from("posts").select("story_revision_id").eq("id", g.postId).single()).data!.story_revision_id).toBeNull();
  });
  it("a better story replaces the old one: the old revision is kept as SUPERSEDED and the Post points at the new one", async () => {
    await enable({ refresh_interval_minutes: 15 });
    const g = await game();
    const first = await reviewable(g.fixtureId);
    await admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: first.revisionId });
    await admin.from("game_story_runs").update({ started_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", first.runId);
    const second = await reviewable(g.fixtureId, staff);
    expect((await admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: second.revisionId })).data).toBe("approved");
    const { data: revs } = await admin.from("game_story_revisions").select("id, status").eq("fixture_id", g.fixtureId);
    expect(revs!.find((r) => r.id === first.revisionId)!.status).toBe("SUPERSEDED");
    expect(revs!.find((r) => r.id === second.revisionId)!.status).toBe("APPROVED");
    expect((await admin.from("posts").select("story_revision_id").eq("id", g.postId).single()).data!.story_revision_id).toBe(second.revisionId);
    expect((await admin.from("game_story_runs").select("status").eq("id", first.runId).single()).data!.status).toBe("SUPERSEDED");
    expect(revs).toHaveLength(2); // nothing was destroyed
  });
  it("two Admins approving different revisions at once leave exactly ONE approved story and a consistent Post", async () => {
    await enable({ refresh_interval_minutes: 15 });
    const g = await game();
    const a = await reviewable(g.fixtureId);
    await admin.from("game_story_runs").update({ status: "FAILED", completed_at: new Date().toISOString() }).eq("id", a.runId).in("status", ["REVIEW_REQUIRED"]).then(() => undefined, () => undefined);
    // a second reviewable revision for the same Game (a different run)
    await admin.from("game_story_runs").update({ started_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", a.runId);
    const b = await reviewable(g.fixtureId, staff);
    const other = await makeAdmin();
    const results = await Promise.all([admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: a.revisionId }), admin.rpc("approve_game_story_revision", { p_admin_id: other, p_revision_id: b.revisionId })]);
    expect(results.every((r) => !r.error)).toBe(true);
    const { data: approved } = await admin.from("game_story_revisions").select("id").eq("fixture_id", g.fixtureId).eq("status", "APPROVED");
    expect(approved).toHaveLength(1);
    expect((await admin.from("posts").select("story_revision_id").eq("id", g.postId).single()).data!.story_revision_id).toBe(approved![0].id);
    await admin.from("user_profiles").update({ role: "player" }).eq("id", other);
  });
  it("the database enforces the limit again at approval (a smaller limit set after generation)", async () => {
    await enable();
    const g = await game();
    const { revisionId } = await reviewable(g.fixtureId);
    await setConfig({ max_chars: 100 });
    expect((await admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: revisionId })).error?.message).toMatch(/game_story_over_length/);
  });
  it("a story is never published or replaced after kickoff; withdrawing stays possible", async () => {
    await enable({ refresh_interval_minutes: 15 });
    const g = await game();
    const first = await reviewable(g.fixtureId);
    await admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: first.revisionId });
    await admin.from("game_story_runs").update({ started_at: new Date(Date.now() - 3_600_000).toISOString() }).eq("id", first.runId);
    const second = await reviewable(g.fixtureId, staff);
    await setFixture(g.fixtureId, { internal_status: "LIVE" });
    expect((await admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: second.revisionId })).error?.message).toMatch(/game_already_started/);
    expect(await getApprovedStoryForFixture(g.fixtureId)).toMatchObject({ revisionId: first.revisionId });
    expect((await admin.rpc("withdraw_game_story", { p_admin_id: staff, p_fixture_id: g.fixtureId, p_reason: "late correction" })).data).toBe("withdrawn");
  });
  it("withdrawing takes the story off the Post, keeps the revision and is audited", async () => {
    await enable();
    const g = await game();
    const { revisionId } = await reviewable(g.fixtureId);
    await admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: revisionId });
    expect((await admin.rpc("withdraw_game_story", { p_admin_id: staff, p_fixture_id: g.fixtureId, p_reason: "wrong injury report" })).data).toBe("withdrawn");
    expect((await admin.from("posts").select("story_revision_id").eq("id", g.postId).single()).data!.story_revision_id).toBeNull();
    expect((await admin.from("game_story_revisions").select("status, withdrawn_reason").eq("id", revisionId).single()).data).toMatchObject({ status: "WITHDRAWN", withdrawn_reason: "wrong injury report" });
    expect(await getApprovedStoryForFixture(g.fixtureId)).toBeNull();
    expect((await admin.rpc("withdraw_game_story", { p_admin_id: staff, p_fixture_id: g.fixtureId, p_reason: "again" })).data).toBe("nothing_to_withdraw");
  });
  it("an Admin's edit is a NEW revision that cannot be approved until its facts are re-verified; the live copy stays until then", async () => {
    await enable();
    const g = await game();
    const { revisionId, runId } = await reviewable(g.fixtureId);
    await admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: revisionId });
    const { data: edited, error } = await admin.rpc("admin_edit_game_story_revision", { p_admin_id: staff, p_revision_id: revisionId, p_hook: "Six straight for Boston.", p_body: "Boston has won six straight and three meetings in a row against New York. Does it get a seventh?" });
    expect(error).toBeNull();
    // the live story is unchanged
    expect(await getApprovedStoryForFixture(g.fixtureId)).toMatchObject({ hook: "Five straight for Boston." });
    expect((await admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: edited })).error?.message).toMatch(/verification_required/);
    // text of an existing revision is immutable
    expect((await admin.from("game_story_revisions").update({ hook: "Sneaky" }).eq("id", revisionId)).error?.message).toMatch(/immutable/);
    // a failed re-verification keeps it blocked; a clean one lifts the block
    const e1 = (await admin.from("game_story_evidence").select("id").eq("run_id", runId).limit(1).single()).data!.id;
    const claimRow = (verdict: string) => ({ id: randomUUID(), position: 0, text: "Boston has won 6 straight", type: "STREAK", subject_team: "HOME", verdict, deterministic_ok: verdict === "SUPPORTED", model_verdict: null, note: "", evidence_ids: [e1] });
    expect((await admin.rpc("complete_game_story_reverification", { p_revision_id: edited, p_claims: [claimRow("UNSUPPORTED")] })).data).toBe("verification_failed");
    expect((await admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: edited })).error?.message).toMatch(/verification_required|unsupported_claims/);
    expect((await admin.rpc("complete_game_story_reverification", { p_revision_id: edited, p_claims: [claimRow("SUPPORTED")] })).data).toBe("verified");
    // still blocked by the earlier UNSUPPORTED claim on the same revision: every claim must be supported
    expect((await admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: edited })).error?.message).toMatch(/unsupported_claims/);
    const { data: audit } = await admin.from("audit_logs").select("action").eq("action", "game_story.edited").eq("entity_id", edited as string);
    expect(audit).toHaveLength(1);
  });
});

describe("the pipeline end to end with fake providers (real database, real services)", () => {
  /** Real, completed history so the deterministic Game facts have something to compute from. */
  async function history(homeName = "Boston Celtics", awayName = "New York Knicks") {
    const day = 86_400_000;
    const rows = [
      [10, homeName, awayName, 110, 100], [40, awayName, homeName, 98, 105], [90, homeName, awayName, 120, 101], [4, homeName, "Miami Heat", 100, 90], [8, "Orlando Magic", homeName, 95, 101],
      [3, awayName, "Chicago Bulls", 90, 99], [6, "Toronto Raptors", awayName, 100, 92],
    ] as const;
    for (const [daysAgo, home, away, hs, as] of rows) {
      const { error } = await admin.from("fixtures").insert({ provider: "api_nba", external_fixture_id: `hist-${randomUUID()}`, sport: "basketball", home_team_name: home, away_team_name: away, scheduled_start_utc: new Date(Date.now() - daysAgo * day).toISOString(), internal_status: "COMPLETED", home_score: hs, away_score: as });
      if (error) throw error;
    }
  }
  const byKey = (e: EvidenceItem[], k: string) => e.find((x) => x.factKey === k)!;
  const goodDraft = (e: EvidenceItem[]): Draft => ({
    hook: "Five straight for Boston.",
    body: "Boston has won five straight and three meetings in a row against New York, who have lost five straight. Does the streak survive tonight?",
    claims: [
      claim({ text: "Boston has won 5 straight games", type: "STREAK", subjectTeam: "HOME", evidenceIds: [byKey(e, "streak:home").id] }),
      claim({ text: "Boston has won the last 3 meetings against New York", type: "HISTORY", subjectTeam: "BOTH", evidenceIds: [byKey(e, "h2h:streak").id] }),
      claim({ text: "New York has lost 5 straight games", type: "STREAK", subjectTeam: "AWAY", evidenceIds: [byKey(e, "streak:away").id] }),
    ],
  });
  const fake = (script: Parameters<typeof fakeDeps>[0]) => ({ createDeps: () => fakeDeps(script, () => new Date()).deps, now: () => new Date() });

  it("accepted: candidate, evidence and claims are stored; the Post is untouched until an Admin approves; then the story appears on the canonical Post; Picks and comments are unchanged", async () => {
    await enable();
    await history();
    const g = await game();
    const picker = await seedUser("picker");
    await seedPick(picker, g.marketId, "YES");
    const picksBefore = (await admin.from("predictions").select("id", { count: "exact", head: true })).count;

    const r = await generateStoryForFixture({ fixtureId: g.fixtureId, trigger: "ADMIN", adminId: staff }, fake({ raw: [], drafts: [goodDraft] }));
    expect(r).toMatchObject({ outcome: "completed", decision: "ACCEPTED", saved: "review_required" });
    const { data: run } = await admin.from("game_story_runs").select("*").eq("id", (r as Row).runId).single();
    expect(run).toMatchObject({ status: "REVIEW_REQUIRED", decision: "ACCEPTED", total_score: 89 });
    expect(run!.sources_kept).toBeGreaterThanOrEqual(3);
    expect((run!.details as Row).evidence.structured).toBeGreaterThanOrEqual(3);
    expect((await admin.from("game_story_evidence").select("source_kind").eq("run_id", run!.id)).data!.every((e) => e.source_kind === "STRUCTURED_DATA")).toBe(true);
    const { data: claims } = await admin.from("game_story_claims").select("verdict").eq("run_id", run!.id);
    expect(claims).toHaveLength(3);
    expect(claims!.every((c) => c.verdict === "SUPPORTED")).toBe(true);

    expect(await getApprovedStoryForFixture(g.fixtureId)).toBeNull();
    const { data: rev } = await admin.from("game_story_revisions").select("id").eq("run_id", run!.id).single();
    expect((await admin.rpc("approve_game_story_revision", { p_admin_id: staff, p_revision_id: rev!.id })).data).toBe("approved");
    expect(await getApprovedStoryForFixture(g.fixtureId)).toMatchObject({ hook: "Five straight for Boston." });
    expect((await admin.from("predictions").select("id", { count: "exact", head: true })).count).toBe(picksBefore);
    expect((await admin.from("posts").select("id", { count: "exact", head: true }).eq("fixture_id", g.fixtureId)).count).toBe(1); // still ONE canonical Post
  });

  it("rejected (an unsupported claim): no revision, Post unchanged, the reason is visible, and the Game can be regenerated", async () => {
    await enable();
    await history();
    const g = await game();
    const bad = (e: EvidenceItem[]): Draft => ({ ...goodDraft(e), claims: [...goodDraft(e).claims, claim({ text: "Boston has won 9 straight games", type: "STREAK", subjectTeam: "HOME", evidenceIds: [byKey(e, "streak:home").id] })] });
    const r = await generateStoryForFixture({ fixtureId: g.fixtureId, trigger: "ADMIN", adminId: staff }, fake({ raw: [], drafts: [bad], score: { ...GOOD_SCORE, dims: { relevance: 30, evidence: 25, debate: 20, originality: 15, freshness: 10 } } }));
    expect(r).toMatchObject({ outcome: "completed", decision: "REJECTED", rejectionCode: "UNSUPPORTED_CLAIM" });
    const { data: run } = await admin.from("game_story_runs").select("status, rejection_code, rejection_detail, candidate_hook").eq("id", (r as Row).runId).single();
    expect(run).toMatchObject({ status: "REJECTED", rejection_code: "UNSUPPORTED_CLAIM" });
    expect(run!.rejection_detail).toMatch(/9/);
    expect((await admin.from("game_story_revisions").select("id", { count: "exact", head: true })).count).toBe(0);
    expect(await getApprovedStoryForFixture(g.fixtureId)).toBeNull();
    const again = await generateStoryForFixture({ fixtureId: g.fixtureId, trigger: "REGENERATE", adminId: staff }, fake({ raw: [], drafts: [goodDraft] }));
    expect(again).toMatchObject({ outcome: "completed", decision: "ACCEPTED" });
  });

  it("no story: a Game with too little verified material ends as NO_STORY, honestly", async () => {
    await enable();
    const g = await game();
    const r = await generateStoryForFixture({ fixtureId: g.fixtureId, trigger: "ADMIN", adminId: staff }, fake({ raw: [] }));
    expect(r).toMatchObject({ outcome: "completed", decision: "NO_STORY" });
    expect(["NO_EVIDENCE", "INSUFFICIENT_EVIDENCE"]).toContain((r as Row).rejectionCode);
    expect((await admin.from("game_story_runs").select("status").eq("id", (r as Row).runId).single()).data!.status).toBe("REJECTED");
  });

  it("a provider failure closes the run as FAILED and the Game, its Market, Picks and comments are completely unaffected", async () => {
    await enable();
    await history();
    const g = await game();
    const picker = await seedUser("picker2");
    const before = { posts: (await admin.from("posts").select("*").eq("id", g.postId).single()).data, markets: (await admin.from("markets").select("status, yes_price").eq("id", g.marketId).single()).data };
    const r = await generateStoryForFixture({ fixtureId: g.fixtureId, trigger: "ADMIN", adminId: staff }, fake({ raw: [], providerError: new StoryProviderError("provider_unavailable", "anthropic_api_529: overloaded") }));
    expect(r).toMatchObject({ outcome: "failed" });
    const { data: run } = await admin.from("game_story_runs").select("status, error_category").eq("id", (r as Row).runId).single();
    expect(run!.status).toBe("FAILED");
    expect((await admin.from("posts").select("*").eq("id", g.postId).single()).data).toEqual(before.posts);
    expect((await admin.from("markets").select("status, yes_price").eq("id", g.marketId).single()).data).toEqual(before.markets);
    // predictions still work
    await expect(seedPick(picker, g.marketId, "NO")).resolves.toBeTruthy();
  });

  it("generation OFF stops everything: the scheduled run does nothing, and pending runs are not started", async () => {
    await history();
    const g = await game(6 * 60);
    const report = await runScheduledStories({}, fake({ raw: [], drafts: [goodDraft] }));
    expect(report).toMatchObject({ enabled: false, candidates: 0, results: [] });
    expect((await generateStoryForFixture({ fixtureId: g.fixtureId, trigger: "ADMIN", adminId: staff }, fake({}))).outcome).toBe("disabled");
    expect((await admin.from("game_story_runs").select("id", { count: "exact", head: true })).count).toBe(0);
  });

  it("the scheduled run processes eligible Games one by one within its limits and records each result", async () => {
    await enable({ max_games_per_run: 2 });
    await history();
    const a = await game(6 * 60);
    const b = await game(7 * 60);
    const c = await game(8 * 60);
    const report = await runScheduledStories({}, fake({ raw: [], drafts: [goodDraft] }));
    expect(report.enabled).toBe(true);
    expect(report.results).toHaveLength(2); // bounded by max_games_per_run
    expect(report.results.every((x) => x.outcome === "completed")).toBe(true);
    expect([a, b, c].length).toBe(3);
    // a repeat tick does not re-research the same Games within the refresh interval
    const again = await runScheduledStories({}, fake({ raw: [], drafts: [goodDraft] }));
    expect(again.results.map((x) => x.fixtureId)).not.toEqual(expect.arrayContaining(report.results.map((x) => x.fixtureId)));
  });
});
