import { describe, expect, it } from "vitest";
import {
  createPoolFromTemplateSchema,
  createPoolsForFixturesSchema,
  updatePoolSchema,
  enterPoolSchema,
  voidEntrySchema,
  MINIMUM_LOCK_LEAD_MINUTES,
} from "@/lib/validations/pools";
import { winningMarginConfigSchema, teamSideOnlyConfigSchema } from "@/lib/pools/templates/goals";
import { teamSideConfigSchema } from "@/lib/pools/templates/match-result";

const validCreate = {
  fixtureId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  poolType: "WHO_WILL_ADVANCE" as const,
  entryFeeCents: 1000,
  houseFeeBps: 1000,
  visibility: "VISIBLE_TO_ALL_MEMBERS" as const,
  participationVisibility: "SHOW_AFTER_ENTRY" as const,
  locksAt: new Date().toISOString(),
};

describe("createPoolFromTemplateSchema", () => {
  it("accepts a fully valid payload", () => {
    expect(createPoolFromTemplateSchema.safeParse(validCreate).success).toBe(true);
  });

  it("rejects an invalid pool type", () => {
    expect(
      createPoolFromTemplateSchema.safeParse({ ...validCreate, poolType: "COIN_FLIP" }).success,
    ).toBe(false);
  });

  it("rejects CUSTOM — no longer creatable through the template builder", () => {
    expect(
      createPoolFromTemplateSchema.safeParse({ ...validCreate, poolType: "CUSTOM" }).success,
    ).toBe(false);
  });

  it("rejects a zero or negative entry fee", () => {
    expect(createPoolFromTemplateSchema.safeParse({ ...validCreate, entryFeeCents: 0 }).success).toBe(
      false,
    );
    expect(
      createPoolFromTemplateSchema.safeParse({ ...validCreate, entryFeeCents: -100 }).success,
    ).toBe(false);
  });

  it("rejects house fee bps outside 0-10000", () => {
    expect(createPoolFromTemplateSchema.safeParse({ ...validCreate, houseFeeBps: -1 }).success).toBe(
      false,
    );
    expect(
      createPoolFromTemplateSchema.safeParse({ ...validCreate, houseFeeBps: 10001 }).success,
    ).toBe(false);
  });

  it("allows a 0 bps house fee", () => {
    expect(createPoolFromTemplateSchema.safeParse({ ...validCreate, houseFeeBps: 0 }).success).toBe(
      true,
    );
  });

  it("rejects a minTotalEntries field — the platform-wide floor isn't client-submitted", () => {
    expect(
      createPoolFromTemplateSchema.safeParse({ ...validCreate, minTotalEntries: 10 }).success,
    ).toBe(false);
  });

  it("rejects a non-ISO locksAt", () => {
    expect(
      createPoolFromTemplateSchema.safeParse({ ...validCreate, locksAt: "tomorrow" }).success,
    ).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(createPoolFromTemplateSchema.safeParse({ ...validCreate, extra: "nope" }).success).toBe(
      false,
    );
  });
});

