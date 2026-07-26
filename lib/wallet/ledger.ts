import "server-only";
import { createClient } from "@/lib/supabase/server";
import { fetchInChunks } from "@/lib/pools/fetch";
import { walletTransactionLabel } from "./transaction-copy";

export interface LedgerEntrySettlement {
  grossPool: number;
  houseFeeAmount: number;
  netPrizePool: number;
  winningEntryCount: number | null;
  payoutPerEntry: number;
  roundingRemainder: number;
}

export interface LedgerEntry {
  id: string;
  label: string;
  direction: "credit" | "debit";
  amount: number;
  reason: string | null;
  createdAt: string;
  balanceBefore: number | null;
  balanceAfter: number | null;
  poolId: string | null;
  /** The pool's title if it has one (COMBO), else its question. Snapshotted
   *  onto the transaction at write time (apply_wallet_transaction), not
   *  read live from `pools` — so it survives that pool being hard-deleted
   *  later, unlike a join would. */
  poolQuestion: string | null;
  /** "Home team vs Away team", only for pools tied to a real fixture. */
  fixtureLabel: string | null;
  competitionName: string | null;
  /** Which option this transaction's entry was on, e.g. "Yes" or a team
   *  name — only set for pool_entry_debit/pool_payout_credit rows. */
  optionLabel: string | null;
  adminName: string | null;
  settlement: LedgerEntrySettlement | null;
  /** Where a withdrawal's funds should be sent (e.g. "Venmo: @janedoe"),
   *  snapshotted from the wallet_request's `note` at approval time. Null
   *  for every other transaction type. */
  destination: string | null;
}

const LEDGER_COLUMNS =
  "id, type, direction, amount, reason, created_at, pool_id, settlement_id, admin_id, balance_before, balance_after, pool_question, fixture_label, competition_name, option_label, destination";

type LedgerRow = {
  id: string;
  type: string;
  direction: "credit" | "debit";
  amount: number;
  reason: string | null;
  created_at: string;
  pool_id: string | null;
  settlement_id: string | null;
  admin_id: string | null;
  balance_before: number | null;
  balance_after: number | null;
  pool_question: string | null;
  fixture_label: string | null;
  competition_name: string | null;
  option_label: string | null;
  destination: string | null;
};

/**
 * One shared shaping of a wallet_transactions history — every field a
 * "transaction detail" view could ever want, resolved once so /activity,
 * /wallet, and the house revenue view all render the exact same ledger
 * rather than three independently-fetched subsets. Pool/fixture/option
 * context comes straight off the row itself (stamped by
 * apply_wallet_transaction at write time) rather than a live join through
 * pool_id/entry_id — a pool can be hard-deleted later (even a SETTLED one,
 * that's a normal admin action), which would otherwise silently erase this
 * context depending only on whether that one pool still happens to exist.
 * Only the settlement breakdown and admin display name still need a fetch;
 * neither is snapshotted (settlements has its own lifecycle/history table,
 * and an admin's name can legitimately change).
 */
async function shapeLedgerRows(rows: LedgerRow[]): Promise<LedgerEntry[]> {
  const supabase = await createClient();

  const settlementIds = [
    ...new Set(rows.map((t) => t.settlement_id).filter((id): id is string => id != null)),
  ];
  const adminIds = [...new Set(rows.map((t) => t.admin_id).filter((id): id is string => id != null))];

  const [settlements, admins] = await Promise.all([
    fetchInChunks(settlementIds, (chunk) =>
      supabase
        .from("settlements")
        .select(
          "id, gross_pool, house_fee_amount, net_prize_pool, winning_entry_count, payout_per_entry, rounding_remainder",
        )
        .in("id", chunk),
    ),
    fetchInChunks(adminIds, (chunk) =>
      supabase.from("user_profiles").select("id, display_name").in("id", chunk),
    ),
  ]);

  const settlementById = new Map(settlements.map((s) => [s.id, s]));
  const adminById = new Map(admins.map((a) => [a.id, a]));

  return rows.map((t) => {
    const settlement = t.settlement_id ? settlementById.get(t.settlement_id) : undefined;
    const admin = t.admin_id ? adminById.get(t.admin_id) : undefined;

    return {
      id: t.id,
      label: walletTransactionLabel(t.type),
      direction: t.direction,
      amount: t.amount,
      reason: t.reason,
      createdAt: t.created_at,
      balanceBefore: t.balance_before,
      balanceAfter: t.balance_after,
      poolId: t.pool_id,
      poolQuestion: t.pool_question,
      fixtureLabel: t.fixture_label,
      competitionName: t.competition_name,
      optionLabel: t.option_label,
      adminName: admin?.display_name ?? null,
      destination: t.destination,
      settlement: settlement
        ? {
            grossPool: settlement.gross_pool,
            houseFeeAmount: settlement.house_fee_amount,
            netPrizePool: settlement.net_prize_pool,
            winningEntryCount: settlement.winning_entry_count,
            payoutPerEntry: settlement.payout_per_entry,
            roundingRemainder: settlement.rounding_remainder,
          }
        : null,
    };
  });
}

/** A player's own wallet_transactions history. */
export async function getLedgerEntries(userId: string): Promise<LedgerEntry[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("wallet_transactions")
    .select(LEDGER_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  return shapeLedgerRows(data ?? []);
}

/** The platform's own singleton house account — platform fees, rounding
 *  remainders, and reversal debits, spanning every settlement ever produced
 *  rather than one user's history. Used by the super_admin's own "wallet". */
export async function getHouseLedgerEntries(): Promise<LedgerEntry[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("wallet_transactions")
    .select(LEDGER_COLUMNS)
    .eq("account_type", "house")
    .order("created_at", { ascending: false });

  return shapeLedgerRows(data ?? []);
}
