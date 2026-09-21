/**
 * Integration tests for Milestone 5.5 — Execution Controls, Reconciliation
 * & Operational Safety (docs/architecture/execution-operational-safety.md).
 * Real local Supabase only (pnpm supabase:start). No real order is placed,
 * no wallet is touched, no signing occurs, no real provider mutation API
 * is called — every reconciliation scenario here uses the deterministic
 * fixture provider-state source (lib/execution/reconciliation/simulated-provider-adapter.ts),
 * never a live network call.
 *
 * Deliberately does NOT depend on the live Polymarket adapter (STEP 27) —
 * kill switches, cohorts, limits, provider health, and reconciliation are
 * all exercised directly against their own repository/service functions,
 * which take a plain provider name string and never resolve a real
 * adapter. The existing live-Polymarket dependency stays isolated to
 * tests/integration/execution.test.ts's own explicitly-labeled describe
 * block.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { createOrderIntent, createQuote } from "@/lib/execution/repository";
import { checkExecutionControlPlane } from "@/lib/execution/control-plane";
import { createKillSwitch, disableKillSwitch } from "@/lib/execution/kill-switches";
import { addCohortMember, createCohort, evaluateCohortMembership, getUserCohortKeys, setCohortEnabled } from "@/lib/execution/cohorts";
import { evaluateExecutionLimits, createLimit } from "@/lib/execution/limits";
import {
  decideCallAllowed,
  getProviderHealth,
  isProviderCallAllowed,
  recordProviderFailure,
  recordProviderSuccess,
  setManualProviderOverride,
} from "@/lib/execution/provider-health";
import { recordAuditEvent, listAuditEventsByCorrelationId, listRecentAuditEvents } from "@/lib/execution/audit";
import { reconcileOrderIntent } from "@/lib/execution/reconciliation/engine";
import { createFixtureProviderStateSource } from "@/lib/execution/reconciliation/simulated-provider-adapter";
import { getLatestReconciliationRecord } from "@/lib/execution/reconciliation/repository";
import { getExecutionPolicy } from "@/lib/execution/policy";
import { requestQuote } from "@/lib/execution/quote-service";
import { loadCapabilityPolicy, roleHasCapability } from "@/lib/auth/capabilities";

const admin = getTestAdminClient();
const testProvider = `execution_ops_test_${Date.now()}`;
const createdMarketIds: string[] = [];
const createdUserIds: string[] = [];
const createdSwitchIds: string[] = [];
const createdCohortIds: string[] = [];
const createdLimitIds: string[] = [];

function marketFixture(providerMarketId: string, overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    provider: testProvider,
    providerMarketId,
    providerEventId: null,
    question: `Execution ops test market ${providerMarketId}`,
    description: null,
    status: "ACTIVE",
    price: { yes: 0.6, no: 0.4, outcomeLabels: { yes: "Yes", no: "No" } },
    volume24hr: 100,
    liquidity: 1000,
    resolutionStatus: null,
    resolvedBy: null,
    resolvedOutcome: null,
    opensAt: null,
    closesAt: null,
    closedAt: null,
    ingestionSource: "integration_test",
    providerMetadata: {},
    ...overrides,
  };
}

async function seedMarket(overrides: Partial<NormalizedMarket> = {}): Promise<string> {
  const { id } = await upsertMarket(marketFixture(`m_${Math.random().toString(36).slice(2)}`, overrides));
  createdMarketIds.push(id);
  return id;
}

async function seedUser(): Promise<{ id: string; email: string }> {
  const email = `execution-ops-test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create test user");
  const { error: profileError } = await admin.from("user_profiles").insert({ id: data.user.id, display_name: "Execution Ops Test", role: "player", is_active: true });
  if (profileError) throw profileError;
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email };
}

function fakeQuoteInput(overrides: Partial<Parameters<typeof createQuote>[0]> = {}) {
  const now = new Date();
  return {
    userId: "",
    marketId: "",
    selectedSide: "YES" as const,
    requestedAmountCents: 1000,
    currentPrice: 0.5,
    effectivePrice: 0.5,
    estimatedUnits: 20,
    estimatedGrossReturnCents: 2000,
    providerFeeEstimateCents: 10,
    brohdaFeeEstimateCents: 0,
    totalFeeEstimateCents: 10,
    estimatedSlippageBps: 0,
    providerSnapshotAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    correlationId: randomUUID(),
    ...overrides,
  };
}

/** Seeds a terminal (SIMULATED_FILLED or SIMULATED_REJECTED) order intent directly, without going through the live quote flow. */
async function seedFilledOrderIntent(userId: string, marketId: string, requestedAmountCents: number): Promise<string> {
  const quote = await createQuote(fakeQuoteInput({ userId, marketId, requestedAmountCents }));
  const { orderIntent } = await createOrderIntent({
    userId,
    marketId,
    quoteId: quote.id,
    selectedSide: "YES",
    requestedAmountCents,
    quotedEffectivePrice: quote.effectivePrice,
    quotedEstimatedGrossReturnCents: quote.estimatedGrossReturnCents,
    quotedTotalFeeEstimateCents: quote.totalFeeEstimateCents,
    quotedSlippageBps: quote.estimatedSlippageBps,
    quoteCreatedAt: quote.createdAt,
    quoteProviderSnapshotAt: quote.providerSnapshotAt,
    idempotencyKey: randomUUID(),
    correlationId: quote.correlationId,
  });
  await admin.from("order_intents").update({ lifecycle_state: "SIMULATED_FILLED", resolved_at: new Date().toISOString() }).eq("id", orderIntent.id);
  return orderIntent.id;
}

