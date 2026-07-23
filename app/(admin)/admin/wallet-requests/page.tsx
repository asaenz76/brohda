import { createClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/auth/session";
import { formatCents } from "@/lib/utils/money";
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from "@/lib/payment-methods/constants";
import { ReviewForm } from "./review-form";

const STATUS_STYLE: Record<string, string> = {
  pending: "text-text-secondary",
  approved: "font-medium text-text-primary",
  rejected: "text-danger",
};

export default async function AdminWalletRequestsPage() {
  await requireSuperAdmin();
  const supabase = await createClient();

  const { data: requests } = await supabase
    .from("wallet_requests")
    .select(
      "id, user_id, type, amount, status, note, admin_note, intended_pool_id, payment_method, other_method_note, transaction_ref, created_at",
    )
    .order("created_at", { ascending: false });

  const userIds = [...new Set((requests ?? []).map((r) => r.user_id))];
  const { data: users } =
    userIds.length > 0
      ? await supabase.from("user_profiles").select("id, display_name").in("id", userIds)
      : { data: [] };

  const userName = (userId: string) =>
    (users ?? []).find((u) => u.id === userId)?.display_name ?? "Unknown";

  // Quick top-ups (a deposit requested to unlock a specific pool entry) get
  // a "For: <question>" hint below the note, so an admin knows approving
  // this will auto-place that entry, not just credit a balance.
  const intendedPoolIds = [
    ...new Set((requests ?? []).map((r) => r.intended_pool_id).filter((id): id is string => id != null)),
  ];
  const { data: intendedPools } =
    intendedPoolIds.length > 0
      ? await supabase.from("pools").select("id, question").in("id", intendedPoolIds)
      : { data: [] };

  const poolQuestion = (poolId: string | null) =>
    poolId ? ((intendedPools ?? []).find((p) => p.id === poolId)?.question ?? null) : null;

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Ledger Requests</h1>
      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <table className="w-full text-sm">
          <thead className="bg-surface-secondary text-left text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Player</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Amount</th>
              <th className="px-3 py-2 font-medium">Note</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {(requests ?? []).map((request) => (
              <tr key={request.id}>
                <td className="px-3 py-2 text-text-primary">{userName(request.user_id)}</td>
                <td className="px-3 py-2 text-text-secondary capitalize">{request.type}</td>
                <td
                  className={`px-3 py-2 font-medium ${request.type === "deposit" ? "text-credit" : "text-debit"}`}
                >
                  {formatCents(request.amount)}
                </td>
                <td className="px-3 py-2 text-text-secondary">
                  {request.note ?? "—"}
                  {request.payment_method && (
                    <p className="text-xs text-text-muted">
                      Currency: {PAYMENT_METHOD_LABELS[request.payment_method as PaymentMethod]}
                    </p>
                  )}
                  {request.other_method_note && (
                    <p className="text-xs text-text-muted">Other: {request.other_method_note}</p>
                  )}
                  {request.transaction_ref && (
                    <p className="text-xs text-text-muted">Txn ID: {request.transaction_ref}</p>
                  )}
                  {poolQuestion(request.intended_pool_id) && (
                    <p className="text-xs text-text-muted">
                      Quick top-up for: {poolQuestion(request.intended_pool_id)}
                    </p>
                  )}
                </td>
                <td className={`px-3 py-2 font-medium capitalize ${STATUS_STYLE[request.status]}`}>
                  {request.status}
                </td>
                <td className="px-3 py-2 text-right">
                  {request.status === "pending" && <ReviewForm requestId={request.id} />}
                </td>
              </tr>
            ))}
            {(!requests || requests.length === 0) && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-text-muted">
                  No wallet requests yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
