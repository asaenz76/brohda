import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth/session";
import { formatCents } from "@/lib/utils/money";
import { humanizeEnum } from "@/lib/utils/humanize";
import { walletTransactionLabel } from "@/lib/wallet/transaction-copy";
import { Card, CardContent } from "@/components/ui/card";
import {
  getHouseRevenue,
  getJobHealth,
  getPendingReviewPools,
  getPoolStatusCounts,
  getTransactionTypeTotals,
  getUserCounts,
} from "@/lib/reports/fetch";
import type { JobHealthStatus } from "@/lib/jobs/health";

// Deliberately not text-credit/text-debit (globals.css reserves those for
// wallet transaction direction) — this is a separate operational-status
// scale, not a money signal.
function jobHealthStatusClass(status: JobHealthStatus): string {
  if (status === "failed") return "font-medium text-danger";
  if (status === "degraded" || status === "stale") return "font-medium text-warning-muted";
  if (status === "never_run") return "text-text-muted";
  return "font-medium text-text-primary";
}

export default async function AdminReportsPage() {
  await requireSuperAdmin();

  const [userCounts, poolStatusCounts, pendingReviews, houseRevenue, jobHealth, transactionTotals] =
    await Promise.all([
      getUserCounts(),
      getPoolStatusCounts(),
      getPendingReviewPools(),
      getHouseRevenue(),
      getJobHealth(),
      getTransactionTypeTotals(),
    ]);

  const netHouseRevenue =
    houseRevenue.feeCreditTotal + houseRevenue.remainderCreditTotal - houseRevenue.reversalDebitTotal;

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Reports</h1>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="space-y-1 pt-6">
            <h2 className="text-sm font-semibold text-text-primary">Users</h2>
            <p className="text-sm text-text-secondary">
              {userCounts.total} total · {userCounts.active} active · {userCounts.inactive} inactive
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-1 pt-6">
            <h2 className="text-sm font-semibold text-text-primary">House revenue</h2>
            <p className="text-sm text-text-secondary">
              Net: {formatCents(netHouseRevenue)} (current balance {formatCents(houseRevenue.currentBalance)})
            </p>
            <p className="text-xs text-text-muted">
              Fees {formatCents(houseRevenue.feeCreditTotal)} · Rounding{" "}
              {formatCents(houseRevenue.remainderCreditTotal)} · Reversed{" "}
              {formatCents(houseRevenue.reversalDebitTotal)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="space-y-2 pt-6">
          <h2 className="text-sm font-semibold text-text-primary">Pools by status</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            {Object.entries(poolStatusCounts).map(([status, count]) => (
              <div key={status} className="flex justify-between gap-2">
                <dt className="text-text-muted">{humanizeEnum(status)}</dt>
                <dd className="text-text-primary">{count}</dd>
              </div>
            ))}
            {Object.keys(poolStatusCounts).length === 0 && (
              <p className="text-text-muted">No pools yet.</p>
            )}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-6">
          <h2 className="text-sm font-semibold text-text-primary">
            Pending admin attention ({pendingReviews.length})
          </h2>
          {pendingReviews.length === 0 ? (
            <p className="text-sm text-text-muted">Nothing needs review right now.</p>
          ) : (
            <ul className="space-y-1">
              {pendingReviews.map((pool) => (
                <li key={pool.id} className="flex items-center justify-between gap-2 text-sm">
                  <Link
                    href={`/admin/pools/${pool.id}`}
                    className="text-accent-primary underline underline-offset-4"
                  >
                    {pool.question}
                  </Link>
                  <span className="text-text-muted">{humanizeEnum(pool.status)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-6">
          <h2 className="text-sm font-semibold text-text-primary">Job health</h2>
          <p className="text-xs text-text-muted">
            Every production lifecycle job (lib/jobs/registry.ts), sourced live from `background_jobs` — not a
            hard-coded list. A flag-gated job that fires on schedule but does nothing because its feature is
            disabled shows as &ldquo;No-op / healthy&rdquo;, distinct from &ldquo;Stale&rdquo; (the scheduler itself
            hasn&rsquo;t fired recently).
          </p>
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            {jobHealth.jobs.map((entry) => (
              <div key={entry.job.id} className="rounded-lg border border-border-subtle p-2">
                <dt className="font-medium text-text-primary">{entry.job.displayName}</dt>
                <dd className="text-xs text-text-muted">{entry.job.category}</dd>
                <dd className={jobHealthStatusClass(entry.status)}>{humanizeEnum(entry.status)}</dd>
                <dd className="text-xs text-text-muted">
                  {entry.lastAttemptedAt ? new Date(entry.lastAttemptedAt).toLocaleString() : "Never run"}
                </dd>
                {entry.lastResultSummary && <dd className="text-xs text-text-muted">{entry.lastResultSummary}</dd>}
                {entry.lastError && <dd className="text-xs text-danger">{entry.lastError}</dd>}
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-6">
          <h2 className="text-sm font-semibold text-text-primary">Ledger transactions by type</h2>
          <div className="overflow-x-auto rounded-xl border border-border-subtle">
            <table className="w-full text-sm">
              <thead className="bg-surface-secondary text-left text-text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Credited</th>
                  <th className="px-3 py-2 font-medium">Debited</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {Object.entries(transactionTotals).map(([type, totals]) => (
                  <tr key={type}>
                    <td className="px-3 py-2 text-text-primary">{walletTransactionLabel(type)}</td>
                    <td className="px-3 py-2 font-medium text-credit">{formatCents(totals.credit)}</td>
                    <td className="px-3 py-2 font-medium text-debit">{formatCents(totals.debit)}</td>
                  </tr>
                ))}
                {Object.keys(transactionTotals).length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-8 text-center text-text-muted">
                      No transactions yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
