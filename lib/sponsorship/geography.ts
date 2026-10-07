// Sponsorship geography is DATA (a market code on the inventory), enforced only with signals Brohda actually trusts.
//
// Audit result: Brohda stores no per-viewer location (no country, no IP-derived region; only an analytics timezone the member chose). Inferring a
// person's country from unrelated data is exactly what we must not do, so today the only market a viewer can be shown is GLOBAL. A sponsorship sold for a
// country-level code is stored, reviewed and paid like any other, but it is never publicly shown until a reliable viewer-market signal is added here —
// one function, so finer targeting is a change in this file only.
export const GLOBAL_MARKET = "GLOBAL";

/** The markets the current viewer may be shown sponsorship for. Never exposes or infers the individual's location. */
export function viewerMarkets(): readonly string[] {
  return [GLOBAL_MARKET];
}
