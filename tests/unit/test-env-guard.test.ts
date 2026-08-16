/**
 * Unit coverage for the Phase 4.1 remediation production guard
 * (tests/integration/helpers/test-env.ts) — the mechanism that's supposed
 * to make running the integration suite against production impossible.
 * A plain unit test, not an integration test: assertSafeTestSupabaseUrl is
 * pure/synchronous, and testing the guard via the integration suite it
 * gates would be circular.
 */
import { describe, expect, it } from "vitest";
import { assertSafeTestSupabaseUrl, UnsafeTestSupabaseTargetError } from "@/tests/integration/helpers/test-env";

describe("assertSafeTestSupabaseUrl", () => {
  it("allows the local Supabase CLI's fixed address", () => {
    expect(() => assertSafeTestSupabaseUrl("http://127.0.0.1:54321")).not.toThrow();
  });

  it("allows the localhost variant", () => {
    expect(() => assertSafeTestSupabaseUrl("http://localhost:54321")).not.toThrow();
  });

  it("refuses this repo's real production project URL", () => {
    expect(() => assertSafeTestSupabaseUrl("https://wovfovohynwxgfwdztti.supabase.co")).toThrow(UnsafeTestSupabaseTargetError);
  });

  it("refuses an arbitrary other remote Supabase project", () => {
    expect(() => assertSafeTestSupabaseUrl("https://some-other-project.supabase.co")).toThrow(UnsafeTestSupabaseTargetError);
  });

  it("refuses a local address on the wrong port", () => {
    expect(() => assertSafeTestSupabaseUrl("http://127.0.0.1:5432")).toThrow(UnsafeTestSupabaseTargetError);
  });

  it("refuses an empty string", () => {
    expect(() => assertSafeTestSupabaseUrl("")).toThrow(UnsafeTestSupabaseTargetError);
  });
});
