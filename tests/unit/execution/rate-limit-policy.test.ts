import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Milestone 5 final remediation: the quote/confirmation rate-limit
 * window/max-attempts values used to be hard-coded constants in
 * lib/rate-limit/execution.ts. This file proves the replacement —
 * getExecutionRateLimitPolicy, reading `platform_settings` (migration
 * 20260101000152) — resolves correctly, independently per class, and
 * fails safely (never fail-open for confirmation) on missing or malformed
 * configuration. checkExecutionQuoteRateLimit/checkExecutionConfirmationRateLimit
 * themselves need a real Next.js request scope (they call
 * lib/supabase/server's cookie-based createClient) and so are exercised
 * end-to-end in tests/e2e/simulated-execution-flow.spec.ts instead — the
 * same split this codebase already uses for every other Server-Action-only
 * code path (see tests/unit/enter-pool-action.test.ts's own comment).
 */

let singleResult: { data: Record<string, unknown> | null } = { data: null };

const singleMock = vi.fn(() => Promise.resolve(singleResult));
const eqMock = vi.fn(() => ({ single: singleMock }));
const selectMock = vi.fn(() => ({ eq: eqMock }));
const fromMock = vi.fn(() => ({ select: selectMock }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

// getExecutionRateLimitPolicy never touches either of these, but the
// module also exports checkExecutionQuoteRateLimit/
// checkExecutionConfirmationRateLimit, which import them at module scope —
// mock them out so importing the module doesn't pull in next/headers.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/rate-limit/check", () => ({ checkRateLimit: vi.fn() }));

import { getExecutionRateLimitPolicy, FALLBACK_EXECUTION_RATE_LIMIT_POLICY } from "@/lib/rate-limit/execution";

function fullRow(overrides: Record<string, unknown> = {}) {
  return {
    execution_quote_rate_limit_enabled: true,
    execution_quote_rate_limit_window_seconds: 60,
    execution_quote_rate_limit_max_attempts: 30,
    execution_confirmation_rate_limit_enabled: true,
    execution_confirmation_rate_limit_window_seconds: 60,
    execution_confirmation_rate_limit_max_attempts: 10,
    ...overrides,
  };
}

describe("getExecutionRateLimitPolicy", () => {
  beforeEach(() => {
    singleResult = { data: null };
  });

  it("default configured quote rate limit reproduces the original hard-coded behavior", async () => {
    singleResult = { data: fullRow() };
    const policy = await getExecutionRateLimitPolicy();
    expect(policy.quote).toEqual({ enabled: true, windowSeconds: 60, maxAttempts: 30 });
  });

  it("default configured confirmation rate limit reproduces the original hard-coded behavior", async () => {
    singleResult = { data: fullRow() };
    const policy = await getExecutionRateLimitPolicy();
    expect(policy.confirmation).toEqual({ enabled: true, windowSeconds: 60, maxAttempts: 10 });
  });

  it("changing quote max attempts is reflected with no source edit", async () => {
    singleResult = { data: fullRow({ execution_quote_rate_limit_max_attempts: 5 }) };
    const policy = await getExecutionRateLimitPolicy();
    expect(policy.quote.maxAttempts).toBe(5);
  });

  it("changing quote window is reflected with no source edit", async () => {
    singleResult = { data: fullRow({ execution_quote_rate_limit_window_seconds: 120 }) };
    const policy = await getExecutionRateLimitPolicy();
    expect(policy.quote.windowSeconds).toBe(120);
  });

  it("changing confirmation max attempts is reflected with no source edit", async () => {
    singleResult = { data: fullRow({ execution_confirmation_rate_limit_max_attempts: 2 }) };
    const policy = await getExecutionRateLimitPolicy();
    expect(policy.confirmation.maxAttempts).toBe(2);
  });

  it("changing confirmation window is reflected with no source edit", async () => {
    singleResult = { data: fullRow({ execution_confirmation_rate_limit_window_seconds: 15 }) };
    const policy = await getExecutionRateLimitPolicy();
    expect(policy.confirmation.windowSeconds).toBe(15);
  });

  it("quote and confirmation policies are resolved independently of each other", async () => {
    singleResult = {
      data: fullRow({
        execution_quote_rate_limit_enabled: false,
        execution_quote_rate_limit_window_seconds: 10,
        execution_quote_rate_limit_max_attempts: 1,
        execution_confirmation_rate_limit_enabled: true,
        execution_confirmation_rate_limit_window_seconds: 999,
        execution_confirmation_rate_limit_max_attempts: 999,
      }),
    };
    const policy = await getExecutionRateLimitPolicy();
    expect(policy.quote).toEqual({ enabled: false, windowSeconds: 10, maxAttempts: 1 });
    expect(policy.confirmation).toEqual({ enabled: true, windowSeconds: 999, maxAttempts: 999 });
  });

  describe("malformed configuration fails safely", () => {
    it("falls back to the documented defaults when platform_settings can't be read at all", async () => {
      singleResult = { data: null };
      const policy = await getExecutionRateLimitPolicy();
      expect(policy).toEqual(FALLBACK_EXECUTION_RATE_LIMIT_POLICY);
    });

    it("a non-boolean enabled flag falls back to the default for that class, not to disabled", async () => {
      singleResult = { data: fullRow({ execution_quote_rate_limit_enabled: "yes", execution_confirmation_rate_limit_enabled: null }) };
      const policy = await getExecutionRateLimitPolicy();
      expect(policy.quote.enabled).toBe(FALLBACK_EXECUTION_RATE_LIMIT_POLICY.quote.enabled);
      expect(policy.confirmation.enabled).toBe(FALLBACK_EXECUTION_RATE_LIMIT_POLICY.confirmation.enabled);
    });

    it("a zero or negative window/max-attempts falls back rather than silently breaking enforcement", async () => {
      singleResult = { data: fullRow({ execution_quote_rate_limit_window_seconds: 0, execution_quote_rate_limit_max_attempts: -5 }) };
      const policy = await getExecutionRateLimitPolicy();
      expect(policy.quote.windowSeconds).toBe(FALLBACK_EXECUTION_RATE_LIMIT_POLICY.quote.windowSeconds);
      expect(policy.quote.maxAttempts).toBe(FALLBACK_EXECUTION_RATE_LIMIT_POLICY.quote.maxAttempts);
    });

    it("a non-numeric window/max-attempts falls back", async () => {
      singleResult = { data: fullRow({ execution_quote_rate_limit_window_seconds: "not-a-number", execution_quote_rate_limit_max_attempts: null }) };
      const policy = await getExecutionRateLimitPolicy();
      expect(policy.quote).toEqual(FALLBACK_EXECUTION_RATE_LIMIT_POLICY.quote);
    });

    it("confirmation never becomes fail-open just because its row is missing or malformed", async () => {
      singleResult = { data: null };
      const policy = await getExecutionRateLimitPolicy();
      expect(policy.confirmation.enabled).toBe(true);
      expect(policy.confirmation.maxAttempts).toBeGreaterThan(0);
      expect(policy.confirmation.windowSeconds).toBeGreaterThan(0);

      singleResult = { data: fullRow({ execution_confirmation_rate_limit_enabled: "not-a-boolean", execution_confirmation_rate_limit_max_attempts: -1 }) };
      const policyFromMalformedRow = await getExecutionRateLimitPolicy();
      expect(policyFromMalformedRow.confirmation.enabled).toBe(true);
      expect(policyFromMalformedRow.confirmation.maxAttempts).toBeGreaterThan(0);
    });
  });
});
