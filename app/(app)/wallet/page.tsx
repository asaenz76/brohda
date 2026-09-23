import { Wallet } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { formatCents } from "@/lib/utils/money";
import { cn } from "@/lib/utils";
import { EmptyFeedState } from "@/components/EmptyFeedState";
import { Badge } from "@/components/ui/badge";
import { getLedgerEntries } from "@/lib/wallet/ledger";
import { getWalletBalanceSummary } from "@/lib/wallet/reservations";
import { getPaymentMethods } from "@/lib/payment-methods/fetch";
import { TransactionList } from "@/components/activity/TransactionList";
import { WalletRequestForm } from "./wallet-request-form";
import { HouseRevenueView } from "./house-revenue-view";

// Pending is the state a player is actively waiting and wondering about, so
// it gets the loudest treatment — the same warning-muted "needs attention"
// styling used across /admin. Approved/rejected are already-resolved
// outcomes and stay quiet by comparison.
const STATUS_BADGE_STYLE: Record<string, string> = {
  pending: "bg-warning-muted/20 text-warning-muted",
  approved: "bg-credit/10 text-credit",
  rejected: "bg-danger/10 text-danger",
};

export default async function WalletPage() {
  const user = await requireUser();

  if (user.role === "super_admin") {
    return <HouseRevenueView />;
  }

  const supabase = await createClient();

  const [summary, { data: requests }, entries, paymentMethods] = await Promise.all([
    getWalletBalanceSummary(user.id),
    supabase
      .from("wallet_requests")
      .select("id, type, amount, status, note, admin_note, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false }),
    getLedgerEntries(user.id),
    getPaymentMethods(),
  ]);

  const enabledPaymentMethods = paymentMethods.filter((m) => m.enabled);

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Ledger</h1>

      {/* Confidence starts with clearly seeing what you have — the balance
          is deliberately the loudest number on the page, bigger than any
          button or heading below it. */}
      <div className="rounded-2xl border border-border-subtle bg-surface-primary p-5">
        <p className="text-sm text-text-muted">Current balance</p>
        <p className="text-4xl font-bold text-text-primary">{formatCents(summary.total)}</p>
        {/* Milestone R8: only shown once something actually holds funds —
            a pending withdrawal request today — so the common case (no
            holds) stays exactly as simple as before this milestone. */}
        {summary.reserved > 0 && (
          <div className="mt-3 flex items-center gap-4 border-t border-border-subtle pt-3 text-sm">
            <div>
              <p className="text-text-muted">Available</p>
              <p className="font-medium text-text-primary">{formatCents(summary.available)}</p>
            </div>
            <div>
              <p className="text-text-muted">On hold</p>
              <p className="font-medium text-text-primary">{formatCents(summary.reserved)}</p>
            </div>
          </div>
        )}
      </div>

      <WalletRequestForm paymentMethods={enabledPaymentMethods} />

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-text-primary">Your requests</h2>
        {(!requests || requests.length === 0) && (
          <EmptyFeedState
            icon={Wallet}
            title="No requests yet"
            description="Requesting a deposit or withdrawal above will show up here."
          />
        )}
        {requests && requests.length > 0 && (
          <ul className="space-y-2">
            {requests.map((request) => (
              <li
                key={request.id}
                className="rounded-xl border border-border-subtle bg-surface-primary px-4 py-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-text-primary">
                    {request.type === "deposit" ? "Deposit" : "Withdrawal"} request
                  </span>
                  <Badge className={cn("capitalize", STATUS_BADGE_STYLE[request.status])}>
                    {request.status}
                  </Badge>
                </div>
                <p
                  className={cn(
                    "text-sm font-medium",
                    request.type === "deposit" ? "text-credit" : "text-debit",
                  )}
                >
                  {formatCents(request.amount)}
                </p>
                {request.note && <p className="text-xs text-text-muted">{request.note}</p>}
                {request.admin_note && (
                  <p className="text-xs text-text-muted">Admin note: {request.admin_note}</p>
                )}
                {request.status === "pending" && (
                  <p className="text-xs text-warning-muted">Usually reviewed within a few hours.</p>
                )}
                <p className="text-xs text-text-muted">{new Date(request.created_at).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {entries.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-text-primary">Ledger</h2>
          <TransactionList entries={entries} />
        </div>
      )}
    </div>
  );
}
