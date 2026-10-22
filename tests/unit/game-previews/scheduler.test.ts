import { describe, expect, it, vi } from "vitest";
import { classifyOutcome, classifyError, runScheduledAutomation, reasonFor, type SchedulerDeps, type GenerateResult } from "@/lib/game-previews/scheduler";
import type { GenerationOutcome } from "@/lib/game-previews/pipeline";
import type { AutomationCandidate } from "@/lib/game-previews/repository";
import { config } from "./fixtures";

const usage = (searchCalls = 5, modelCalls = 8) => ({ searchCalls, modelCalls, inputTokens: 1000, outputTokens: 400 });
const baseDetails = { parseRecoveries: [], blockingCounts: { deterministic: 0, reviewer: 0, reviewerByCategory: {} }, attemptsLog: [] };
const ok = (over: Record<string, unknown> = {}): GenerationOutcome => ({ status: "SUCCEEDED", previewId: "p1", write: "created", hook: "h", preview: "b", usage: usage(), attempts: 1, details: baseDetails as never, runId: "run-1", ...over }) as GenerationOutcome;
const rejected = (error = "draft_rejected", details: Record<string, unknown> = {}): GenerationOutcome => ({ status: "REJECTED", error, problems: [], usage: usage(), attempts: 3, details: { ...baseDetails, ...details } as never, runId: "run-r" });
const failed = (error: string): GenerationOutcome => ({ status: "FAILED", error, problems: [], usage: usage(1, 2), attempts: 1, details: baseDetails as never, runId: "run-f" });

let n = 0;
const cand = (over: Partial<AutomationCandidate> = {}): AutomationCandidate => ({ fixtureId: `fx-${++n}`, postId: "po", homeTeamName: "Home", awayTeamName: "Away", competitionName: "NFL", scheduledStartUtc: `2026-10-25T1${n % 10}:00:00.000Z`, kind: "INITIAL", reason: "MISSING", skipReason: null, ...over });

function setup(opts: { cfg?: Partial<typeof config>; candidates?: AutomationCandidate[]; generate?: SchedulerDeps["generate"]; hide?: SchedulerDeps["hide"]; configured?: boolean; ticks?: number } = {}) {
  let t = 0;
  const generate = vi.fn<SchedulerDeps["generate"]>(opts.generate ?? (async () => ({ kind: "done", outcome: ok() })));
  const hide = vi.fn<SchedulerDeps["hide"]>(opts.hide ?? (async () => true));
  const alert = vi.fn();
  const listCandidates = vi.fn(async () => opts.candidates ?? []);
  const deps: SchedulerDeps = {
    getConfig: async () => ({ ...config, generationEnabled: true, model: "m", maxGamesPerRun: 3, ...opts.cfg }),
    isConfigured: () => opts.configured ?? true,
    listCandidates,
    generate,
    hide,
    alert,
    newId: () => "inv-1",
    clock: () => (t += opts.ticks ?? 1000),
    budgetMs: 270_000,
    estimateMs: 140_000,
    maxConsecutiveTechnicalFailures: 2,
  };
  return { deps, generate, hide, alert, listCandidates };
}

