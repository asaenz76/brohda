import { describe, expect, it } from "vitest";
import { formatSpreadLine, getChoicePresentation, getSelectionAccessibleName, getSelectionLabel, type SelectionLabelSource } from "@/lib/prediction-markets/selection-labels";

const HOME = "Indianapolis Colts";
const AWAY = "Washington Commanders";
const teams = { homeTeamName: HOME, awayTeamName: AWAY, sport: "american_football" };

const moneyline = (yesSide: "HOME" | "AWAY"): SelectionLabelSource => ({ marketTemplate: "MONEYLINE", yesSide, lineValue: null, ...teams });
const spread = (yesSide: "HOME" | "AWAY", lineValue: number): SelectionLabelSource => ({ marketTemplate: "SPREAD", yesSide, lineValue, ...teams });
const total = (lineValue: number): SelectionLabelSource => ({ marketTemplate: "TOTAL", yesSide: null, lineValue, ...teams });

describe("MONEYLINE — the two teams are the two choices", () => {
  it("YES is the yes_side team and NO is the other team (home YES, as ingestion creates it)", () => {
    const src = moneyline("HOME");
    expect(getSelectionLabel(src, "YES")).toBe(HOME);
    expect(getSelectionLabel(src, "NO")).toBe(AWAY);
  });

  it("mirrors exactly when yes_side is AWAY", () => {
    const src = moneyline("AWAY");
    expect(getSelectionLabel(src, "YES")).toBe(AWAY);
    expect(getSelectionLabel(src, "NO")).toBe(HOME);
  });

  it("follows the sport's own matchup order from the shared helper: Home vs Away for football, Away @ Home for American football", () => {
    const football = { ...moneyline("HOME"), sport: "football" };
    expect(getChoicePresentation(football).choices.map((c) => c.label)).toEqual([HOME, AWAY]);
    expect(getChoicePresentation({ ...moneyline("HOME"), sport: "american_football" }).choices.map((c) => c.label)).toEqual([AWAY, HOME]);
    expect(getChoicePresentation({ ...moneyline("HOME"), sport: null }).choices.map((c) => c.label)).toEqual([HOME, AWAY]); // unknown sport: the helper's default
  });

  it("is read in matchup order (Away @ Home), whichever side YES happens to be — order never follows YES/NO", () => {
    expect(getChoicePresentation(moneyline("HOME")).choices.map((c) => c.label)).toEqual([AWAY, HOME]);
    expect(getChoicePresentation(moneyline("AWAY")).choices.map((c) => c.label)).toEqual([AWAY, HOME]);
    // …while each choice still carries the canonical selection it stands for.
    expect(getChoicePresentation(moneyline("HOME")).choices.map((c) => c.outcome)).toEqual(["NO", "YES"]);
    expect(getChoicePresentation(moneyline("AWAY")).choices.map((c) => c.outcome)).toEqual(["YES", "NO"]);
  });

  it("never shows 'win', 'do not win', 'Yes' or 'No' as a choice, and needs no question", () => {
    const labels = getChoicePresentation(moneyline("HOME")).choices.map((c) => c.label).join(" | ");
    expect(labels).not.toMatch(/\bwin\b|do not|\bYes\b|\bNo\b/i);
  });

  it("has unambiguous accessible names and a compact Market label", () => {
    const p = getChoicePresentation(moneyline("HOME"));
    expect(getSelectionAccessibleName(moneyline("HOME"), "YES")).toBe(`Pick ${HOME} to win`);
    expect(getSelectionAccessibleName(moneyline("HOME"), "NO")).toBe(`Pick ${AWAY} to win`);
    expect(p.marketLabel).toBe("Moneyline");
    expect(p.templateAware).toBe(true);
  });
});

describe("SPREAD — team + signed line; the line belongs to the yes_side team, its opponent carries the opposite sign", () => {
  it.each([
    ["positive half-point (underdog)", "HOME", 3.5, `${HOME} +3.5`, `${AWAY} -3.5`],
    ["negative half-point (favourite)", "HOME", -3.5, `${HOME} -3.5`, `${AWAY} +3.5`],
    ["whole number, positive", "AWAY", 3, `${AWAY} +3`, `${HOME} -3`],
    ["whole number, negative", "AWAY", -7, `${AWAY} -7`, `${HOME} +7`],
    ["longer half-point", "HOME", 10.5, `${HOME} +10.5`, `${AWAY} -10.5`],
  ] as const)("%s", (_name, yesSide, line, yesLabel, noLabel) => {
    const src = spread(yesSide, line);
    expect(getSelectionLabel(src, "YES")).toBe(yesLabel);
    expect(getSelectionLabel(src, "NO")).toBe(noLabel);
  });

  it("never derives the opposite side by string manipulation: the two signs are always exact opposites", () => {
    for (const line of [-14, -7, -3.5, -0.5, 0.5, 2.5, 3, 6.5]) {
      const [a, b] = getChoicePresentation(spread("HOME", line)).choices.map((c) => c.label.split(" ").pop()!);
      expect(Math.abs(Number(a)) === Math.abs(Number(b))).toBe(true);
      expect(Number(a) + Number(b)).toBe(0);
    }
  });

  it("reads in matchup order, with YES wherever the yes_side team sits", () => {
    expect(getChoicePresentation(spread("HOME", 3.5)).choices.map((c) => [c.outcome, c.label])).toEqual([["NO", `${AWAY} -3.5`], ["YES", `${HOME} +3.5`]]);
    expect(getChoicePresentation(spread("AWAY", 3.5)).choices.map((c) => [c.outcome, c.label])).toEqual([["YES", `${AWAY} +3.5`], ["NO", `${HOME} -3.5`]]);
  });

  it("spells the sign for assistive technology", () => {
    expect(getSelectionAccessibleName(spread("HOME", 3.5), "YES")).toBe(`Pick ${HOME} plus 3.5`);
    expect(getSelectionAccessibleName(spread("HOME", 3.5), "NO")).toBe(`Pick ${AWAY} minus 3.5`);
    expect(getChoicePresentation(spread("HOME", 3.5)).marketLabel).toBe("Spread");
  });

  it("formats a signed line, and a zero line as pick'em", () => {
    expect(formatSpreadLine(3.5)).toBe("+3.5");
    expect(formatSpreadLine(-3.5)).toBe("-3.5");
    expect(formatSpreadLine(3)).toBe("+3");
    expect(formatSpreadLine(-7)).toBe("-7");
    expect(formatSpreadLine(0)).toBe("PK");
    expect(getSelectionAccessibleName(spread("HOME", 0), "YES")).toBe(`Pick ${HOME} at pick'em`);
  });
});