afterAll(async () => {
  if (createdMarketIds.length > 0) await admin.from("markets").delete().in("id", createdMarketIds);
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
  if (createdSwitchIds.length > 0) await admin.from("execution_kill_switches").delete().in("id", createdSwitchIds);
  if (createdCohortIds.length > 0) await admin.from("execution_cohorts").delete().in("id", createdCohortIds);
  if (createdLimitIds.length > 0) await admin.from("execution_limits").delete().in("id", createdLimitIds);
});

afterEach(async () => {
  // Full isolation between tests: kill switches/cohorts/limits are
  // deliberately soft-disabled in production (never hard-deleted, to
  // preserve history — STEP 29), so cleanup here disables everything this
  // test file created rather than deleting it, exactly mirroring how an
  // operator would actually retire one. The provider-health singleton row
  // and the rollout-mode policy are pure observed/config state with no
  // history requirement, so those ARE reset directly.
  await admin.from("execution_kill_switches").update({ enabled: false, disabled_at: new Date().toISOString() }).eq("enabled", true);
  await admin.from("execution_cohorts").update({ enabled: false }).eq("enabled", true);
  await admin.from("execution_cohort_members").delete().neq("user_id", "00000000-0000-0000-0000-000000000000");
  await admin.from("execution_limits").update({ enabled: false }).eq("enabled", true);
  await admin.from("execution_provider_health").delete().eq("provider", testProvider);
  await admin.from("platform_settings").update({ execution_rollout_mode: "OPEN" }).eq("id", true);
});

describe("execution kill switches — RLS and structural integrity", () => {
  it("denies a direct anon read and write", async () => {
    const anon = getTestAnonClient();
    const { data: readData, error: readError } = await anon.from("execution_kill_switches").select("*");
    expect(readError).not.toBeNull();
    expect(readData).toBeNull();

    const { error: writeError } = await anon.from("execution_kill_switches").insert({ scope: "GLOBAL", reason: "hijack" });
    expect(writeError).not.toBeNull();
  });

  it("disabling a switch soft-disables it (never deletes) and records who/when", async () => {
    const user = await seedUser();
    const created = await createKillSwitch({ scope: "USER", target: user.id, reason: "test", note: null, createdBy: user.id, expiresAt: null });
    createdSwitchIds.push(created.id);

    const disabled = await disableKillSwitch(created.id, user.id);
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.disabledBy).toBe(user.id);
    expect(disabled?.disabledAt).not.toBeNull();

    const { data: stillThere } = await admin.from("execution_kill_switches").select("id").eq("id", created.id).maybeSingle();
    expect(stillThere).not.toBeNull();
  });

  it("an expired switch no longer blocks the control plane", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();
    const created = await createKillSwitch({
      scope: "MARKET",
      target: marketId,
      reason: "expired test",
      note: null,
      createdBy: user.id,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    createdSwitchIds.push(created.id);

    const policy = await getExecutionPolicy();
    const result = await checkExecutionControlPlane({ userId: user.id, provider: testProvider, marketId, jurisdiction: null }, policy);
    expect(result.allowed).toBe(true);
  });
});

