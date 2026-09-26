import { describe, expect, it } from "vitest";
import { getSelectionLabel } from "@/lib/prediction-markets/selection-labels";

/**
 * Stage 4A remediation (Stage 4 audit §5/§13/§15/§16 — "Result: YES" /
 * "You predicted YES" raw-enum leakage). Pure function, no I/O: given a
 * Market's stored `priceOutcomeLabels` (authored once at ingestion —
 * lib/prediction-markets/ingestion/nfl.ts) and a YES/NO selection, the
 * rendered copy must be the semantic label, never the raw enum.
 */
describe("getSelectionLabel", () => {
  it("(H) MONEYLINE — resolves to the team-win phrasing, not the raw enum", () => {
    const market = { priceOutcomeLabels: { yes: "Chiefs win", no: "Chiefs do not win" } };
    expect(getSelectionLabel(market, "YES")).toBe("Chiefs win");
    expect(getSelectionLabel(market, "NO")).toBe("Chiefs do not win");
  });

  it("(I) TOTAL — resolves to Over/Under phrasing with the real line, not the raw enum", () => {
    const market = { priceOutcomeLabels: { yes: "Over 47.5", no: "Under 47.5" } };
    expect(getSelectionLabel(market, "YES")).toBe("Over 47.5");
    expect(getSelectionLabel(market, "NO")).toBe("Under 47.5");
  });

  it("falls back to a human-cased (not raw-enum) label when a Market was somehow ingested without labels", () => {
    const market = { priceOutcomeLabels: null };
    expect(getSelectionLabel(market, "YES")).toBe("Yes");
    expect(getSelectionLabel(market, "NO")).toBe("No");
  });

  it("falls back per-side when only one side's label is missing", () => {
    const market = { priceOutcomeLabels: { yes: "Chiefs win", no: null } };
    expect(getSelectionLabel(market, "YES")).toBe("Chiefs win");
    expect(getSelectionLabel(market, "NO")).toBe("No");
  });
});