describe("TOTAL — Over / Under, the exact canonical total", () => {
  it.each([[47.5, "47.5"], [47, "47"], [51.5, "51.5"], [38, "38"]])("line %s", (line, text) => {
    const src = total(line);
    expect(getSelectionLabel(src, "YES")).toBe(`Over ${text}`);
    expect(getSelectionLabel(src, "NO")).toBe(`Under ${text}`);
    expect(getSelectionAccessibleName(src, "YES")).toBe(`Pick Over ${text} total points`);
    expect(getSelectionAccessibleName(src, "NO")).toBe(`Pick Under ${text} total points`);
    expect(getChoicePresentation(src).marketLabel).toBe(`Total ${text}`);
  });

  it("keeps Over first (YES) and Under second (NO), independent of team names", () => {
    expect(getChoicePresentation(total(47.5)).choices.map((c) => c.outcome)).toEqual(["YES", "NO"]);
    expect(getChoicePresentation({ marketTemplate: "TOTAL", lineValue: 47.5, yesSide: null }).choices.map((c) => c.label)).toEqual(["Over 47.5", "Under 47.5"]);
  });
});

describe("canonical mapping is a bijection per template — what is shown can only mean what is stored", () => {
  const cases: Array<[string, SelectionLabelSource]> = [
    ["moneyline home", moneyline("HOME")],
    ["moneyline away", moneyline("AWAY")],
    ["spread home -3.5", spread("HOME", -3.5)],
    ["spread away +6", spread("AWAY", 6)],
    ["total 47.5", total(47.5)],
  ];
  it.each(cases)("%s: two distinct outcomes and two distinct labels, one each of YES and NO", (_n, src) => {
    const { choices } = getChoicePresentation(src);
    expect(choices.map((c) => c.outcome).sort()).toEqual(["NO", "YES"]);
    expect(new Set(choices.map((c) => c.label)).size).toBe(2);
    expect(new Set(choices.map((c) => c.accessibleName)).size).toBe(2);
  });

  it("two people whose visible choices differ truly hold opposing canonical selections (Call BS / money opposition)", () => {
    for (const [, src] of cases) {
      const { choices } = getChoicePresentation(src);
      const [first, second] = choices;
      expect(first.label).not.toBe(second.label);
      expect(first.outcome).not.toBe(second.outcome);
    }
  });
});

describe("fallback — never crashes, never guesses", () => {
  it("uses the ingestion-authored labels when structured data is incomplete", () => {
    const src: SelectionLabelSource = { marketTemplate: "MONEYLINE", yesSide: null, homeTeamName: HOME, awayTeamName: AWAY, priceOutcomeLabels: { yes: "Chiefs win", no: "Chiefs do not win" } };
    const p = getChoicePresentation(src);
    expect(p.templateAware).toBe(false);
    expect(p.choices.map((c) => [c.outcome, c.label])).toEqual([["YES", "Chiefs win"], ["NO", "Chiefs do not win"]]);
    expect(p.marketLabel).toBeNull();
  });

  it("falls back to plain Yes / No (human-cased) with no labels at all", () => {
    expect(getChoicePresentation({}).choices.map((c) => c.label)).toEqual(["Yes", "No"]);
    expect(getChoicePresentation({ marketTemplate: null, priceOutcomeLabels: null }).templateAware).toBe(false);
  });

  it.each([
    ["spread without a line", { marketTemplate: "SPREAD", yesSide: "HOME", lineValue: null, ...teams }],
    ["total without a line", { marketTemplate: "TOTAL", yesSide: null, lineValue: null, ...teams }],
    ["moneyline without a side", { marketTemplate: "MONEYLINE", yesSide: null, ...teams }],
    ["moneyline without team names", { marketTemplate: "MONEYLINE", yesSide: "HOME", homeTeamName: "", awayTeamName: null }],
    ["unknown template", { marketTemplate: "PLAYER_PROP" as never, yesSide: "HOME", ...teams }],
  ] as Array<[string, SelectionLabelSource]>)("%s", (_n, src) => {
    expect(getChoicePresentation(src).templateAware).toBe(false);
    expect(getChoicePresentation(src).choices).toHaveLength(2);
  });
});