describe("execution control plane — precedence (STEP 6)", () => {
  it("allows a request with no active switches", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();
    const policy = await getExecutionPolicy();
    const result = await checkExecutionControlPlane({ userId: user.id, provider: testProvider, marketId, jurisdiction: null }, policy);
    expect(result.allowed).toBe(true);
  });

  it("GLOBAL blocks every request regardless of other scopes", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();
    const policy = await getExecutionPolicy();
    const globalSwitch = await createKillSwitch({ scope: "GLOBAL", target: null, reason: "incident", note: null, createdBy: user.id, expiresAt: null });
    createdSwitchIds.push(globalSwitch.id);

    const result = await checkExecutionControlPlane({ userId: user.id, provider: testProvider, marketId, jurisdiction: null }, policy);
    expect(result).toMatchObject({ allowed: false, reason: "EXECUTION_DISABLED", blockedBySwitch: { scope: "GLOBAL" } });
  });

  it("PROVIDER blocks requests for that provider only", async () => {
    const marketId = await seedMarket();
    const otherMarketId = await seedMarket({ provider: `${testProvider}_other` });
    const user = await seedUser();
    const policy = await getExecutionPolicy();
    const providerSwitch = await createKillSwitch({ scope: "PROVIDER", target: testProvider, reason: "provider outage", note: null, createdBy: user.id, expiresAt: null });
    createdSwitchIds.push(providerSwitch.id);

    const blocked = await checkExecutionControlPlane({ userId: user.id, provider: testProvider, marketId, jurisdiction: null }, policy);
    expect(blocked.allowed).toBe(false);

    const allowed = await checkExecutionControlPlane({ userId: user.id, provider: `${testProvider}_other`, marketId: otherMarketId, jurisdiction: null }, policy);
    expect(allowed.allowed).toBe(true);
  });

  it("MARKET blocks requests for that market only", async () => {
    const blockedMarket = await seedMarket();
    const openMarket = await seedMarket();
    const user = await seedUser();
    const policy = await getExecutionPolicy();
    const marketSwitch = await createKillSwitch({ scope: "MARKET", target: blockedMarket, reason: "bad data", note: null, createdBy: user.id, expiresAt: null });
    createdSwitchIds.push(marketSwitch.id);

    expect((await checkExecutionControlPlane({ userId: user.id, provider: testProvider, marketId: blockedMarket, jurisdiction: null }, policy)).allowed).toBe(false);
    expect((await checkExecutionControlPlane({ userId: user.id, provider: testProvider, marketId: openMarket, jurisdiction: null }, policy)).allowed).toBe(true);
  });

  it("USER blocks requests from that user only", async () => {
    const marketId = await seedMarket();
    const blockedUser = await seedUser();
    const otherUser = await seedUser();
    const policy = await getExecutionPolicy();
    const userSwitch = await createKillSwitch({ scope: "USER", target: blockedUser.id, reason: "fraud review", note: null, createdBy: blockedUser.id, expiresAt: null });
    createdSwitchIds.push(userSwitch.id);

    expect((await checkExecutionControlPlane({ userId: blockedUser.id, provider: testProvider, marketId, jurisdiction: null }, policy)).allowed).toBe(false);
    expect((await checkExecutionControlPlane({ userId: otherUser.id, provider: testProvider, marketId, jurisdiction: null }, policy)).allowed).toBe(true);
  });

  it("COHORT blocks members of that cohort only", async () => {
    const marketId = await seedMarket();
    const memberUser = await seedUser();
    const nonMemberUser = await seedUser();
    const cohort = await createCohort({
      key: `cohort-${randomUUID()}`,
      name: "Flagged",
      mode: "ALLOWLIST",
      percentage: null,
      rolloutSeed: null,
      providerScope: null,
      jurisdictionScope: null,
      startsAt: null,
      endsAt: null,
      createdBy: memberUser.id,
    });
    createdCohortIds.push(cohort.id);
    await addCohortMember(cohort.id, memberUser.id, memberUser.id);

    const policy = await getExecutionPolicy();
    const cohortSwitch = await createKillSwitch({ scope: "COHORT", target: cohort.key, reason: "cohort review", note: null, createdBy: memberUser.id, expiresAt: null });
    createdSwitchIds.push(cohortSwitch.id);

    expect((await checkExecutionControlPlane({ userId: memberUser.id, provider: testProvider, marketId, jurisdiction: null }, policy)).allowed).toBe(false);
    expect((await checkExecutionControlPlane({ userId: nonMemberUser.id, provider: testProvider, marketId, jurisdiction: null }, policy)).allowed).toBe(true);
  });

  it("precedence: GLOBAL is reported even when a narrower switch also matches", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();
    const policy = await getExecutionPolicy();
    const marketSwitch = await createKillSwitch({ scope: "MARKET", target: marketId, reason: "market issue", note: null, createdBy: user.id, expiresAt: null });
    const globalSwitch = await createKillSwitch({ scope: "GLOBAL", target: null, reason: "global incident", note: null, createdBy: user.id, expiresAt: null });
    createdSwitchIds.push(marketSwitch.id, globalSwitch.id);

    const result = await checkExecutionControlPlane({ userId: user.id, provider: testProvider, marketId, jurisdiction: null }, policy);
    expect(result).toMatchObject({ allowed: false, blockedBySwitch: { scope: "GLOBAL" } });
  });

  it("rollout mode COHORT_RESTRICTED blocks a user who is not in any active cohort", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();
    await admin.from("platform_settings").update({ execution_rollout_mode: "COHORT_RESTRICTED" }).eq("id", true);
    const policy = await getExecutionPolicy();

    const result = await checkExecutionControlPlane({ userId: user.id, provider: testProvider, marketId, jurisdiction: null }, policy);
    expect(result).toEqual({ allowed: false, reason: "ROLLOUT_BLOCKED" });
  });

  it("rollout mode COHORT_RESTRICTED allows a user who IS a member of an active cohort", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();
    const cohort = await createCohort({
      key: `restricted-${randomUUID()}`,
      name: "Restricted rollout",
      mode: "ALLOWLIST",
      percentage: null,
      rolloutSeed: null,
      providerScope: null,
      jurisdictionScope: null,
      startsAt: null,
      endsAt: null,
      createdBy: user.id,
    });
    createdCohortIds.push(cohort.id);
    await addCohortMember(cohort.id, user.id, user.id);
    await admin.from("platform_settings").update({ execution_rollout_mode: "COHORT_RESTRICTED" }).eq("id", true);
    const policy = await getExecutionPolicy();

    const result = await checkExecutionControlPlane({ userId: user.id, provider: testProvider, marketId, jurisdiction: null }, policy);
    expect(result.allowed).toBe(true);
  });
});

