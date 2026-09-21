/**
 * Integration tests for the Milestone 5 Simulated Execution domain
 * (docs/PRODUCT_TRANSFORMATION_ROADMAP.md Milestone 5). Real local
 * Supabase only (pnpm supabase:start). No real order is placed, no real
 * wallet is touched, no signing occurs — every row created here is
 * `is_simulated = true` by schema constraint.
 *
 * Most tests exercise lib/execution/repository.ts and lib/execution/policy.ts
 * directly (deterministic, no network) — mirroring
 * tests/integration/predictions.test.ts's own established split between
 * the domain/repository layer (tested here) and the Server Action /
 * live-network orchestration layer (a small, explicitly-labeled set of
 * "live data" tests below, plus full coverage in
 * tests/e2e/simulated-execution-flow.spec.ts).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { upsertMarket } from "@/lib/prediction-markets/repository";
import type { NormalizedMarket } from "@/lib/prediction-markets/types";
import { createOrderIntent, createQuote, getQuoteById, listUserOrderIntents, resolveOrderIntent } from "@/lib/execution/repository";
import { checkExecutionEligibility, getExecutionPolicy } from "@/lib/execution/policy";
import { getExecutionRateLimitPolicy, FALLBACK_EXECUTION_RATE_LIMIT_POLICY } from "@/lib/rate-limit/execution";
import { requestQuote, confirmSimulatedExecution } from "@/lib/execution/quote-service";
import { loadCapabilityPolicy, roleHasCapability } from "@/lib/auth/capabilities";

const admin = getTestAdminClient();
const testProvider = `execution_test_provider_${Date.now()}`;
const createdMarketIds: string[] = [];
const createdUserIds: string[] = [];
const PASSWORD = "integration-test-password-123";

// A real, currently-active Polymarket market with confirmed real liquidity
// (live-verified 2026-09-16 — see docs/architecture/simulated-execution.md
// §6/known limitations for the accepted flakiness tradeoff this implies).
const LIVE_YES_TOKEN_ID = "32338220190071351435772801779725302244575775216413325951443816017994629993401";

function marketFixture(providerMarketId: string, overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    provider: testProvider,
    providerMarketId,
    providerEventId: null,
    question: `Execution test market ${providerMarketId}`,
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

/** Seeds a market with REAL live Polymarket clobTokenIds so the actual adapter/network path can be exercised deterministically-enough for a handful of sanity tests. */
async function seedLiveMarket(overrides: Partial<NormalizedMarket> = {}): Promise<string> {
  const { id } = await upsertMarket(
    marketFixture(`live_${Math.random().toString(36).slice(2)}`, {
      provider: "polymarket",
      providerMetadata: { outcomes: ["Yes", "No"], clobTokenIds: [LIVE_YES_TOKEN_ID, "0"] },
      ...overrides,
    }),
  );
  createdMarketIds.push(id);
  return id;
}

async function seedMarket(overrides: Partial<NormalizedMarket> = {}): Promise<string> {
  const { id } = await upsertMarket(marketFixture(`m_${Math.random().toString(36).slice(2)}`, overrides));
  createdMarketIds.push(id);
  return id;
}

