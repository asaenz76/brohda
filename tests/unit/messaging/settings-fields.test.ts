import { describe, expect, it } from "vitest";
import { MESSAGING_SETTING_FIELDS } from "@/lib/messaging/settings-fields";

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
});