describe("execution cohorts (STEP 8/9)", () => {
  it("ALLOWLIST mode: explicit member allowed, non-member denied", async () => {
    const user = await seedUser();
    const nonMember = await seedUser();
    const cohort = await createCohort({
      key: `allow-${randomUUID()}`,
      name: "Allowlist",
      mode: "ALLOWLIST",
      percentage: null,
      rolloutSeed: null,
      providerScope: null,
      jurisdictionScope: null,
      startsAt: null,
      endsAt: null,
      createdBy: user.id,
    });
    createdCohortIds.push(cohort.id);
    await addCohortMember(cohort.id, user.id, user.id);

    expect(await evaluateCohortMembership(cohort, user.id, new Date())).toBe(true);
    expect(await evaluateCohortMembership(cohort, nonMember.id, new Date())).toBe(false);
  });

  it("a disabled cohort has no members, even an explicit one", async () => {
    const user = await seedUser();
    const cohort = await createCohort({
      key: `disabled-${randomUUID()}`,
      name: "Disabled",
      mode: "ALLOWLIST",
      percentage: null,
      rolloutSeed: null,
      providerScope: null,
      jurisdictionScope: null,
      startsAt: null,
      endsAt: null,
      createdBy: user.id,
    });
    createdCohortIds.push(cohort.id);
    await addCohortMember(cohort.id, user.id, user.id);
    await setCohortEnabled(cohort.id, false);

    expect(await evaluateCohortMembership({ ...cohort, enabled: false }, user.id, new Date())).toBe(false);
  });

  it("getUserCohortKeys reflects only currently-enabled, currently-applicable cohorts", async () => {
    const user = await seedUser();
    const cohort = await createCohort({
      key: `keys-${randomUUID()}`,
      name: "Keys test",
      mode: "ALLOWLIST",
      percentage: null,
      rolloutSeed: null,
      providerScope: null,
      jurisdictionScope: null,
      startsAt: null,
      endsAt: null,
      createdBy: user.id,
    });
    createdCohortIds.push(cohort.id);
    await addCohortMember(cohort.id, user.id, user.id);

    expect(await getUserCohortKeys(user.id)).toContain(cohort.key);
    await setCohortEnabled(cohort.id, false);
    expect(await getUserCohortKeys(user.id)).not.toContain(cohort.key);
  });

  it("changing cohort enablement in platform data changes behavior with no source edit", async () => {
    const user = await seedUser();
    const cohort = await createCohort({
      key: `config-${randomUUID()}`,
      name: "Config test",
      mode: "PERCENTAGE",
      percentage: 100,
      rolloutSeed: "fixed-seed",
      providerScope: null,
      jurisdictionScope: null,
      startsAt: null,
      endsAt: null,
      createdBy: user.id,
    });
    createdCohortIds.push(cohort.id);

    expect(await evaluateCohortMembership(cohort, user.id, new Date())).toBe(true);
    const disabled = await setCohortEnabled(cohort.id, false);
    expect(await evaluateCohortMembership(disabled!, user.id, new Date())).toBe(false);
  });
});

