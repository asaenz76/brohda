import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MESSAGING_BOOLEAN_FIELDS, MESSAGING_SETTING_FIELDS } from "@/lib/messaging/settings-fields";

describe("the Messaging settings field list", () => {
  it("has unique keys, sane ranges, and every retention field is nullable (blank = keep)", () => {
    const keys = MESSAGING_SETTING_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of MESSAGING_SETTING_FIELDS) {
      expect(f.key.startsWith("messaging_"), f.key).toBe(true);
      expect(f.max, f.key).toBeGreaterThan(f.min);
      expect(f.help.length, f.key).toBeGreaterThan(5);
      if (f.group === "Retention") expect(f.nullable, f.key).toBe(true);
      else expect(f.nullable, f.key).toBeFalsy();
    }
  });

  it("the on/off switches are listed once, off-by-default ones are described as such, and no key is shared with a numeric field", () => {
    const keys = MESSAGING_BOOLEAN_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(["messaging_retention_purge_enabled", "messaging_abuse_restrict_enabled", "messaging_report_outcome_notifications_enabled"]));
    const numeric = new Set(MESSAGING_SETTING_FIELDS.map((f) => f.key));
    for (const k of keys) expect(numeric.has(k), k).toBe(false);
    for (const f of MESSAGING_BOOLEAN_FIELDS) expect(f.help.length, f.key).toBeGreaterThan(10);
  });

  it("every editable key is accepted by the audited database function (so the form can never offer a setting the function rejects)", () => {
    const sql = readFileSync("supabase/migrations/20260101000199_messaging_owner_decisions.sql", "utf8");
    const allowed = sql.slice(sql.indexOf("v_allowed text[] := array["), sql.indexOf("begin", sql.indexOf("v_allowed text[] := array[")));
    for (const k of ["messaging_enabled", ...MESSAGING_BOOLEAN_FIELDS.map((f) => f.key), ...MESSAGING_SETTING_FIELDS.map((f) => f.key)]) expect(allowed, k).toContain(`'${k}'`);
  });
});
