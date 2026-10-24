import { describe, expect, it } from "vitest";
import { FAIL_CLOSED_MARKET_POLICY, marketsOfAllowedTemplates, parseMarketPolicy, parseTemplateList } from "@/lib/prediction-markets/market-policy-parse";

/**
 * Brohda 2.1 M2: the four Market/Pick policy settings, parsed FAIL CLOSED per field. A value that is missing, the wrong type, or contains anything that is not a real template never
 * broadens what Members can do or what ingestion writes.
 */
describe("parseTemplateList", () => {
  it("accepts real templates and removes duplicates", () => {
    expect(parseTemplateList(["MONEYLINE"])).toEqual(["MONEYLINE"]);
    expect(parseTemplateList(["MONEYLINE", "TOTAL", "MONEYLINE"])).toEqual(["MONEYLINE", "TOTAL"]);
    expect(parseTemplateList([])).toEqual([]);
  });
  it("one unknown element invalidates the whole list — never 'everything', never a partial list", () => {
    expect(parseTemplateList(["MONEYLINE", "PARLAY"])).toEqual([]);
    expect(parseTemplateList(["moneyline"])).toEqual([]);
    expect(parseTemplateList(["MONEYLINE", null])).toEqual([]);
    expect(parseTemplateList(["MONEYLINE", 3])).toEqual([]);
  });
  it("anything that is not an array is nothing", () => {
    for (const bad of [null, undefined, "MONEYLINE", { 0: "MONEYLINE" }, 7, true]) expect(parseTemplateList(bad)).toEqual([]);
  });
});

describe("parseMarketPolicy", () => {
  const good = { fixture_markets_enabled: true, prediction_require_price: false, prediction_allowed_templates: ["MONEYLINE"], market_ingestion_templates: ["MONEYLINE", "TOTAL"] };

  it("reads the four values", () => {
    expect(parseMarketPolicy(good)).toEqual({ fixtureMarketsEnabled: true, requirePrice: false, allowedTemplates: ["MONEYLINE"], ingestionTemplates: ["MONEYLINE", "TOTAL"] });
  });
  it("an unreadable row is the fail-closed policy: nothing offered, price required, no fixture Markets", () => {
    for (const bad of [null, undefined, "x", 5]) expect(parseMarketPolicy(bad)).toEqual(FAIL_CLOSED_MARKET_POLICY);
    expect(FAIL_CLOSED_MARKET_POLICY).toEqual({ fixtureMarketsEnabled: false, requirePrice: true, allowedTemplates: [], ingestionTemplates: [] });
  });
  it("only an explicit false relaxes the price requirement; only an explicit true enables fixture Markets", () => {
    expect(parseMarketPolicy({ ...good, prediction_require_price: null }).requirePrice).toBe(true);
    expect(parseMarketPolicy({ ...good, prediction_require_price: "false" }).requirePrice).toBe(true);
    expect(parseMarketPolicy({ ...good, prediction_require_price: undefined }).requirePrice).toBe(true);
    expect(parseMarketPolicy({ ...good, fixture_markets_enabled: "true" }).fixtureMarketsEnabled).toBe(false);
    expect(parseMarketPolicy({ ...good, fixture_markets_enabled: 1 }).fixtureMarketsEnabled).toBe(false);
  });
  it("a malformed list in one field does not affect the others", () => {
    const p = parseMarketPolicy({ ...good, prediction_allowed_templates: ["NOPE"] });
    expect(p.allowedTemplates).toEqual([]);
    expect(p.ingestionTemplates).toEqual(["MONEYLINE", "TOTAL"]);
    expect(p.fixtureMarketsEnabled).toBe(true);
  });
});

describe("marketsOfAllowedTemplates", () => {
  const markets = [{ id: "a", marketTemplate: "MONEYLINE" }, { id: "b", marketTemplate: "SPREAD" }, { id: "c", marketTemplate: "TOTAL" }];
  it("keeps only the offered templates, in order, and offers nothing for an empty list", () => {
    expect(marketsOfAllowedTemplates(markets, ["MONEYLINE"]).map((m) => m.id)).toEqual(["a"]);
    expect(marketsOfAllowedTemplates(markets, ["MONEYLINE", "TOTAL"]).map((m) => m.id)).toEqual(["a", "c"]);
    expect(marketsOfAllowedTemplates(markets, [])).toEqual([]);
  });
});