describe("execution limits (STEP 12/13)", () => {
  it("PER_ORDER_AMOUNT_CENTS: below the limit is allowed, above is denied", async () => {
    const user = await seedUser();
    const limit = await createLimit({ scope: "USER", target: user.id, limitType: "PER_ORDER_AMOUNT_CENTS", thresholdValue: 1000, windowSeconds: null, createdBy: user.id });
    createdLimitIds.push(limit.id);

    const below = await evaluateExecutionLimits({ userId: user.id, cohortKeys: [], provider: testProvider, jurisdiction: null, requestedAmountCents: 500, now: new Date() });
    expect(below.allowed).toBe(true);

    const above = await evaluateExecutionLimits({ userId: user.id, cohortKeys: [], provider: testProvider, jurisdiction: null, requestedAmountCents: 1500, now: new Date() });
    expect(above.allowed).toBe(false);
    expect(above.violations[0]).toMatchObject({ limitType: "PER_ORDER_AMOUNT_CENTS", thresholdValue: 1000, observedValue: 1500 });
  });

  it("a request exactly at the limit is allowed (the boundary is inclusive)", async () => {
    const user = await seedUser();
    const limit = await createLimit({ scope: "USER", target: user.id, limitType: "PER_ORDER_AMOUNT_CENTS", thresholdValue: 1000, windowSeconds: null, createdBy: user.id });
    createdLimitIds.push(limit.id);

    const atLimit = await evaluateExecutionLimits({ userId: user.id, cohortKeys: [], provider: testProvider, jurisdiction: null, requestedAmountCents: 1000, now: new Date() });
    expect(atLimit.allowed).toBe(true);
  });

  it("DAILY_AMOUNT_CENTS accounts for already-filled order intents today, plus the new request", async () => {
    const user = await seedUser();
    const marketId = await seedMarket();
    await seedFilledOrderIntent(user.id, marketId, 600);

    const limit = await createLimit({ scope: "USER", target: user.id, limitType: "DAILY_AMOUNT_CENTS", thresholdValue: 1000, windowSeconds: null, createdBy: user.id });
    createdLimitIds.push(limit.id);

    const result = await evaluateExecutionLimits({ userId: user.id, cohortKeys: [], provider: testProvider, jurisdiction: null, requestedAmountCents: 500, now: new Date() });
    expect(result.allowed).toBe(false);
    expect(result.violations[0].observedValue).toBe(1100);
  });

  it("DAILY_ORDER_COUNT counts filled orders today, plus the pending one", async () => {
    const user = await seedUser();
    const marketId = await seedMarket();
    await seedFilledOrderIntent(user.id, marketId, 100);
    await seedFilledOrderIntent(user.id, marketId, 100);

    const limit = await createLimit({ scope: "USER", target: user.id, limitType: "DAILY_ORDER_COUNT", thresholdValue: 2, windowSeconds: null, createdBy: user.id });
    createdLimitIds.push(limit.id);

    const result = await evaluateExecutionLimits({ userId: user.id, cohortKeys: [], provider: testProvider, jurisdiction: null, requestedAmountCents: 100, now: new Date() });
    expect(result.allowed).toBe(false);
    expect(result.violations[0].observedValue).toBe(3);
  });

  it("a GLOBAL limit applies to every user", async () => {
    const user = await seedUser();
    const limit = await createLimit({ scope: "GLOBAL", target: null, limitType: "PER_ORDER_AMOUNT_CENTS", thresholdValue: 200, windowSeconds: null, createdBy: user.id });
    createdLimitIds.push(limit.id);

    const result = await evaluateExecutionLimits({ userId: user.id, cohortKeys: [], provider: testProvider, jurisdiction: null, requestedAmountCents: 300, now: new Date() });
    expect(result.allowed).toBe(false);
  });

  it("disabling a limit stops it from being enforced, with no source edit", async () => {
    const user = await seedUser();
    const limit = await createLimit({ scope: "USER", target: user.id, limitType: "PER_ORDER_AMOUNT_CENTS", thresholdValue: 100, windowSeconds: null, createdBy: user.id });
    createdLimitIds.push(limit.id);

    await admin.from("execution_limits").update({ enabled: false }).eq("id", limit.id);
    const result = await evaluateExecutionLimits({ userId: user.id, cohortKeys: [], provider: testProvider, jurisdiction: null, requestedAmountCents: 999999, now: new Date() });
    expect(result.allowed).toBe(true);
  });

  it("a COHORT-scoped limit applies only to a request from a member of that cohort", async () => {
    const user = await seedUser();
    const cohort = await createCohort({
      key: `limit-cohort-${randomUUID()}`,
      name: "Limit cohort",
      mode: "ALLOWLIST",
      percentage: null,
      rolloutSeed: null,
      providerScope: null,
      jurisdictionScope: null,
      startsAt: null,
      endsAt: null,
      createdBy: user.id,
    });
    createdCohortIds.push(cohort.id);
    await addCohortMember(cohort.id, user.id, user.id);
    const limit = await createLimit({ scope: "COHORT", target: cohort.key, limitType: "PER_ORDER_AMOUNT_CENTS", thresholdValue: 300, windowSeconds: null, createdBy: user.id });
    createdLimitIds.push(limit.id);

    const result = await evaluateExecutionLimits({
      userId: user.id,
      cohortKeys: [cohort.key],
      provider: testProvider,
      jurisdiction: null,
      requestedAmountCents: 500,
      now: new Date(),
    });
    expect(result.allowed).toBe(false);
    expect(result.violations[0].scope).toBe("COHORT");
  });
});

