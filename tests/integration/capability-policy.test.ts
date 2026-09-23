/**
 * Milestone 2 final standing-rule remediation — discovery taxonomy
 * authorization is configured, not coded.
 *
 * Real local Supabase only (`pnpm supabase:start`). These tests read the
 * policy through the same application code the Server Actions use
 * (`lib/auth/capabilities.ts`), against real `capability_policies` rows and
 * real `user_profiles` roles — never a stubbed policy object. Changing who
 * may manage taxonomy happens here exactly as it happens in production: by
 * writing a row.
 *
 * The session half of the gate (authenticate first, redirect a denied user)
 * is unit-tested in tests/unit/auth/require-capability.test.ts, which can
 * mock a session; what needs a real database is the policy itself.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getTestAdminClient, getTestAnonClient } from "./helpers/test-env";
import { loadCapabilityPolicy, roleHasCapability } from "@/lib/auth/capabilities";

const admin = getTestAdminClient();
const CAPABILITY = "discovery_taxonomy_management";

/** The seeded default, restored after every test that changes it. */
const DEFAULT_ALLOWED_ROLES = ["super_admin"];

async function setAllowedRoles(roles: string[] | null) {
  if (roles === null) {
    const { error } = await admin.from("capability_policies").delete().eq("capability", CAPABILITY);
    if (error) throw error;
    return;
  }
  const { error } = await admin
    .from("capability_policies")
    .upsert({ capability: CAPABILITY, allowed_roles: roles }, { onConflict: "capability" });
  if (error) throw error;
}

/**
 * The role of a REAL user_profiles row, not a literal — so "permits a super
 * admin" is proven end to end: a user exists in the database with that role,
 * and the decision is taken on the role the database reports for them.
 */
async function roleOfStoredUser(role: "super_admin" | "admin" | "player"): Promise<string> {
  const { data, error } = await admin.from("user_profiles").select("role").eq("role", role).limit(1).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`no ${role} profile seeded for this test`);
  return data.role as string;
}

const seededProfileIds: string[] = [];

