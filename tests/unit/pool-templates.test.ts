import { describe, expect, it } from "vitest";
import { generatePoolTemplate, getRuleLabel, getTemplateEligibility } from "@/lib/pools/templates";

const fixture = {
  homeTeamExternalId: "42",
  homeTeamName: "Arsenal",
  homeTeamLogoUrl: "https://example.com/arsenal.png",
  awayTeamExternalId: "65",
  awayTeamName: "Nottingham Forest",
  awayTeamLogoUrl: "https://example.com/forest.png",
};

describe("generatePoolTemplate", () => {
  it("WHO_WILL_ADVANCE produces two team options", () => {
    const template = generatePoolTemplate("WHO_WILL_ADVANCE", fixture);

    expect(template.question).toBe("Who will advance?");
    expect(template.options).toHaveLength(2);
    expect(template.options[0]).toMatchObject({ label: "Arsenal", externalTeamId: "42" });
    expect(template.options[1]).toMatchObject({
      label: "Nottingham Forest",
      externalTeamId: "65",
    });
  });

  it("REGULATION_RESULT produces home/draw/away options", () => {
    const template = generatePoolTemplate("REGULATION_RESULT", fixture);

    expect(template.question).toBe("What will the result be after regulation?");
    expect(template.options).toHaveLength(3);
    expect(template.options[0].label).toBe("Arsenal");
    expect(template.options[1]).toMatchObject({
      label: "Draw",
      externalTeamId: null,
      teamName: null,
      logoUrl: null,
    });
    expect(template.options[2].label).toBe("Nottingham Forest");
  });

  it("assigns increasing sort_order", () => {
    const template = generatePoolTemplate("REGULATION_RESULT", fixture);
    expect(template.options.map((o) => o.sortOrder)).toEqual([0, 1, 2]);
  });

  it("includes the rule pill copy for each template", () => {
    expect(generatePoolTemplate("WHO_WILL_ADVANCE", fixture).ruleLabel).toContain(
      "Extra Time & Penalties",
    );
    expect(generatePoolTemplate("REGULATION_RESULT", fixture).ruleLabel).toContain(
      "90 Mins",
    );
  });
});

describe("getTemplateEligibility", () => {
  it("Cup fixtures only allow 'Who will advance?' — a draw is never the final outcome", () => {
    expect(getTemplateEligibility("Cup")).toEqual({
      whoWillAdvanceEnabled: true,
      regulationResultEnabled: false,
    });
  });

  it("League fixtures only allow 'Result after regulation' — a regular match can end in a draw", () => {
    expect(getTemplateEligibility("League")).toEqual({
      whoWillAdvanceEnabled: false,
      regulationResultEnabled: true,
    });
  });

  it("stays permissive for an unknown/not-yet-enriched competition type", () => {
    expect(getTemplateEligibility(null)).toEqual({
      whoWillAdvanceEnabled: true,
      regulationResultEnabled: true,
    });
    expect(getTemplateEligibility("Trophy")).toEqual({
      whoWillAdvanceEnabled: true,
      regulationResultEnabled: true,
    });
  });

  it("excludes both legacy pool types for a non-football sport regardless of competition type — NFL pools are modeled on lines (spread/game total/team total), not a generic Moneyline/knockout result", () => {
    expect(getTemplateEligibility("Cup", "american_football")).toEqual({
      whoWillAdvanceEnabled: false,
      regulationResultEnabled: false,
    });
    expect(getTemplateEligibility(null, "american_football")).toEqual({
      whoWillAdvanceEnabled: false,
      regulationResultEnabled: false,
    });
  });

  it("stays unchanged for football (the default when sport is omitted)", () => {
    expect(getTemplateEligibility("Cup", "football")).toEqual({
      whoWillAdvanceEnabled: true,
      regulationResultEnabled: false,
    });
    expect(getTemplateEligibility("Cup", undefined)).toEqual({
      whoWillAdvanceEnabled: true,
      regulationResultEnabled: false,
    });
  });
});

describe("getRuleLabel", () => {
  it("returns a neutral, non-empty label for CUSTOM (no team framing to derive one from)", () => {
    expect(getRuleLabel("CUSTOM")).toBe("Custom Poll");
  });

  it("returns a distinct label for COMBO, not the generic Custom Poll fallback", () => {
    const label = getRuleLabel("COMBO");
    expect(label).not.toBe("Custom Poll");
    expect(label.length).toBeGreaterThan(0);
  });
});