describe("execution limits — real requestQuote() denial (control-plane wiring)", () => {
  it("requestQuote() itself returns EXECUTION_DISABLED when a GLOBAL kill switch is active — no live provider call is ever attempted", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();
    const globalSwitch = await createKillSwitch({ scope: "GLOBAL", target: null, reason: "wiring test", note: null, createdBy: user.id, expiresAt: null });
    createdSwitchIds.push(globalSwitch.id);

    const result = await requestQuote(user.id, marketId, "YES", 500);
    expect(result).toEqual({ success: false, reason: "EXECUTION_DISABLED" });
  });
});

describe("provider health / circuit breaker (STEP 14/15)", () => {
  const policy = { failureThreshold: 3, observationWindowSeconds: 60, cooldownSeconds: 1, halfOpenMaxProbes: 1 };

  it("starts CLOSED/HEALTHY for a provider with no recorded history", async () => {
    const health = await getProviderHealth(testProvider);
    expect(health.circuitState).toBe("CLOSED");
    expect(await isProviderCallAllowed(testProvider)).toBe(true);
  });

  it("opens after reaching the configured failure threshold", async () => {
    await recordProviderFailure(testProvider, policy);
    await recordProviderFailure(testProvider, policy);
    expect((await getProviderHealth(testProvider)).circuitState).toBe("CLOSED");
    await recordProviderFailure(testProvider, policy);
    expect((await getProviderHealth(testProvider)).circuitState).toBe("OPEN");
    expect(await isProviderCallAllowed(testProvider)).toBe(false);
  });

  it("transitions to HALF_OPEN and allows exactly one probe after the cooldown elapses", async () => {
    await recordProviderFailure(testProvider, policy);
    await recordProviderFailure(testProvider, policy);
    await recordProviderFailure(testProvider, policy);
    expect((await getProviderHealth(testProvider)).circuitState).toBe("OPEN");

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await isProviderCallAllowed(testProvider)).toBe(true);
    expect((await getProviderHealth(testProvider)).circuitState).toBe("HALF_OPEN");
  });

  it("closes again on a successful probe", async () => {
    await recordProviderFailure(testProvider, policy);
    await recordProviderFailure(testProvider, policy);
    await recordProviderFailure(testProvider, policy);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await isProviderCallAllowed(testProvider);
    await recordProviderSuccess(testProvider);

    const health = await getProviderHealth(testProvider);
    expect(health.circuitState).toBe("CLOSED");
    expect(health.consecutiveFailures).toBe(0);
  });

  it("a failed probe while HALF_OPEN re-opens immediately, without needing the full threshold again", async () => {
    await recordProviderFailure(testProvider, policy);
    await recordProviderFailure(testProvider, policy);
    await recordProviderFailure(testProvider, policy);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await isProviderCallAllowed(testProvider);
    await recordProviderFailure(testProvider, policy);

    expect((await getProviderHealth(testProvider)).circuitState).toBe("OPEN");
  });

  it("manual override disables the provider regardless of circuit state, and re-enabling restores normal evaluation", async () => {
    await setManualProviderOverride({ provider: testProvider, disabled: true, reason: "planned maintenance", setBy: (await seedUser()).id });
    expect(await isProviderCallAllowed(testProvider)).toBe(false);

    const user = await seedUser();
    await setManualProviderOverride({ provider: testProvider, disabled: false, reason: null, setBy: user.id });
    expect(await isProviderCallAllowed(testProvider)).toBe(true);
  });

  it("changing the configured failure threshold changes behavior without a source edit", async () => {
    const looserPolicy = { ...policy, failureThreshold: 10 };
    await recordProviderFailure(testProvider, looserPolicy);
    await recordProviderFailure(testProvider, looserPolicy);
    await recordProviderFailure(testProvider, looserPolicy);
    expect((await getProviderHealth(testProvider)).circuitState).toBe("CLOSED");
  });

  it("decideCallAllowed is a pure function reused identically by isProviderCallAllowed", async () => {
    const health = await getProviderHealth(testProvider);
    const decision = decideCallAllowed(health, new Date());
    expect(await isProviderCallAllowed(testProvider)).toBe(decision.allowed);
  });
});

