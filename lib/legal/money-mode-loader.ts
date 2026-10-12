import "server-only";
import { isConsumerMonetaryEnabled } from "@/lib/monetary/capability";
import { deriveLegalMoneyMode, type LegalMoneyMode } from "./money-mode";

export interface LegalMoneyModeDeps {
  isEnabled?: () => Promise<boolean>;
}

/**
 * The mode the Member-facing legal and policy pages render in RIGHT NOW. Read per request from the one canonical capability (no cache, no deploy): flipping
 * monetary_p2p_enabled changes /terms, /rules and /privacy on the next load. Fails closed — if the capability can't be read, money copy stays hidden.
 */
export async function loadLegalMoneyMode(deps: LegalMoneyModeDeps = {}): Promise<LegalMoneyMode> {
  const isEnabled = deps.isEnabled ?? isConsumerMonetaryEnabled; // already fails closed
  const flagEnabled = await isEnabled().then((v) => v === true, () => null);
  return deriveLegalMoneyMode({ flagEnabled });
}
