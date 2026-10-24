// Brohda 2.1 M2: pure parsing of the four Market/Pick policy settings. FAIL CLOSED, per field: a value that is missing, the wrong type or contains anything that is not a real
// template never broadens what Members can do or what ingestion writes. (A true technical invariant — which templates exist at all — is a constant here and a CHECK in the database.)

export const MARKET_TEMPLATES = ["MONEYLINE", "SPREAD", "TOTAL"] as const;
export type PolicyMarketTemplate = (typeof MARKET_TEMPLATES)[number];

export interface MarketPolicy {
  /** Whether the market job may create a Game's canonical MONEYLINE Market from the Game itself. */
  fixtureMarketsEnabled: boolean;
  /** Whether a Market needs usable price data before a Member may Pick it. */
  requirePrice: boolean;
  /** Templates a Member may START new interaction with (new Pick, new Call BS). */
  allowedTemplates: PolicyMarketTemplate[];
  /** Templates sportsbook ingestion may create/update (intersected with each sport's own registered templates). */
  ingestionTemplates: PolicyMarketTemplate[];
}

export const FAIL_CLOSED_MARKET_POLICY: MarketPolicy = { fixtureMarketsEnabled: false, requirePrice: true, allowedTemplates: [], ingestionTemplates: [] };

/** A list is valid only if it is an array whose every element is a real template. Anything else is "nothing" — never "everything". */
export function parseTemplateList(value: unknown): PolicyMarketTemplate[] {
  if (!Array.isArray(value)) return [];
  const known = new Set<string>(MARKET_TEMPLATES);
  if (!value.every((v) => typeof v === "string" && known.has(v))) return [];
  return [...new Set(value as PolicyMarketTemplate[])];
}

/** The Markets Members are currently offered (M2): those whose template is on the allow-list. Everything else stays in the database and in history; it just isn't offered. */
export function marketsOfAllowedTemplates<T extends { marketTemplate: string }>(markets: readonly T[], allowed: readonly string[]): T[] {
  return markets.filter((m) => allowed.includes(m.marketTemplate));
}

export function parseMarketPolicy(row: unknown): MarketPolicy {
  if (!row || typeof row !== "object") return FAIL_CLOSED_MARKET_POLICY;
  const r = row as Record<string, unknown>;
  return {
    fixtureMarketsEnabled: r.fixture_markets_enabled === true,
    // Only an explicit `false` relaxes the price rule.
    requirePrice: r.prediction_require_price !== false,
    allowedTemplates: parseTemplateList(r.prediction_allowed_templates),
    ingestionTemplates: parseTemplateList(r.market_ingestion_templates),
  };
}