describe("reconciliation (STEP 21-24)", () => {
  it("IN_SYNC: expected success matches the fixture provider state", async () => {
    const user = await seedUser();
    const marketId = await seedMarket();
    const orderIntentId = await seedFilledOrderIntent(user.id, marketId, 1000);
    const stateSource = createFixtureProviderStateSource({ [orderIntentId]: { outcome: "ACCEPTED", filledAmountCents: 1000 } });

    const record = await reconcileOrderIntent({
      orderIntentId,
      correlationId: null,
      expected: { lifecycleState: "SIMULATED_FILLED", filledAmountCents: 1000 },
      stateSource,
      manualReviewAfterMismatches: 2,
    });
    expect(record.result).toBe("IN_SYNC");
  });

  it("MISMATCH escalates to MANUAL_REVIEW_REQUIRED after the configured consecutive-mismatch threshold", async () => {
    const user = await seedUser();
    const marketId = await seedMarket();
    const orderIntentId = await seedFilledOrderIntent(user.id, marketId, 1000);
    const mismatchSource = createFixtureProviderStateSource({ [orderIntentId]: { outcome: "MISSING" } });

    const first = await reconcileOrderIntent({
      orderIntentId,
      correlationId: null,
      expected: { lifecycleState: "SIMULATED_FILLED", filledAmountCents: 1000 },
      stateSource: mismatchSource,
      manualReviewAfterMismatches: 2,
    });
    expect(first.result).toBe("MISMATCH");

    // A second, DIFFERENT mismatch (different authoritative state) so the
    // idempotency check doesn't short-circuit it as unchanged.
    const secondSource = createFixtureProviderStateSource({ [orderIntentId]: { outcome: "INCONSISTENT" } });
    const second = await reconcileOrderIntent({
      orderIntentId,
      correlationId: null,
      expected: { lifecycleState: "SIMULATED_FILLED", filledAmountCents: 1000 },
      stateSource: secondSource,
      manualReviewAfterMismatches: 2,
    });
    expect(second.result).toBe("MANUAL_REVIEW_REQUIRED");
    expect(second.previousRecordId).toBe(first.id);
  });

  it("is idempotent — reconciling twice with an unchanged authoritative state writes no new row", async () => {
    const user = await seedUser();
    const marketId = await seedMarket();
    const orderIntentId = await seedFilledOrderIntent(user.id, marketId, 1000);
    const stateSource = createFixtureProviderStateSource({ [orderIntentId]: { outcome: "ACCEPTED", filledAmountCents: 1000 } });

    const first = await reconcileOrderIntent({
      orderIntentId,
      correlationId: null,
      expected: { lifecycleState: "SIMULATED_FILLED", filledAmountCents: 1000 },
      stateSource,
      manualReviewAfterMismatches: 2,
    });
    const second = await reconcileOrderIntent({
      orderIntentId,
      correlationId: null,
      expected: { lifecycleState: "SIMULATED_FILLED", filledAmountCents: 1000 },
      stateSource,
      manualReviewAfterMismatches: 2,
    });

    expect(second.id).toBe(first.id);
    const { count } = await admin.from("execution_reconciliation_records").select("id", { count: "exact", head: true }).eq("order_intent_id", orderIntentId);
    expect(count).toBe(1);
  });

  it("preserves prior mismatch evidence — a changed comparison inserts a new row rather than overwriting the old one", async () => {
    const user = await seedUser();
    const marketId = await seedMarket();
    const orderIntentId = await seedFilledOrderIntent(user.id, marketId, 1000);

    const first = await reconcileOrderIntent({
      orderIntentId,
      correlationId: null,
      expected: { lifecycleState: "SIMULATED_FILLED", filledAmountCents: 1000 },
      stateSource: createFixtureProviderStateSource({ [orderIntentId]: { outcome: "MISSING" } }),
      manualReviewAfterMismatches: 5,
    });
    const second = await reconcileOrderIntent({
      orderIntentId,
      correlationId: null,
      expected: { lifecycleState: "SIMULATED_FILLED", filledAmountCents: 1000 },
      stateSource: createFixtureProviderStateSource({ [orderIntentId]: { outcome: "ACCEPTED", filledAmountCents: 1000 } }),
      manualReviewAfterMismatches: 5,
    });

    expect(second.id).not.toBe(first.id);
    expect(second.previousRecordId).toBe(first.id);
    const stillExists = await getLatestReconciliationRecord(orderIntentId);
    expect(stillExists?.id).toBe(second.id);
    const { data: firstStillPresent } = await admin.from("execution_reconciliation_records").select("id, result").eq("id", first.id).single();
    expect(firstStillPresent?.result).toBe("MISMATCH");
  });

  it("PENDING for an unavailable or delayed provider state — never treated as a mismatch", async () => {
    const user = await seedUser();
    const marketId = await seedMarket();
    const orderIntentId = await seedFilledOrderIntent(user.id, marketId, 1000);

    const record = await reconcileOrderIntent({
      orderIntentId,
      correlationId: null,
      expected: { lifecycleState: "CONFIRMED", filledAmountCents: null },
      stateSource: createFixtureProviderStateSource({ [orderIntentId]: { outcome: "UNAVAILABLE" } }),
      manualReviewAfterMismatches: 2,
    });
    expect(record.result).toBe("PENDING");
  });
});

