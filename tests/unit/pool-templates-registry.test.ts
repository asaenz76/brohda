import { describe, expect, it } from "vitest";
import {
  findDuplicateTemplateKeys,
  getLatestTemplate,
  getTemplate,
  getTemplateConfigSchema,
  listByCategory,
  TEMPLATE_REGISTRY,
} from "@/lib/pools/templates/registry";
import type { PoolTemplate } from "@/lib/pools/templates/types";

// NFL_SPREAD/NFL_GAME_TOTAL/NFL_TEAM_TOTAL's own detailed grading/
// validation examples live in tests/unit/nfl-templates.test.ts — this file
// just confirms they're correctly wired into the shared registry machinery.
describe("registry", () => {
  it("has 3 templates (NFL only — Association football support was retired)", () => {
    expect(TEMPLATE_REGISTRY).toHaveLength(3);
  });

  it("getTemplate resolves an exact (id, version) pair and returns null otherwise", () => {
    expect(getTemplate("NFL_SPREAD", 1)?.name).toBeTruthy();
    expect(getTemplate("NFL_SPREAD", 2)).toBeNull();
    expect(getTemplate("NOT_A_TEMPLATE", 1)).toBeNull();
  });

  it("getLatestTemplate resolves the highest activeForCreation version, and null for an unknown id", () => {
    expect(getLatestTemplate("NFL_SPREAD")?.id).toBe("NFL_SPREAD");
    expect(getLatestTemplate("NOT_A_TEMPLATE")).toBeNull();
  });

  it("every registry template is version 1", () => {
    for (const template of TEMPLATE_REGISTRY) {
      expect(template.version).toBe(1);
    }
  });

  it("every registry template is activeForCreation", () => {
    const active = TEMPLATE_REGISTRY.filter((t) => t.activeForCreation).map((t) => t.id).sort();
    expect(active).toEqual(["NFL_GAME_TOTAL", "NFL_SPREAD", "NFL_TEAM_TOTAL"]);
  });

  it("getTemplateConfigSchema resolves by (id, version) and null otherwise", () => {
    expect(getTemplateConfigSchema("NFL_SPREAD", 1)).toBeTruthy();
    expect(getTemplateConfigSchema("NFL_SPREAD", 2)).toBeNull();
    expect(getTemplateConfigSchema("NOT_A_TEMPLATE", 1)).toBeNull();
  });

  it("findDuplicateTemplateKeys rejects a duplicate (id, version) pair", () => {
    const base = TEMPLATE_REGISTRY[0] as PoolTemplate<Record<string, unknown>>;
    expect(findDuplicateTemplateKeys(TEMPLATE_REGISTRY)).toEqual([]);
    expect(findDuplicateTemplateKeys([base, { ...base }])).toEqual([`${base.id}:${base.version}`]);
    // A different version of the same id is NOT a duplicate.
    expect(findDuplicateTemplateKeys([base, { ...base, version: base.version + 1 }])).toEqual([]);
  });

  it("listByCategory groups by category", () => {
    const grouped = listByCategory();
    expect(grouped.GOALS?.length).toBe(3);
    expect(grouped.MATCH_RESULT ?? []).toEqual([]);
  });
});
