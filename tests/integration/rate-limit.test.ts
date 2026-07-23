/**
 * Integration tests for the shared rate-limiting mechanism (spec §19:
 * "login, entry, share-link resolution") backing `lib/rate-limit/*.ts`.
 * Run with: pnpm test:integration (requires `pnpm supabase:start`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const createdIdentifiers: string[] = [];

function checkRateLimit(identifier: string, windowSeconds: number, maxAttempts: number) {
  createdIdentifiers.push(identifier);
  return admin.rpc("check_and_increment_rate_limit", {
    p_identifier: identifier,
    p_window_seconds: windowSeconds,
    p_max_attempts: maxAttempts,
  });
}

describe.skipIf(!SERVICE_ROLE_KEY)("rate limiting", () => {
  afterAll(async () => {
    if (createdIdentifiers.length > 0) {
      await admin.from("rate_limits").delete().in("identifier", createdIdentifiers);
    }
  });

  it("allows exactly max_attempts calls, then blocks the next one", async () => {
    const identifier = `entry:test-user-${randomUUID()}`;

    for (let i = 0; i < 3; i++) {
      const { data, error } = await checkRateLimit(identifier, 60, 3);
      expect(error).toBeNull();
      expect(data).toBe(true);
    }

    const { data: blocked, error } = await checkRateLimit(identifier, 60, 3);
    expect(error).toBeNull();
    expect(blocked).toBe(false);
  });

  it("tracks each identifier's window independently — a different token/user isn't affected", async () => {
    const tokenA = `invite-lookup:${randomUUID()}`;
    const tokenB = `invite-lookup:${randomUUID()}`;

    for (let i = 0; i < 2; i++) {
      await checkRateLimit(tokenA, 60, 2);
    }
    const { data: blockedA } = await checkRateLimit(tokenA, 60, 2);
    expect(blockedA).toBe(false);

    // tokenB has never been checked before — starts fresh, unaffected by
    // tokenA's exhausted budget.
    const { data: allowedB } = await checkRateLimit(tokenB, 60, 2);
    expect(allowedB).toBe(true);
  });

  it("resets the window once it has elapsed", async () => {
    const identifier = `login:test-${randomUUID()}`;

    await checkRateLimit(identifier, 1, 1); // window_seconds=1, max_attempts=1
    const { data: blocked } = await checkRateLimit(identifier, 1, 1);
    expect(blocked).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const { data: allowedAfterReset } = await checkRateLimit(identifier, 1, 1);
    expect(allowedAfterReset).toBe(true);
  });
});