describe("execution audit events (STEP 17/18)", () => {
  it("is append-only — no update or delete privilege exists for service_role", async () => {
    await recordAuditEvent({ eventType: "QUOTE_REQUESTED", actorUserId: null });
    const events = await listRecentAuditEvents(1);
    expect(events.length).toBeGreaterThan(0);

    const { error: updateError } = await admin.from("execution_audit_events").update({ severity: "CRITICAL" }).eq("id", events[0].id);
    expect(updateError).not.toBeNull();
    const { error: deleteError } = await admin.from("execution_audit_events").delete().eq("id", events[0].id);
    expect(deleteError).not.toBeNull();
  });

  it("threads a correlation id across the events for one journey", async () => {
    const correlationId = randomUUID();
    await recordAuditEvent({ eventType: "QUOTE_REQUESTED", correlationId });
    await recordAuditEvent({ eventType: "QUOTE_CREATED", correlationId });
    await recordAuditEvent({ eventType: "ORDER_INTENT_CONFIRMED", correlationId });

    const events = await listAuditEventsByCorrelationId(correlationId);
    expect(events.map((e) => e.eventType)).toEqual(["QUOTE_REQUESTED", "QUOTE_CREATED", "ORDER_INTENT_CONFIRMED"]);
  });

  it("denies a direct anon read", async () => {
    const anon = getTestAnonClient();
    const { error } = await anon.from("execution_audit_events").select("*");
    expect(error).not.toBeNull();
  });

  it("a real requestQuote() journey emits QUOTE_REQUESTED and EXECUTION_ELIGIBILITY_DENIED events sharing one correlation id", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();
    const globalSwitch = await createKillSwitch({ scope: "GLOBAL", target: null, reason: "audit trace test", note: null, createdBy: user.id, expiresAt: null });
    createdSwitchIds.push(globalSwitch.id);

    await requestQuote(user.id, marketId, "YES", 500);

    const { data: recent } = await admin
      .from("execution_audit_events")
      .select("event_type, correlation_id")
      .eq("actor_user_id", user.id)
      .order("occurred_at", { ascending: true });
    const types = (recent ?? []).map((r) => r.event_type);
    expect(types).toContain("QUOTE_REQUESTED");
    expect(types).toContain("EXECUTION_ELIGIBILITY_DENIED");
    const correlationIds = new Set((recent ?? []).map((r) => r.correlation_id));
    expect(correlationIds.size).toBe(1);
  });
});

describe("Milestone 5.5 admin capabilities — default policy and no direct role coupling", () => {
  const CAPABILITIES = ["view_execution_operations", "manage_execution_controls", "manage_execution_rollout"] as const;

  it("every new capability defaults to super_admin only", async () => {
    for (const capability of CAPABILITIES) {
      const policy = await loadCapabilityPolicy(capability);
      expect(policy).toEqual({ capability, allowedRoles: ["super_admin"] });
      expect(await roleHasCapability("super_admin", capability)).toBe(true);
      expect(await roleHasCapability("admin", capability)).toBe(false);
      expect(await roleHasCapability("player", capability)).toBe(false);
    }
  });

  it("the execution-operations admin page contains no direct role coupling", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const source = await readFile(path.join(repoRoot, "app/(admin)/admin/execution-operations/page.tsx"), "utf-8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "names a role").not.toMatch(/["']super_admin["']|["']admin["']|["']player["']/);
    expect(code, "calls an auth helper directly").not.toMatch(/requireSuperAdmin|requireAdminOrAbove|isSuperAdmin|isAdminOrAbove/);
    expect(code, "gates through the capability boundary").toMatch(/requireExecutionOperationsViewer/);
  });
});
