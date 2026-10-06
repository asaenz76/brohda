import "@testing-library/jest-dom/vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RulesContent } from "@/components/rules/RulesContent";
import { UNKNOWN_RULES_POLICY } from "@/lib/rules/format";
import { getMarketSubject } from "@/lib/prediction-markets/selection-labels";

afterEach(() => cleanup());

const root = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    const rel = join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

// The consumer-facing surfaces: everything a person reads. Canonical/internal code is deliberately NOT here — the ingestion run that
// authors the stored question and labels, the grading rules, the repository that persists them — and neither is the admin area, where
// raw canonical values are kept on purpose for diagnostics.
const CONSUMER_SOURCES = [
  ...walk("components").filter((f) => !f.startsWith(join("components", "admin"))),
  ...walk(join("app", "(app)")),
  ...walk("lib/notifications"),
  "lib/challenges/history.ts",
];

// Old Yes/No-form language where a template-aware label exists. Targeted on purpose: "No notifications yet." and friends are fine.
const STALE: Array<[RegExp, string]> = [
  [/do not win/i, "the old negated moneyline label"],
  [/Will the [^"'`]*\?/, "the old question phrasing"],
  [/["'`]Pick: /, "the old 'Pick: …' accessible name"],
  [/You (picked|predicted) (YES|NO)\b/, "a raw canonical selection in a sentence"],
  [/Picked (YES|NO)\b/, "a raw canonical selection in a sentence"],
  [/>\s*(YES|NO)\s*</, "a raw canonical selection as visible text"],
];

describe("zero stale Yes/No copy on consumer surfaces", () => {
  const files = [...new Set(CONSUMER_SOURCES)];

  it("scans a meaningful set of files", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(STALE)("no consumer source contains %s (%s)", (pattern) => {
    const offenders = files.filter((f) => {
      const lines = readFileSync(join(root, f), "utf8").split("\n");
      // Comments explain history and may quote the old words; only code and copy count.
      return lines.some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && pattern.test(line));
    });
    expect(offenders).toEqual([]);
  });
});

describe("Rules examples match the interface people actually see", () => {
  const text = () => document.body.textContent ?? "";

  it("describes a Pick as choosing a team, a team with its spread, or Over/Under — not answering a question", () => {
    render(<RulesContent policy={UNKNOWN_RULES_POLICY} />);
    expect(text()).toContain("you choose one of its two sides — a team, a team with its spread, or Over or Under a total.");
    expect(text()).toContain("a different way to pick the same game, like who wins, the point spread, or the total score.");
    expect(text()).not.toMatch(/\bYes\b|\bYes\/No\b|\bNo\b answer|answer|its question|a question about/i);
  });

  it("still states the one Pick cutoff accurately", () => {
    render(<RulesContent policy={{ ...UNKNOWN_RULES_POLICY, lockMinutesBeforeKickoff: 10 }} />);
    expect(text()).toContain("You can make or change your Pick until 10 minutes before kickoff.");
  });
});

describe("notifications name a Market by what it is about, not by the old question", () => {
  const teams = { homeTeamName: "Indianapolis Colts", awayTeamName: "Washington Commanders", sport: "american_football" };
  it.each([
    [{ marketTemplate: "MONEYLINE", yesSide: "HOME", lineValue: null, ...teams }, "Washington Commanders @ Indianapolis Colts · Moneyline"],
    [{ marketTemplate: "SPREAD", yesSide: "HOME", lineValue: 3.5, ...teams }, "Washington Commanders @ Indianapolis Colts · Spread"],
    [{ marketTemplate: "TOTAL", yesSide: null, lineValue: 47.5, ...teams }, "Washington Commanders @ Indianapolis Colts · Total 47.5"],
  ] as const)("%j", (source, expected) => {
    expect(getMarketSubject(source as never, "Will the Indianapolis Colts win?")).toBe(expected);
  });

  it("falls back to the original question, or a plain phrase, when the Market can't be described", () => {
    expect(getMarketSubject({}, "Some older question?")).toBe("Some older question?");
    expect(getMarketSubject({}, null)).toBe("a market");
    expect(getMarketSubject({ marketTemplate: "MONEYLINE", yesSide: "HOME", homeTeamName: "Colts", awayTeamName: null }, "Q?")).toBe("Q?");
  });
});