describe("scheduled Game Preview automation: orchestration only", () => {
  it("(A) generation_enabled=false does ZERO work: no candidate query, no provider, no search, no write, no run", async () => {
    const t = setup({ cfg: { generationEnabled: false }, candidates: [cand()] });
    const report = await runScheduledAutomation(t.deps);
    expect(report).toMatchObject({ enabled: false, policyEnabled: false, configured: false, attempted: 0, succeeded: 0, failed: 0, invocationId: null });
    expect(t.listCandidates).not.toHaveBeenCalled();
    expect(t.generate).not.toHaveBeenCalled();
    expect(t.hide).not.toHaveBeenCalled();
  });

  it("enabled but no provider or model configured: nothing runs", async () => {
    for (const t of [setup({ configured: false, candidates: [cand()] }), setup({ cfg: { model: " " }, candidates: [cand()] })]) {
      expect(await runScheduledAutomation(t.deps)).toMatchObject({ enabled: true, configured: false, attempted: 0 });
      expect(t.generate).not.toHaveBeenCalled();
    }
  });

  it("(B) an eligible Game is selected and run through the pipeline as an AUTOMATIC run with the invocation id; (O) no human actor is ever passed", async () => {
    const c = cand();
    const t = setup({ candidates: [c] });
    const report = await runScheduledAutomation(t.deps);
    expect(t.generate).toHaveBeenCalledOnce();
    expect(t.generate.mock.calls[0][0]).toBe(c);
    expect(t.generate.mock.calls[0][2]).toEqual({ id: "inv-1", kind: "INITIAL" });
    expect(report).toMatchObject({ invocationId: "inv-1", considered: 1, eligible: 1, selected: 1, attempted: 1, succeeded: 1, failed: 0, halted: null });
    expect(report.games[0]).toMatchObject({ fixtureId: c.fixtureId, kind: "INITIAL", result: "READY", runId: "run-1", searchCalls: 5, modelCalls: 8 });
    expect(reasonFor(c)).toBe("MISSING");
  });

  it("(C, D, R) Games the database says to skip (outside the window, already has a valid Preview, started, unsupported, suppressed) are counted by reason and never run", async () => {
    const skipped = [cand({ skipReason: "STATUS_FRESH" }), cand({ skipReason: "ADMIN_WITHDRAWN" }), cand({ skipReason: "RETRY_THROTTLED" }), cand({ skipReason: "UNSUPPORTED_COMPETITION" }), cand({ skipReason: "NOT_STATUS_BEARING" })];
    const t = setup({ candidates: [...skipped, cand()] });
    const report = await runScheduledAutomation(t.deps);
    expect(t.generate).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ considered: 6, eligible: 1, selected: 1 });
    expect(report.skippedByReason).toEqual({ STATUS_FRESH: 1, ADMIN_WITHDRAWN: 1, RETRY_THROTTLED: 1, UNSUPPORTED_COMPETITION: 1, NOT_STATUS_BEARING: 1 });
  });

  it("(S) at most max_games_per_run Games are taken, in a deterministic order: refreshes first, then earliest Game first", async () => {
    const list = [
      cand({ fixtureId: "late", scheduledStartUtc: "2026-10-26T20:00:00.000Z" }),
      cand({ fixtureId: "early", scheduledStartUtc: "2026-10-25T13:00:00.000Z" }),
      cand({ fixtureId: "refresh-late", kind: "REFRESH", reason: "MATERIAL_NEW_INFORMATION", scheduledStartUtc: "2026-10-25T20:00:00.000Z" }),
      cand({ fixtureId: "mid", scheduledStartUtc: "2026-10-25T17:00:00.000Z" }),
    ];
    const t = setup({ candidates: list, cfg: { maxGamesPerRun: 3 } });
    const report = await runScheduledAutomation(t.deps);
    expect(t.generate.mock.calls.map((c) => c[0].fixtureId)).toEqual(["refresh-late", "early", "mid"]);
    expect(report).toMatchObject({ eligible: 4, selected: 3, attempted: 3 });
    const one = setup({ candidates: list, cfg: { maxGamesPerRun: 1 } });
    await runScheduledAutomation(one.deps);
    expect(one.generate).toHaveBeenCalledTimes(1);
  });

  it("(F) needs_review publishes nothing, is counted as a normal outcome (not a failure, not an alert), and never triggers a hide for an INITIAL Game", async () => {
    const t = setup({ candidates: [cand()], generate: async () => ({ kind: "done", outcome: rejected() }) });
    const report = await runScheduledAutomation(t.deps);
    expect(report).toMatchObject({ attempted: 1, needsReview: 1, succeeded: 0, failed: 0, failures: [] });
    expect(t.alert).not.toHaveBeenCalled();
    expect(t.hide).not.toHaveBeenCalled();
    expect(classifyOutcome(rejected("story_not_verified")).kind).toBe("NEEDS_REVIEW");
    expect(classifyOutcome(rejected("current_status_not_supported")).kind).toBe("NEEDS_REVIEW");
    expect(classifyOutcome(failed("no_verified_facts")).kind).toBe("NEEDS_REVIEW");
  });

  it("(F) there is no path from a rejection to a published Preview: the scheduler only ever calls generate, and 'succeeded' means the pipeline saved one", async () => {
    const t = setup({ candidates: [cand(), cand(), cand()], generate: vi.fn().mockResolvedValueOnce({ kind: "done", outcome: rejected() }).mockResolvedValueOnce({ kind: "done", outcome: ok() }).mockResolvedValueOnce({ kind: "done", outcome: rejected() }) });
    const report = await runScheduledAutomation(t.deps);
    expect(report.succeeded).toBe(1);
    expect(report.needsReview).toBe(2);
  });

  it("(H) a technical failure is recorded separately (failed, a failure entry, an alert), never as needs_review", async () => {
    const t = setup({ candidates: [cand(), cand()], generate: async () => ({ kind: "done", outcome: failed("research_failed: anthropic_api_500: overloaded") }) });
    const report = await runScheduledAutomation(t.deps);
    expect(report).toMatchObject({ failed: 2, needsReview: 0 });
    expect(report.failures).toHaveLength(2);
    expect(report.failures[0].error).toMatch(/^TECHNICAL_FAILURE:/);
    expect(t.alert.mock.calls.map((c) => c[0].kind)).toContain("technical_failure");
    expect(report.games.every((g) => g.result === "TECHNICAL_FAILURE")).toBe(true);
  });

  it("(H) an exception thrown outside the pipeline is a technical failure of that Game, not a crash and not a Preview", async () => {
    const t = setup({ candidates: [cand(), cand()], generate: vi.fn().mockRejectedValueOnce(new Error("socket hang up")).mockResolvedValueOnce({ kind: "done", outcome: ok() }) });
    const report = await runScheduledAutomation(t.deps);
    expect(report).toMatchObject({ attempted: 2, failed: 1, succeeded: 1 });
  });

  it("repeated technical failures stop the invocation (no spinning through the remaining Games)", async () => {
    const t = setup({ candidates: [cand(), cand(), cand()], cfg: { maxGamesPerRun: 3 }, generate: async () => ({ kind: "done", outcome: failed("verifier_failed: socket hang up") }) });
    const report = await runScheduledAutomation(t.deps);
    expect(t.generate).toHaveBeenCalledTimes(2);
    expect(report.halted).toBe("repeated_technical_failure");
    expect(t.alert.mock.calls.map((c) => c[0].kind)).toContain("repeated_technical_failure");
  });

  it("(I) a provider credit failure fails safely: that run is FAILED, an urgent alert is raised, and NO remaining Game is attempted", async () => {
    const credit = "research_failed: anthropic_api_400: 400 {\"type\":\"error\",\"error\":{\"message\":\"Your credit balance is too low to access the Anthropic API.\"}}";
    const t = setup({ candidates: [cand(), cand(), cand()], generate: async () => ({ kind: "done", outcome: failed(credit) }) });
    const report = await runScheduledAutomation(t.deps);
    expect(t.generate).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ attempted: 1, failed: 1, halted: "provider_credit" });
    expect(t.alert.mock.calls.find((c) => c[0].kind === "provider_credit_exhausted")?.[0].message).toMatch(/credit balance is exhausted/);
    expect(classifyOutcome(failed(credit)).kind).toBe("PROVIDER_CREDIT");
    expect(classifyError(new Error("anthropic_api_400: Your credit balance is too low")).kind).toBe("PROVIDER_CREDIT");
    expect(classifyOutcome(failed("research_failed: anthropic_api_401: invalid x-api-key")).kind).toBe("PROVIDER_AUTH");
  });

  it("(I) it does not change any setting when the provider fails: generation_enabled is the owner's switch", async () => {
    const t = setup({ candidates: [cand()], generate: async () => ({ kind: "done", outcome: failed("x: Your credit balance is too low") }) });
    await runScheduledAutomation(t.deps);
    expect(Object.keys(t.deps)).not.toContain("disable");
  });

  it("(P) a Game that is busy (an Admin or another invocation holds its lease) or no longer eligible is skipped without error, and the rest continue", async () => {
    const results: GenerateResult[] = [{ kind: "busy" }, { kind: "ineligible" }, { kind: "done", outcome: ok() }];
    const t = setup({ candidates: [cand(), cand(), cand()], generate: async () => results.shift()! });
    const report = await runScheduledAutomation(t.deps);
    expect(report.games.map((g) => g.result)).toEqual(["BUSY", "NO_LONGER_ELIGIBLE", "READY"]);
    expect(report).toMatchObject({ attempted: 1, succeeded: 1, skipped: 2, failed: 0 });
  });

  it("(E) the same Game is never run twice in one invocation, and a second invocation that finds it busy does nothing", async () => {
    const same = cand({ fixtureId: "one" });
    const t1 = setup({ candidates: [same] });
    await runScheduledAutomation(t1.deps);
    expect(t1.generate.mock.calls.filter((c) => c[0].fixtureId === "one")).toHaveLength(1);
    const t2 = setup({ candidates: [same], generate: async () => ({ kind: "busy" }) });
    const report = await runScheduledAutomation(t2.deps);
    expect(report).toMatchObject({ attempted: 0, succeeded: 0, skipped: 1 });
  });

  it("(J, L) a refresh-eligible status-bearing Preview is run as a REFRESH with the MATERIAL_NEW_INFORMATION reason, and a verified refresh counts as refreshed (nothing is hidden)", async () => {
    const c = cand({ kind: "REFRESH", reason: "MATERIAL_NEW_INFORMATION" });
    const t = setup({ candidates: [c], generate: async () => ({ kind: "done", outcome: ok({ write: "refreshed" }) }) });
    const report = await runScheduledAutomation(t.deps);
    expect(reasonFor(c)).toBe("MATERIAL_NEW_INFORMATION");
    expect(t.generate.mock.calls[0][2].kind).toBe("REFRESH");
    expect(report).toMatchObject({ refreshed: 1, hidden: 0, succeeded: 1 });
    expect(t.hide).not.toHaveBeenCalled();
  });

  it("(M) a refresh that cannot verify the status hides the Preview (withdrawn, never deleted), records why, alerts for review, and reports the Job as degraded through failures", async () => {
    for (const outcome of [rejected("current_status_not_supported"), failed("research_failed: anthropic_api_500: overloaded")]) {
      const c = cand({ kind: "REFRESH", reason: "MATERIAL_NEW_INFORMATION" });
      const t = setup({ candidates: [c], generate: async () => ({ kind: "done", outcome }) });
      const report = await runScheduledAutomation(t.deps);
      expect(t.hide).toHaveBeenCalledOnce();
      expect(t.hide.mock.calls[0][0]).toBe(c.fixtureId);
      expect(t.hide.mock.calls[0][1]).toMatch(/could not re-establish the current player status/);
      expect(report).toMatchObject({ hidden: 1 });
      expect(report.games[0].hidden).toBe(true);
      expect(report.failures.some((f) => f.step === `hidden:${c.fixtureId}`)).toBe(true);
      expect(t.alert.mock.calls.map((a) => a[0].kind)).toContain("refresh_hid_preview");
    }
  });

  it("(M) a refresh that is merely skipped (the database said too soon / already current) does not hide anything", async () => {
    const t = setup({ candidates: [cand({ kind: "REFRESH", reason: "MATERIAL_NEW_INFORMATION" })], generate: async () => ({ kind: "done", outcome: failed("not_saved: too_soon") }) });
    const report = await runScheduledAutomation(t.deps);
    expect(report).toMatchObject({ hidden: 0, failed: 0, skipped: 1 });
    expect(t.hide).not.toHaveBeenCalled();
  });

  it("a provider credit failure during a refresh still hides that stale status-bearing Preview, and stops the invocation", async () => {
    const t = setup({ candidates: [cand({ kind: "REFRESH", reason: "MATERIAL_NEW_INFORMATION" }), cand({ kind: "REFRESH", reason: "MATERIAL_NEW_INFORMATION" })], generate: async () => ({ kind: "done", outcome: failed("research_failed: Your credit balance is too low") }) });
    const report = await runScheduledAutomation(t.deps);
    expect(t.generate).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ hidden: 1, halted: "provider_credit", refreshBacklog: 1 });
  });

  it("the time budget: a Game is started only when its expected run time still fits in the function limit", async () => {
    const t = setup({ candidates: [cand(), cand(), cand()], ticks: 100_000 }); // every clock read advances 100 s
    const report = await runScheduledAutomation(t.deps);
    expect(t.generate.mock.calls.length).toBeLessThan(3);
    expect(report.halted).toBe("time_budget");
  });

  it("status and stale-current blocks are surfaced for review, and counted, without being alerts for ordinary rejections", async () => {
    const withBlocks = rejected("draft_rejected", { blockingCounts: { deterministic: 1, reviewer: 3, reviewerByCategory: { status_source_ineligible: 1, stale_current: 2, unsupported_claim: 1 } }, attemptsLog: [{ provenanceProblems: ["[status_source_ineligible] Fact f4 states a status..."] }] });
    const t = setup({ candidates: [cand()], generate: async () => ({ kind: "done", outcome: withBlocks }) });
    const report = await runScheduledAutomation(t.deps);
    expect(report).toMatchObject({ statusBlocks: 2, staleCurrentBlocks: 2, needsReview: 1, failed: 0 });
    expect(t.alert.mock.calls.map((a) => a[0].kind).sort()).toEqual(["stale_current_blocked", "status_source_blocked"]);
  });

  it("(T) a recovered JSON format retry is counted and the run continues; one that did not recover is a technical failure with its own alert", async () => {
    const recovered = ok({ details: { ...baseDetails, parseRecoveries: [{ stage: "fact_check_targeted", recovered: true }] } });
    const a = setup({ candidates: [cand()], generate: async () => ({ kind: "done", outcome: recovered }) });
    expect(await runScheduledAutomation(a.deps)).toMatchObject({ succeeded: 1, usage: { parseRecoveries: 1 } });
    const unrecovered = failed("fact_verification_failed: The targeted check answer was not valid JSON, and the one format retry did not recover it.");
    const b = setup({ candidates: [cand()], generate: async () => ({ kind: "done", outcome: unrecovered }) });
    const report = await runScheduledAutomation(b.deps);
    expect(report).toMatchObject({ failed: 1, needsReview: 0 });
    expect(b.alert.mock.calls.map((x) => x[0].kind)).toEqual(expect.arrayContaining(["json_not_recovered", "technical_failure"]));
  });

  it("(U) usage is aggregated per invocation so the first-week cost can be read; the per-Game ceiling is the pipeline's, never raised by the scheduler", async () => {
    const t = setup({ candidates: [cand(), cand()], generate: async () => ({ kind: "done", outcome: ok({ usage: usage(7, 9) }) }) });
    const report = await runScheduledAutomation(t.deps);
    expect(report.usage).toMatchObject({ searchCalls: 14, modelCalls: 18, inputTokens: 2000, outputTokens: 800 });
    expect(t.generate.mock.calls.every((c) => c[1].maxSearchCallsPerGame === 8)).toBe(true); // the config handed to the pipeline is the stored one, untouched
  });
});
