import { describe, expect, it } from "vitest";
import { parseCapabilityPolicy, policyAllowsRole } from "@/lib/auth/capability-policy";

/**
 * The capability policy's decision rule, in isolation from any database
 * (Milestone 2 final standing-rule remediation). Everything here is about
 * one property: nothing unknown is ever resolved in the caller's favour.
 */

const CAPABILITY = "discovery_taxonomy_management";

describe("parseCapabilityPolicy", () => {
  it("reads a well-formed row", () => {
    expect(parseCapabilityPolicy(CAPABILITY, { allowed_roles: ["super_admin", "admin"] })).toEqual({
      capability: CAPABILITY,
      allowedRoles: ["super_admin", "admin"],
    });
  });

  it("accepts an empty allow list — valid configuration that permits nobody", () => {
    expect(parseCapabilityPolicy(CAPABILITY, { allowed_roles: [] })).toEqual({
      capability: CAPABILITY,
      allowedRoles: [],
    });
  });

  it("rejects a missing row", () => {
    expect(parseCapabilityPolicy(CAPABILITY, null)).toBeNull();
    expect(parseCapabilityPolicy(CAPABILITY, undefined)).toBeNull();
  });

  it("rejects a row whose allow list is not a list of role names", () => {
    expect(parseCapabilityPolicy(CAPABILITY, {})).toBeNull();
    expect(parseCapabilityPolicy(CAPABILITY, { allowed_roles: "super_admin" })).toBeNull();
    expect(parseCapabilityPolicy(CAPABILITY, { allowed_roles: [{ role: "super_admin" }] })).toBeNull();
    expect(parseCapabilityPolicy(CAPABILITY, { allowed_roles: [null] })).toBeNull();
  });

  it("rejects the whole row when any entry is a role this build does not know", () => {
    // The valid entry does not survive alongside the typo: a policy that
    // cannot be fully interpreted is unknown, not narrower.
    expect(parseCapabilityPolicy(CAPABILITY, { allowed_roles: ["super_admin", "supper_admin"] })).toBeNull();
    expect(parseCapabilityPolicy(CAPABILITY, { allowed_roles: ["moderator"] })).toBeNull();
    expect(parseCapabilityPolicy(CAPABILITY, { allowed_roles: ["Super_Admin"] })).toBeNull();
    expect(parseCapabilityPolicy(CAPABILITY, { allowed_roles: ["super_admin "] })).toBeNull();
  });
});

describe("policyAllowsRole", () => {
  const policy = parseCapabilityPolicy(CAPABILITY, { allowed_roles: ["super_admin"] });

  it("permits a listed role and denies every unlisted one", () => {
    expect(policyAllowsRole(policy, "super_admin")).toBe(true);
    expect(policyAllowsRole(policy, "admin")).toBe(false);
    expect(policyAllowsRole(policy, "player")).toBe(false);
  });

  it("denies when there is no usable policy, with no fallback to a broader role", () => {
    expect(policyAllowsRole(null, "super_admin")).toBe(false);
    expect(policyAllowsRole(null, "admin")).toBe(false);
  });

  it("denies a role the caller invented", () => {
    expect(policyAllowsRole(policy, "root")).toBe(false);
    expect(policyAllowsRole(policy, "")).toBe(false);
  });
});
