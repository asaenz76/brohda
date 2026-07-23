import { Landmark } from "lucide-react";
import { getHouseRevenue } from "@/lib/reports/fetch";
import { formatCents } from "@/lib/utils/money";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { getHouseLedgerEntries } from "@/lib/wallet/ledger";
import { TransactionList } from "@/components/activity/TransactionList";

// The admin's own wallet_balances row (account_type='user') is always
// empty — admins don't enter pools. What an admin actually means by "my
// wallet" is the platform's house account: the singleton row
// (account_type='house', user_id=null) that accrues coordinator fees on
// every settlement. See lib/reports/fetch.ts's getHouseRevenue() for the
// same balance already surfaced on /admin/reports as an aggregate; this
// view adds the per-transaction breakdown.
export async function HouseRevenueView() {
  const [revenue, entries] = await Promise.all([getHouseRevenue(), getHouseLedgerEntries()]);

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Ledger</h1>

      <div className="rounded-2xl border border-border-subtle bg-surface-primary p-4">
        <p className="text-sm text-text-muted">Platform revenue</p>
        <p className="text-2xl font-bold text-text-primary">{formatCents(revenue.currentBalance)}</p>
        <p className="mt-1 text-xs text-text-muted">
          Coordinator fees collected across all pools, net of anything reversed.
        </p>
        <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <div>
            <dt className="text-text-muted">Fees</dt>
            <dd className="font-medium text-credit">{formatCents(revenue.feeCreditTotal)}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Rounding</dt>
            <dd className="font-medium text-credit">{formatCents(revenue.remainderCreditTotal)}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Reversed</dt>
            <dd className="font-medium text-debit">{formatCents(revenue.reversalDebitTotal)}</dd>
          </div>
        </dl>
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-text-primary">Revenue activity</h2>
        {entries.length === 0 && (
          <EmptyFeedState
            icon={Landmark}
            title="No revenue yet"
            description="Coordinator fees from settled pools will show up here."
          />
        )}
        {entries.length > 0 && <TransactionList entries={entries} />}
      </div>
    </div>
  );
}
