/**
 * Integration tests against a real local Supabase instance for
 * platform_settings (the registration-enabled toggle). Requires
 * `pnpm supabase:start` to be running first.
 *
 * Run with: pnpm exec vitest run --config vitest.integration.config.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { getTestAdminClient, getTestSupabaseConfig } from "./helpers/test-env";

const { url: SUPABASE_URL, anonKey: ANON_KEY, serviceRoleKey: SERVICE_ROLE_KEY } = getTestSupabaseConfig();

const admin = getTestAdminClient();

describe.skipIf(!SERVICE_ROLE_KEY)("platform_settings: registration_enabled toggle", () => {
  let originalValue: boolean;

  beforeAll(async () => {
    const { data } = await admin
      .from("platform_settings")
      .select("registration_enabled")
      .eq("id", true)
      .single();
    originalValue = data?.registration_enabled ?? false;
  });

  afterAll(async () => {
    await admin.from("platform_settings").update({ registration_enabled: originalValue }).eq("id", true);
  });

  it("is a singleton — there is exactly one row", async () => {
    const { data, error } = await admin.from("platform_settings").select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("rejects a second row via the id=true check constraint", async () => {
    const { error } = await admin.from("platform_settings").insert({ id: false });
    expect(error).not.toBeNull();
  });

  it("is readable by a completely unauthenticated (anon) client", async () => {
    const anonClient = createSupabaseClient(SUPABASE_URL, ANON_KEY);
    const { data, error } = await anonClient
      .from("platform_settings")
      .select("registration_enabled")
      .eq("id", true)
      .single();

    expect(error).toBeNull();
    expect(typeof data?.registration_enabled).toBe("boolean");
  });

  it("cannot be written by an anon client — no write policy, RLS blocks it", async () => {
    const anonClient = createSupabaseClient(SUPABASE_URL, ANON_KEY);
    const { data } = await anonClient
      .from("platform_settings")
      .update({ registration_enabled: true })
      .eq("id", true)
      .select("id");

    // RLS with no matching policy silently filters to zero affected rows
    // rather than raising — assert nothing was actually changed, not just
    // the absence of a thrown error.
    expect(data ?? []).toHaveLength(0);

    const { data: after } = await admin
      .from("platform_settings")
      .select("registration_enabled")
      .eq("id", true)
      .single();
    expect(after?.registration_enabled).toBe(originalValue);
  });

  it("can be toggled by the service-role admin client", async () => {
    await admin.from("platform_settings").update({ registration_enabled: true }).eq("id", true);
    const { data: enabled } = await admin
      .from("platform_settings")
      .select("registration_enabled")
      .eq("id", true)
      .single();
    expect(enabled?.registration_enabled).toBe(true);

    await admin.from("platform_settings").update({ registration_enabled: false }).eq("id", true);
    const { data: disabled } = await admin
      .from("platform_settings")
      .select("registration_enabled")
      .eq("id", true)
      .single();
    expect(disabled?.registration_enabled).toBe(false);
  });
});