async function seedProfile(role: "super_admin" | "admin" | "player") {
  const { data, error } = await admin.auth.admin.createUser({
    email: `capability-${role}-${Date.now()}@test.local`,
    password: "test-password-123",
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("failed to create user");
  const { error: profileError } = await admin
    .from("user_profiles")
    .insert({ id: data.user.id, display_name: `capability ${role}`, role, is_active: true });
  if (profileError) throw profileError;
  seededProfileIds.push(data.user.id);
}

beforeEach(async () => {
  await setAllowedRoles(DEFAULT_ALLOWED_ROLES);
});

afterEach(async () => {
  await setAllowedRoles(DEFAULT_ALLOWED_ROLES);
});

afterAll(async () => {
  for (const id of seededProfileIds) await admin.auth.admin.deleteUser(id);
});

describe("the default policy", () => {
  it("is the seeded migration value — super admin only, with no code involved", async () => {
    const policy = await loadCapabilityPolicy(CAPABILITY);
    expect(policy).toEqual({ capability: CAPABILITY, allowedRoles: ["super_admin"] });
  });

  it("permits a super admin", async () => {
    await seedProfile("super_admin");
    expect(await roleHasCapability(await roleOfStoredUser("super_admin"), CAPABILITY)).toBe(true);
  });

  it("denies the lower-privileged admin role — an admin is not a taxonomy manager by default", async () => {
    await seedProfile("admin");
    expect(await roleHasCapability(await roleOfStoredUser("admin"), CAPABILITY)).toBe(false);
  });

  it("denies an ordinary player", async () => {
    await seedProfile("player");
    expect(await roleHasCapability(await roleOfStoredUser("player"), CAPABILITY)).toBe(false);
  });
});

describe("changing the policy", () => {
  it("permits the admin role after a configuration-only change — no source edit, no deployment", async () => {
    await seedProfile("admin");
    const adminRole = await roleOfStoredUser("admin");
    expect(await roleHasCapability(adminRole, CAPABILITY)).toBe(false);

    await setAllowedRoles(["super_admin", "admin"]);

    expect(await roleHasCapability(adminRole, CAPABILITY)).toBe(true);
    // Widening one role never widens the rest.
    expect(await roleHasCapability("player", CAPABILITY)).toBe(false);
  });

  it("removes that access again on revert, with no code change either way", async () => {
    await setAllowedRoles(["super_admin", "admin"]);
    expect(await roleHasCapability("admin", CAPABILITY)).toBe(true);

    await setAllowedRoles(["super_admin"]);

    expect(await roleHasCapability("admin", CAPABILITY)).toBe(false);
    expect(await roleHasCapability("super_admin", CAPABILITY)).toBe(true);
  });

  it("is read fresh on every check — a policy change takes effect without restarting anything", async () => {
    expect(await roleHasCapability("admin", CAPABILITY)).toBe(false);
    await setAllowedRoles(["admin"]);
    expect(await roleHasCapability("admin", CAPABILITY)).toBe(true);
    // And the previously-allowed role loses access in the same breath: this
    // is a policy, not an accumulating grant list.
    expect(await roleHasCapability("super_admin", CAPABILITY)).toBe(false);
  });
});

describe("fail closed", () => {
  it("denies everyone when the policy row is missing", async () => {
    await setAllowedRoles(null);

    expect(await loadCapabilityPolicy(CAPABILITY)).toBeNull();
    for (const role of ["super_admin", "admin", "player"]) {
      expect(await roleHasCapability(role, CAPABILITY), role).toBe(false);
    }
  });

  it("denies everyone when the policy is malformed — never falling back to a broader role", async () => {
    // A typo an operator could really make. The valid entry alongside it
    // does not rescue the row: an uninterpretable policy is unknown, not
    // narrower.
    await setAllowedRoles(["super_admin", "supper_admin"]);

    expect(await loadCapabilityPolicy(CAPABILITY)).toBeNull();
    expect(await roleHasCapability("super_admin", CAPABILITY)).toBe(false);
  });

  it("denies everyone when the policy names a role this build does not know", async () => {
    await setAllowedRoles(["moderator"]);
    expect(await roleHasCapability("moderator", CAPABILITY)).toBe(false);
    expect(await roleHasCapability("super_admin", CAPABILITY)).toBe(false);
  });

  it("treats an empty allow list as valid configuration that permits nobody", async () => {
    await setAllowedRoles([]);
    expect(await loadCapabilityPolicy(CAPABILITY)).toEqual({ capability: CAPABILITY, allowedRoles: [] });
    expect(await roleHasCapability("super_admin", CAPABILITY)).toBe(false);
  });
});

describe("the policy table is not a consumer surface", () => {
  it("rejects a direct anon read", async () => {
    const { data, error } = await getTestAnonClient().from("capability_policies").select("*");
    expect(error ?? (data ?? []).length === 0).toBeTruthy();
    expect(data ?? []).toEqual([]);
  });

  it("rejects a direct anon write", async () => {
    const { error } = await getTestAnonClient()
      .from("capability_policies")
      .upsert({ capability: CAPABILITY, allowed_roles: ["player"] });
    expect(error).not.toBeNull();

    // And the real policy is untouched.
    expect(await roleHasCapability("player", CAPABILITY)).toBe(false);
  });
});

describe("the discovery taxonomy feature owns no authorization policy of its own", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");

  const FEATURE_FILES = [
    "lib/prediction-markets/discovery/authorization.ts",
    "lib/actions/discovery-categories.ts",
    "app/(admin)/admin/discovery-categories/page.tsx",
    "lib/prediction-markets/discovery/repository.ts",
  ];

  it("contains no role name and no direct auth-helper call anywhere in the feature", async () => {
    for (const file of FEATURE_FILES) {
      const source = await readFile(path.join(repoRoot, file), "utf-8");
      // Strip comments: the prose explains the policy deliberately; what
      // must not exist is executable coupling to a specific role.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${file} names a role`).not.toMatch(/["']super_admin["']|["']admin["']|["']player["']/);
      expect(code, `${file} calls an auth helper directly`).not.toMatch(
        /requireSuperAdmin|requireAdminOrAbove|isSuperAdmin|isAdminOrAbove/,
      );
      expect(code, `${file} imports the session module directly`).not.toMatch(/from "@\/lib\/auth\/session"/);
    }
  });

  it("gates every taxonomy mutation through requireDiscoveryTaxonomyManager()", async () => {
    const source = await readFile(path.join(repoRoot, "lib/actions/discovery-categories.ts"), "utf-8");
    const exportedActions = [...source.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    expect(exportedActions.length).toBeGreaterThan(0);

    for (const action of exportedActions) {
      const body = source.slice(source.indexOf(`export async function ${action}`)).split("\n}\n")[0];
      expect(body, `${action} is not gated`).toContain("await requireDiscoveryTaxonomyManager()");
    }
  });
});