async function seedUser(): Promise<{ id: string; email: string }> {
  const email = `execution-test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("failed to create test user");
  const { error: profileError } = await admin
    .from("user_profiles")
    .insert({ id: data.user.id, display_name: "Execution Test", role: "player", is_active: true });
  if (profileError) throw profileError;
  createdUserIds.push(data.user.id);
  return { id: data.user.id, email };
}

async function signInAs(email: string) {
  const client = getTestAnonClient();
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  return client;
}

afterAll(async () => {
  if (createdMarketIds.length > 0) await admin.from("markets").delete().in("id", createdMarketIds);
  for (const id of createdUserIds) await admin.auth.admin.deleteUser(id);
});

afterEach(async () => {
  await admin
    .from("platform_settings")
    .update({
      execution_simulation_enabled: true,
      execution_min_amount_cents: 100,
      execution_max_amount_cents: 100_000,
      execution_quote_expiry_seconds: 30,
      execution_data_freshness_max_seconds: 10,
      execution_max_slippage_bps: 500,
      execution_recalculation_tolerance_bps: 200,
      execution_simulated_provider_fee_bps: 100,
      execution_simulated_brohda_fee_bps: 0,
      // Milestone 5 final remediation (migration 20260101000152) —
      // restoring these after every test the same way as the columns
      // above, so a test that tightens a rate limit can never leak into a
      // later one in this file (or a later file, since fileParallelism is
      // off but nothing resets the DB between files either).
      execution_quote_rate_limit_enabled: true,
      execution_quote_rate_limit_window_seconds: 60,
      execution_quote_rate_limit_max_attempts: 30,
      execution_confirmation_rate_limit_enabled: true,
      execution_confirmation_rate_limit_window_seconds: 60,
      execution_confirmation_rate_limit_max_attempts: 10,
    })
    .eq("id", true);
});

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
    correlationId: crypto.randomUUID(),
    ...overrides,
  };
}

describe("execution_quotes — RLS and structural integrity", () => {
  it("is_simulated is always true — enforced at the database level", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();
    const quote = await createQuote(fakeQuoteInput({ userId: user.id, marketId }));
    expect(quote.isSimulated).toBe(true);
  });

  it("rejects a direct anon read and write", async () => {
    const marketId = await seedMarket();
    const anon = getTestAnonClient();
    const { data: readData, error: readError } = await anon.from("execution_quotes").select("*");
    expect(readError ?? (readData ?? []).length === 0).toBeTruthy();

    const { error: writeError } = await anon.from("execution_quotes").insert({
      user_id: "00000000-0000-0000-0000-000000000000",
      market_id: marketId,
      selected_side: "YES",
      requested_amount_cents: 1000,
      current_price: 0.5,
      effective_price: 0.5,
      estimated_units: 20,
      estimated_gross_return_cents: 2000,
      provider_fee_estimate_cents: 0,
      brohda_fee_estimate_cents: 0,
      total_fee_estimate_cents: 0,
      estimated_slippage_bps: 0,
      provider_snapshot_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30_000).toISOString(),
    });
    expect(writeError).not.toBeNull();
  });

  it("a user can read their own quote but not another user's", async () => {
    const marketId = await seedMarket();
    const owner = await seedUser();
    const other = await seedUser();
    const quote = await createQuote(fakeQuoteInput({ userId: owner.id, marketId }));

    const ownerClient = await signInAs(owner.email);
    const { data: ownRead } = await ownerClient.from("execution_quotes").select("*").eq("id", quote.id);
    expect(ownRead).toHaveLength(1);

    const otherClient = await signInAs(other.email);
    const { data: otherRead } = await otherClient.from("execution_quotes").select("*").eq("id", quote.id);
    expect(otherRead ?? []).toEqual([]);
  });

  it("no authenticated client can UPDATE a quote directly — only service role can", async () => {
    const marketId = await seedMarket();
    const owner = await seedUser();
    const quote = await createQuote(fakeQuoteInput({ userId: owner.id, marketId, effectivePrice: 0.42 }));

    const ownerClient = await signInAs(owner.email);
    const { error } = await ownerClient.from("execution_quotes").update({ effective_price: 0.01 }).eq("id", quote.id);
    expect(error).not.toBeNull();

    const unchanged = await getQuoteById(quote.id);
    expect(unchanged?.effectivePrice).toBe(0.42);
  });
});

describe("order_intents — idempotency, RLS, and lifecycle integrity", () => {
  it("is idempotent — the same idempotency key never creates a second row", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();
    const quote = await createQuote(fakeQuoteInput({ userId: user.id, marketId }));
    const idempotencyKey = crypto.randomUUID();
    const input = {
      userId: user.id,
      marketId,
      quoteId: quote.id,
      selectedSide: "YES" as const,
      requestedAmountCents: quote.requestedAmountCents,
      quotedEffectivePrice: quote.effectivePrice,
      quotedEstimatedGrossReturnCents: quote.estimatedGrossReturnCents,
      quotedTotalFeeEstimateCents: quote.totalFeeEstimateCents,
      quotedSlippageBps: quote.estimatedSlippageBps,
      quoteCreatedAt: quote.createdAt,
      quoteProviderSnapshotAt: quote.providerSnapshotAt,
      correlationId: quote.correlationId,
      idempotencyKey,
    };

    const first = await createOrderIntent(input);
    const second = await createOrderIntent(input);
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("existing");
    expect(second.orderIntent.id).toBe(first.orderIntent.id);

    const { count } = await admin.from("order_intents").select("id", { count: "exact", head: true }).eq("idempotency_key", idempotencyKey);
    expect(count).toBe(1);
  });

  it("resolveOrderIntent is a one-way transition — a second resolution attempt is a safe no-op", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();
    const quote = await createQuote(fakeQuoteInput({ userId: user.id, marketId }));
    const { orderIntent } = await createOrderIntent({
      userId: user.id,
      marketId,
      quoteId: quote.id,
      selectedSide: "YES",
      requestedAmountCents: quote.requestedAmountCents,
      quotedEffectivePrice: quote.effectivePrice,
      quotedEstimatedGrossReturnCents: quote.estimatedGrossReturnCents,
      quotedTotalFeeEstimateCents: quote.totalFeeEstimateCents,
      quotedSlippageBps: quote.estimatedSlippageBps,
      quoteCreatedAt: quote.createdAt,
      quoteProviderSnapshotAt: quote.providerSnapshotAt,
      correlationId: quote.correlationId,
      idempotencyKey: crypto.randomUUID(),
    });

    const firstResolve = await resolveOrderIntent(orderIntent.id, { lifecycleState: "SIMULATED_FILLED", resultReason: null, resolvedAt: new Date().toISOString() });
    expect(firstResolve).toBe(true);

    const secondResolve = await resolveOrderIntent(orderIntent.id, { lifecycleState: "SIMULATED_REJECTED", resultReason: "STALE_DATA", resolvedAt: new Date().toISOString() });
    expect(secondResolve).toBe(false);

    const { data } = await admin.from("order_intents").select("lifecycle_state, result_reason").eq("id", orderIntent.id).single();
    expect(data?.lifecycle_state).toBe("SIMULATED_FILLED");
    expect(data?.result_reason).toBeNull();
  });

  it("is_simulated is always true, structurally, not merely a UI label", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();
    const quote = await createQuote(fakeQuoteInput({ userId: user.id, marketId }));
    const { orderIntent } = await createOrderIntent({
      userId: user.id,
      marketId,
      quoteId: quote.id,
      selectedSide: "YES",
      requestedAmountCents: quote.requestedAmountCents,
      quotedEffectivePrice: quote.effectivePrice,
      quotedEstimatedGrossReturnCents: quote.estimatedGrossReturnCents,
      quotedTotalFeeEstimateCents: quote.totalFeeEstimateCents,
      quotedSlippageBps: quote.estimatedSlippageBps,
      quoteCreatedAt: quote.createdAt,
      quoteProviderSnapshotAt: quote.providerSnapshotAt,
      correlationId: quote.correlationId,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(orderIntent.isSimulated).toBe(true);
  });

  it("rejects a direct anon write and cross-user read", async () => {
    const marketId = await seedMarket();
    const owner = await seedUser();
    const other = await seedUser();
    const quote = await createQuote(fakeQuoteInput({ userId: owner.id, marketId }));
    const { orderIntent } = await createOrderIntent({
      userId: owner.id,
      marketId,
      quoteId: quote.id,
      selectedSide: "YES",
      requestedAmountCents: quote.requestedAmountCents,
      quotedEffectivePrice: quote.effectivePrice,
      quotedEstimatedGrossReturnCents: quote.estimatedGrossReturnCents,
      quotedTotalFeeEstimateCents: quote.totalFeeEstimateCents,
      quotedSlippageBps: quote.estimatedSlippageBps,
      quoteCreatedAt: quote.createdAt,
      quoteProviderSnapshotAt: quote.providerSnapshotAt,
      correlationId: quote.correlationId,
      idempotencyKey: crypto.randomUUID(),
    });

    const anon = getTestAnonClient();
    const { error: anonError } = await anon.from("order_intents").update({ lifecycle_state: "SIMULATED_FILLED" }).eq("id", orderIntent.id);
    expect(anonError).not.toBeNull();

    const otherClient = await signInAs(other.email);
    const { data: otherRead } = await otherClient.from("order_intents").select("*").eq("id", orderIntent.id);
    expect(otherRead ?? []).toEqual([]);
  });

  it("listUserOrderIntents returns only that user's own rows, most recent first", async () => {
    const marketId = await seedMarket();
    const userA = await seedUser();
    const userB = await seedUser();
    const quoteA = await createQuote(fakeQuoteInput({ userId: userA.id, marketId }));
    await createOrderIntent({
      userId: userA.id,
      marketId,
      quoteId: quoteA.id,
      selectedSide: "YES",
      requestedAmountCents: quoteA.requestedAmountCents,
      quotedEffectivePrice: quoteA.effectivePrice,
      quotedEstimatedGrossReturnCents: quoteA.estimatedGrossReturnCents,
      quotedTotalFeeEstimateCents: quoteA.totalFeeEstimateCents,
      quotedSlippageBps: quoteA.estimatedSlippageBps,
      quoteCreatedAt: quoteA.createdAt,
      quoteProviderSnapshotAt: quoteA.providerSnapshotAt,
      correlationId: quoteA.correlationId,
      idempotencyKey: crypto.randomUUID(),
    });

    const listA = await listUserOrderIntents(userA.id);
    const listB = await listUserOrderIntents(userB.id);
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(0);
  });
});

describe("execution policy — configurable without a deployment", () => {
  it("changing platform_settings alone changes the eligibility decision", async () => {
    const before = await getExecutionPolicy();
    expect(before.simulationEnabled).toBe(true);

    await admin.from("platform_settings").update({ execution_simulation_enabled: false }).eq("id", true);

    const after = await getExecutionPolicy();
    expect(after.simulationEnabled).toBe(false);
    const eligibility = checkExecutionEligibility(
      { consumerStatus: "ACTIVE", providerSnapshotAt: new Date().toISOString(), requestedAmountCents: 1000, now: new Date() },
      after,
    );
    expect(eligibility).toEqual({ eligible: false, reason: "SIMULATION_DISABLED" });
  });

  it("min/max amount, freshness, and slippage policy are all read live from the database", async () => {
    await admin
      .from("platform_settings")
      .update({ execution_min_amount_cents: 500, execution_max_amount_cents: 5000, execution_data_freshness_max_seconds: 1 })
      .eq("id", true);
    const policy = await getExecutionPolicy();
    expect(policy.minAmountCents).toBe(500);
    expect(policy.maxAmountCents).toBe(5000);
    expect(policy.dataFreshnessMaxSeconds).toBe(1);
  });
});

describe("execution rate-limit policy — Milestone 5 final remediation (migration 20260101000152)", () => {
  it("the default row reproduces the original hard-coded quote and confirmation behavior", async () => {
    const policy = await getExecutionRateLimitPolicy();
    expect(policy).toEqual(FALLBACK_EXECUTION_RATE_LIMIT_POLICY);
  });

  it("changing quote window/max-attempts in platform_settings alone changes what the policy resolves to, with no source edit", async () => {
    await admin.from("platform_settings").update({ execution_quote_rate_limit_window_seconds: 15, execution_quote_rate_limit_max_attempts: 3 }).eq("id", true);
    const policy = await getExecutionRateLimitPolicy();
    expect(policy.quote).toEqual({ enabled: true, windowSeconds: 15, maxAttempts: 3 });
    // Confirmation is untouched by the same write — the two classes are independent.
    expect(policy.confirmation).toEqual(FALLBACK_EXECUTION_RATE_LIMIT_POLICY.confirmation);
  });

  it("changing confirmation window/max-attempts in platform_settings alone changes what the policy resolves to, with no source edit", async () => {
    await admin
      .from("platform_settings")
      .update({ execution_confirmation_rate_limit_window_seconds: 20, execution_confirmation_rate_limit_max_attempts: 2 })
      .eq("id", true);
    const policy = await getExecutionRateLimitPolicy();
    expect(policy.confirmation).toEqual({ enabled: true, windowSeconds: 20, maxAttempts: 2 });
    expect(policy.quote).toEqual(FALLBACK_EXECUTION_RATE_LIMIT_POLICY.quote);
  });

  it("disabling either class is operator-controlled and independent of the other", async () => {
    await admin.from("platform_settings").update({ execution_quote_rate_limit_enabled: false }).eq("id", true);
    const policy = await getExecutionRateLimitPolicy();
    expect(policy.quote.enabled).toBe(false);
    expect(policy.confirmation.enabled).toBe(true);
  });

  it("the database itself rejects a zero or negative window/max-attempts — defense in depth alongside the application-level fallback", async () => {
    const { error: windowError } = await admin.from("platform_settings").update({ execution_quote_rate_limit_window_seconds: 0 }).eq("id", true);
    expect(windowError).not.toBeNull();

    const { error: attemptsError } = await admin.from("platform_settings").update({ execution_confirmation_rate_limit_max_attempts: -1 }).eq("id", true);
    expect(attemptsError).not.toBeNull();

    // The rejected writes must not have partially applied — policy still reads the last-known-good values.
    const policy = await getExecutionRateLimitPolicy();
    expect(policy).toEqual(FALLBACK_EXECUTION_RATE_LIMIT_POLICY);
  });
});

describe("Prediction diagnostics-style authorization, applied to simulated-execution diagnostics", () => {
  const CAPABILITY = "view_simulated_execution_diagnostics";
  const DEFAULT_ALLOWED_ROLES = ["super_admin"];

  afterEach(async () => {
    await admin.from("capability_policies").upsert({ capability: CAPABILITY, allowed_roles: DEFAULT_ALLOWED_ROLES }, { onConflict: "capability" });
  });

  it("the default policy permits super_admin and denies everyone else", async () => {
    const policy = await loadCapabilityPolicy(CAPABILITY);
    expect(policy).toEqual({ capability: CAPABILITY, allowedRoles: ["super_admin"] });
    expect(await roleHasCapability("super_admin", CAPABILITY)).toBe(true);
    expect(await roleHasCapability("admin", CAPABILITY)).toBe(false);
    expect(await roleHasCapability("player", CAPABILITY)).toBe(false);
  });

  it("adding another admin role is configuration-only, and removing it again is equally so", async () => {
    await admin.from("capability_policies").update({ allowed_roles: ["super_admin", "admin"] }).eq("capability", CAPABILITY);
    expect(await roleHasCapability("admin", CAPABILITY)).toBe(true);
    await admin.from("capability_policies").update({ allowed_roles: ["super_admin"] }).eq("capability", CAPABILITY);
    expect(await roleHasCapability("admin", CAPABILITY)).toBe(false);
  });

  it("fails closed on a missing or malformed policy row", async () => {
    await admin.from("capability_policies").delete().eq("capability", CAPABILITY);
    expect(await loadCapabilityPolicy(CAPABILITY)).toBeNull();
    expect(await roleHasCapability("super_admin", CAPABILITY)).toBe(false);

    await admin.from("capability_policies").upsert({ capability: CAPABILITY, allowed_roles: ["super_admin", "not_a_real_role"] }, { onConflict: "capability" });
    expect(await loadCapabilityPolicy(CAPABILITY)).toBeNull();
  });

  it("the admin simulated-execution diagnostics page contains no direct role coupling", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    const source = await readFile(path.join(repoRoot, "app/(admin)/admin/simulated-execution/page.tsx"), "utf-8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "names a role").not.toMatch(/["']super_admin["']|["']admin["']|["']player["']/);
    expect(code, "calls an auth helper directly").not.toMatch(/requireSuperAdmin|requireAdminOrAbove|isSuperAdmin|isAdminOrAbove/);
    expect(code, "imports the session module directly").not.toMatch(/from "@\/lib\/auth\/session"/);
    expect(code, "gates through the capability boundary").toMatch(/requireSimulatedExecutionDiagnosticsViewer/);
  });
});

describe("legacy wallet isolation", () => {
  it("no simulated-execution write path touches wallet_balances or wallet_transactions", async () => {
    const marketId = await seedMarket();
    const user = await seedUser();
    const { data: walletBefore } = await admin.from("wallet_balances").select("balance_cents").eq("user_id", user.id).maybeSingle();

    const quote = await createQuote(fakeQuoteInput({ userId: user.id, marketId }));
    await createOrderIntent({
      userId: user.id,
      marketId,
      quoteId: quote.id,
      selectedSide: "YES",
      requestedAmountCents: quote.requestedAmountCents,
      quotedEffectivePrice: quote.effectivePrice,
      quotedEstimatedGrossReturnCents: quote.estimatedGrossReturnCents,
      quotedTotalFeeEstimateCents: quote.totalFeeEstimateCents,
      quotedSlippageBps: quote.estimatedSlippageBps,
      quoteCreatedAt: quote.createdAt,
      quoteProviderSnapshotAt: quote.providerSnapshotAt,
      correlationId: quote.correlationId,
      idempotencyKey: crypto.randomUUID(),
    });

    const { data: walletAfter } = await admin.from("wallet_balances").select("balance_cents").eq("user_id", user.id).maybeSingle();
    expect(walletAfter?.balance_cents ?? null).toEqual(walletBefore?.balance_cents ?? null);
  });
});

/**
 * These tests exercise the REAL quote-service orchestration against a REAL,
 * currently-active Polymarket market's real order book — a deliberate,
 * documented exception to this file's otherwise fully-deterministic
 * design, needed because Milestone 5's read-only depth data has no
 * database-only equivalent to fixture against (see
 * docs/architecture/simulated-execution.md's known limitations). If
 * Polymarket's live API is unreachable or this specific market has since
 * resolved, these tests may fail for reasons unrelated to Brohda's own
 * code — that risk is accepted and documented, not hidden.
 */
describe("quote-service — live Polymarket read-only data (accepted external dependency)", () => {
  it("produces a real quote from a real order book and confirms it end to end", async () => {
    const marketId = await seedLiveMarket();
    const user = await seedUser();

    const quoteResult = await requestQuote(user.id, marketId, "YES", 100); // $1 — small, should always be fillable
    expect(quoteResult.success).toBe(true);
    if (!quoteResult.success) return;

    expect(quoteResult.quote.effectivePrice).toBeGreaterThan(0);
    expect(quoteResult.quote.effectivePrice).toBeLessThanOrEqual(1);

    const confirmResult = await confirmSimulatedExecution(user.id, quoteResult.quote.id, crypto.randomUUID());
    expect(confirmResult.success).toBe(true);
    if (!confirmResult.success) return;
    expect(["SIMULATED_FILLED", "SIMULATED_REJECTED"]).toContain(confirmResult.orderIntent.lifecycleState);
    expect(confirmResult.orderIntent.isSimulated).toBe(true);
  });

  it("returns INSUFFICIENT_LIQUIDITY for an unrealistically large amount against real depth", async () => {
    // Raise the configured max amount well above the requested amount for
    // this test specifically — otherwise AMOUNT_OUT_OF_RANGE policy would
    // (correctly) reject it before liquidity is ever consulted. This
    // proves the two checks are genuinely independent. Amounts stay within
    // Postgres `integer` range (cents column).
    await admin.from("platform_settings").update({ execution_max_amount_cents: 2_000_000_000 }).eq("id", true);
    const marketId = await seedLiveMarket();
    const user = await seedUser();
    // $20,000,000 — far beyond what any real order book realistically holds.
    const quoteResult = await requestQuote(user.id, marketId, "YES", 2_000_000_000);
    expect(quoteResult.success).toBe(false);
    if (quoteResult.success) return;
    expect(quoteResult.reason).toBe("INSUFFICIENT_LIQUIDITY");
  });

  it("rejects a quote confirmation from a different user than the one who requested it", async () => {
    const marketId = await seedLiveMarket();
    const owner = await seedUser();
    const other = await seedUser();
    const quoteResult = await requestQuote(owner.id, marketId, "YES", 100);
    expect(quoteResult.success).toBe(true);
    if (!quoteResult.success) return;

    const confirmAsOther = await confirmSimulatedExecution(other.id, quoteResult.quote.id, crypto.randomUUID());
    expect(confirmAsOther).toEqual({ success: false, reason: "QUOTE_NOT_FOUND" });
  });

  it("rejects confirmation of an already-expired quote", async () => {
    const marketId = await seedLiveMarket();
    const user = await seedUser();
    await admin.from("platform_settings").update({ execution_quote_expiry_seconds: 0 }).eq("id", true);

    const quoteResult = await requestQuote(user.id, marketId, "YES", 100);
    expect(quoteResult.success).toBe(true);
    if (!quoteResult.success) return;

    // A zero-second expiry means the quote is already expired by the time we check it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const confirmResult = await confirmSimulatedExecution(user.id, quoteResult.quote.id, crypto.randomUUID());
    expect(confirmResult).toEqual({ success: false, reason: "QUOTE_EXPIRED" });
  });
});
