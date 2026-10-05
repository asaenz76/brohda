import "server-only";
import { isAdminOrAbove } from "@/lib/auth/guards";
import { getWalletBalanceSummary } from "@/lib/wallet/reservations";
import { isMonetaryP2pEnabled } from "./policy";
import type { UserProfile } from "@/lib/auth/session";

// The one place that decides what a signed-in person may SEE of the optional
// money layer. `monetary_p2p_enabled` is the single product flag behind it;
// nothing else in the app should re-derive "is money on?" from the setting.
//
//   enabled      money is on: new offers, acceptance, funding, and the copy
//                that explains them. Fails CLOSED — if the setting can't be
//                read it is treated as off (isMonetaryP2pEnabled never turns
//                an error into "on").
//   canSeeWallet the wallet may be reached. True when money is on, when the
//                viewer is an operator (admin / super admin — the consumer
//                flag must never blind the people who run the platform), or
//                when the viewer still has money in the system: a balance or
//                a hold. Turning the feature off stops NEW participation; it
//                must not strand funds a person is owed or a hold that only
//                a terminal action can release.
//   windDownOnly the wallet is reachable only for that last reason: show the
//                balance and let them take their money out, but offer no
//                funding.
//
// The database functions stay the authority on every rule (propose_money and
// accept_monetary_proposal both refuse when the flag is off); this only
// decides what the consumer UI shows.
export interface ConsumerMonetaryAccess {
  enabled: boolean;
  canSeeWallet: boolean;
  windDownOnly: boolean;
  isOperator: boolean;
}

export function deriveConsumerMonetaryAccess({
  flagEnabled,
  isOperator,
  totalCents,
  heldCents,
}: {
  flagEnabled: boolean;
  isOperator: boolean;
  /** Balance plus holds (what the person has in the system). */
  totalCents: number;
  heldCents: number;
}): ConsumerMonetaryAccess {
  const hasFundsOrHolds = totalCents > 0 || heldCents > 0;
  const canSeeWallet = flagEnabled || isOperator || hasFundsOrHolds;
  return { enabled: flagEnabled, canSeeWallet, windDownOnly: canSeeWallet && !flagEnabled && !isOperator, isOperator };
}

/** Whether optional money is on for consumers. Fail-closed (an unreadable setting reads as off). */
export async function isConsumerMonetaryEnabled(): Promise<boolean> {
  try {
    return await isMonetaryP2pEnabled();
  } catch {
    return false;
  }
}

/** The viewer's access, reading the flag and (unless supplied) their wallet. */
export async function getConsumerMonetaryAccess(user: UserProfile, wallet?: { totalCents: number; heldCents: number }): Promise<ConsumerMonetaryAccess> {
  const flagEnabled = await isConsumerMonetaryEnabled();
  const isOperator = isAdminOrAbove(user);
  if (flagEnabled || isOperator) return deriveConsumerMonetaryAccess({ flagEnabled, isOperator, totalCents: 0, heldCents: 0 });
  let totalCents = wallet?.totalCents;
  let heldCents = wallet?.heldCents;
  if (totalCents === undefined || heldCents === undefined) {
    try {
      const summary = await getWalletBalanceSummary(user.id);
      totalCents = summary.total;
      heldCents = summary.reserved;
    } catch {
      // Unreadable wallet: fail closed for the nav, but don't pretend there are funds.
      totalCents = 0;
      heldCents = 0;
    }
  }
  return deriveConsumerMonetaryAccess({ flagEnabled, isOperator, totalCents, heldCents });
}