describe("createPoolFromTemplateSchema — COMBO branch", () => {
  const validCombo = {
    poolType: "COMBO" as const,
    fixtureId: validCreate.fixtureId,
    title: "2026 World Cup Semifinal France – England",
    question: "Will Mbappé, Bellingham, Dembélé score at least 1 goal each?",
    legs: ["Mbappé scores a goal", "Bellingham scores a goal", "Dembélé scores a goal"],
    entryFeeCents: validCreate.entryFeeCents,
    houseFeeBps: validCreate.houseFeeBps,
    visibility: validCreate.visibility,
    participationVisibility: validCreate.participationVisibility,
    locksAt: validCreate.locksAt,
  };

  it("accepts a fully valid COMBO payload", () => {
    expect(createPoolFromTemplateSchema.safeParse(validCombo).success).toBe(true);
  });

  it("rejects a missing fixtureId — every template, including COMBO, is fixture-backed", () => {
    const rest = { ...validCombo } as Partial<typeof validCombo>;
    delete rest.fixtureId;
    expect(createPoolFromTemplateSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects fewer than 2 legs", () => {
    expect(createPoolFromTemplateSchema.safeParse({ ...validCombo, legs: ["Only one"] }).success).toBe(
      false,
    );
  });

  it("accepts exactly 10 legs", () => {
    expect(
      createPoolFromTemplateSchema.safeParse({ ...validCombo, legs: Array(10).fill("Condition") })
        .success,
    ).toBe(true);
  });

  it("rejects more than 10 legs", () => {
    expect(
      createPoolFromTemplateSchema.safeParse({ ...validCombo, legs: Array(11).fill("Condition") })
        .success,
    ).toBe(false);
  });

  it("rejects a missing title", () => {
    const rest = { ...validCombo } as Partial<typeof validCombo>;
    delete rest.title;
    expect(createPoolFromTemplateSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects an empty leg label", () => {
    expect(
      createPoolFromTemplateSchema.safeParse({
        ...validCombo,
        legs: ["Mbappé scores a goal", "  "],
      }).success,
    ).toBe(false);
  });

  it("rejects a COMBO payload with free-text options", () => {
    expect(
      createPoolFromTemplateSchema.safeParse({ ...validCombo, options: ["Yes", "No"] }).success,
    ).toBe(false);
  });
});

describe("createPoolFromTemplateSchema — TEMPLATE_GRADED branch", () => {
  const validTemplate = {
    poolType: "TEMPLATE_GRADED" as const,
    fixtureId: validCreate.fixtureId,
    templateId: "WINNING_MARGIN",
    templateConfig: { team: "HOME", minimumMargin: 2 },
    entryFeeCents: validCreate.entryFeeCents,
    houseFeeBps: validCreate.houseFeeBps,
    visibility: validCreate.visibility,
    participationVisibility: validCreate.participationVisibility,
    locksAt: validCreate.locksAt,
  };

  it("accepts a fully valid payload", () => {
    expect(createPoolFromTemplateSchema.safeParse(validTemplate).success).toBe(true);
  });

  it("accepts an empty templateConfig — the specific template's own schema validates its exact shape later", () => {
    expect(
      createPoolFromTemplateSchema.safeParse({ ...validTemplate, templateConfig: {} }).success,
    ).toBe(true);
  });

  it("rejects a missing templateId", () => {
    const rest = { ...validTemplate } as Partial<typeof validTemplate>;
    delete rest.templateId;
    expect(createPoolFromTemplateSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a missing fixtureId", () => {
    const rest = { ...validTemplate } as Partial<typeof validTemplate>;
    delete rest.fixtureId;
    expect(createPoolFromTemplateSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(
      createPoolFromTemplateSchema.safeParse({ ...validTemplate, extra: "nope" }).success,
    ).toBe(false);
  });
});

describe("createPoolsForFixturesSchema", () => {
  const validLegacy = {
    poolType: "WHO_WILL_ADVANCE" as const,
    fixtureIds: [
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    ],
    lockMinutesBeforeKickoff: MINIMUM_LOCK_LEAD_MINUTES,
    entryFeeCents: 1000,
    houseFeeBps: 500,
    visibility: "VISIBLE_TO_ALL_MEMBERS" as const,
    participationVisibility: "SHOW_AFTER_ENTRY" as const,
  };

  it("accepts a valid legacy (WHO_WILL_ADVANCE/REGULATION_RESULT) payload", () => {
    expect(createPoolsForFixturesSchema.safeParse(validLegacy).success).toBe(true);
    expect(
      createPoolsForFixturesSchema.safeParse({ ...validLegacy, poolType: "REGULATION_RESULT" }).success,
    ).toBe(true);
  });

  it("rejects fewer than 2 fixture ids", () => {
    expect(
      createPoolsForFixturesSchema.safeParse({ ...validLegacy, fixtureIds: [validLegacy.fixtureIds[0]] })
        .success,
    ).toBe(false);
  });

  it("accepts exactly 50 fixture ids", () => {
    const fixtureIds = Array.from({ length: 50 }, (_, i) => `3fa85f64-5717-4562-b3fc-2c963f66${String(i).padStart(4, "0")}`);
    expect(createPoolsForFixturesSchema.safeParse({ ...validLegacy, fixtureIds }).success).toBe(true);
  });

  it("rejects more than 50 fixture ids", () => {
    const fixtureIds = Array.from({ length: 51 }, (_, i) => `3fa85f64-5717-4562-b3fc-2c963f66${String(i).padStart(4, "0")}`);
    expect(createPoolsForFixturesSchema.safeParse({ ...validLegacy, fixtureIds }).success).toBe(false);
  });

  it("rejects COMBO — free-typed text isn't portable across fixtures", () => {
    expect(
      createPoolsForFixturesSchema.safeParse({
        ...validLegacy,
        poolType: "COMBO",
        title: "t",
        question: "q",
        legs: ["a", "b"],
      }).success,
    ).toBe(false);
  });

  it("rejects lockMinutesBeforeKickoff below the platform minimum", () => {
    expect(
      createPoolsForFixturesSchema.safeParse({
        ...validLegacy,
        lockMinutesBeforeKickoff: MINIMUM_LOCK_LEAD_MINUTES - 1,
      }).success,
    ).toBe(false);
  });

  it("accepts a valid TEMPLATE_GRADED payload", () => {
    expect(
      createPoolsForFixturesSchema.safeParse({
        poolType: "TEMPLATE_GRADED",
        fixtureIds: validLegacy.fixtureIds,
        lockMinutesBeforeKickoff: MINIMUM_LOCK_LEAD_MINUTES,
        templateId: "MATCH_TOTAL_GOALS",
        templateConfig: { minimumGoals: 3 },
        entryFeeCents: validLegacy.entryFeeCents,
        houseFeeBps: validLegacy.houseFeeBps,
        visibility: validLegacy.visibility,
        participationVisibility: validLegacy.participationVisibility,
      }).success,
    ).toBe(true);
  });

  it("rejects a TEMPLATE_GRADED payload missing templateId", () => {
    expect(
      createPoolsForFixturesSchema.safeParse({
        poolType: "TEMPLATE_GRADED",
        fixtureIds: validLegacy.fixtureIds,
        lockMinutesBeforeKickoff: MINIMUM_LOCK_LEAD_MINUTES,
        templateConfig: {},
        entryFeeCents: validLegacy.entryFeeCents,
        houseFeeBps: validLegacy.houseFeeBps,
        visibility: validLegacy.visibility,
        participationVisibility: validLegacy.participationVisibility,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields", () => {
    expect(createPoolsForFixturesSchema.safeParse({ ...validLegacy, extra: "nope" }).success).toBe(false);
  });

  it("has no locksAt field — each fixture computes its own from lockMinutesBeforeKickoff", () => {
    expect(
      createPoolsForFixturesSchema.safeParse({ ...validLegacy, locksAt: new Date().toISOString() }).success,
    ).toBe(false);
  });
});

describe("per-template config schemas", () => {
  it("winningMarginConfigSchema accepts a valid team+margin payload", () => {
    expect(winningMarginConfigSchema.safeParse({ team: "HOME", minimumMargin: 2 }).success).toBe(
      true,
    );
  });

  it("winningMarginConfigSchema rejects an invalid team side", () => {
    expect(
      winningMarginConfigSchema.safeParse({ team: "MIDDLE", minimumMargin: 2 }).success,
    ).toBe(false);
  });

  it("winningMarginConfigSchema rejects a margin outside its bounds", () => {
    expect(winningMarginConfigSchema.safeParse({ team: "HOME", minimumMargin: 0 }).success).toBe(
      false,
    );
    expect(winningMarginConfigSchema.safeParse({ team: "HOME", minimumMargin: 11 }).success).toBe(
      false,
    );
  });

  it("teamSideOnlyConfigSchema (clean sheet / win to nil) accepts just a team", () => {
    expect(teamSideOnlyConfigSchema.safeParse({ team: "AWAY" }).success).toBe(true);
    expect(teamSideOnlyConfigSchema.safeParse({ team: "AWAY", extra: 1 }).success).toBe(false);
  });

  it("teamSideConfigSchema (team to avoid defeat) matches the same shape", () => {
    expect(teamSideConfigSchema.safeParse({ team: "HOME" }).success).toBe(true);
  });
});

describe("updatePoolSchema", () => {
  const validUpdate = {
    poolId: validCreate.fixtureId,
    entryFeeCents: validCreate.entryFeeCents,
    houseFeeBps: validCreate.houseFeeBps,
    visibility: validCreate.visibility,
    participationVisibility: validCreate.participationVisibility,
    locksAt: validCreate.locksAt,
  };

  it("accepts a fully valid payload", () => {
    expect(updatePoolSchema.safeParse(validUpdate).success).toBe(true);
  });

  it("rejects a missing poolId", () => {
    const { poolId, ...rest } = validUpdate;
    void poolId;
    expect(updatePoolSchema.safeParse(rest).success).toBe(false);
  });
});

describe("enterPoolSchema", () => {
  const valid = {
    poolId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    optionId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    amountCents: 1000,
    idempotencyKey: "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
  };

  it("accepts a valid entry", () => {
    expect(enterPoolSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a zero amount", () => {
    expect(enterPoolSchema.safeParse({ ...valid, amountCents: 0 }).success).toBe(false);
  });

  it("rejects a non-uuid idempotency key", () => {
    expect(enterPoolSchema.safeParse({ ...valid, idempotencyKey: "not-a-uuid" }).success).toBe(
      false,
    );
  });
});

describe("voidEntrySchema", () => {
  const valid = {
    entryId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    reason: "Player requested cancellation",
    idempotencyKey: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  };

  it("accepts a valid payload", () => {
    expect(voidEntrySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an empty reason", () => {
    expect(voidEntrySchema.safeParse({ ...valid, reason: "   " }).success).toBe(false);
  });
});
