import { requireSimulatedExecutionDiagnosticsViewer } from "@/lib/execution/authorization";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone 5 admin/diagnostic support — read-only, deliberately, exactly
// mirroring the Prediction diagnostics precedent
// (app/(admin)/admin/predictions/page.tsx): no edit, no delete, no
// override. Gated by a capability boundary
// (view_simulated_execution_diagnostics), not a direct requireSuperAdmin()
// call. Uses the admin client because RLS on order_intents only permits a
// user to read their own rows — this page's own authorization gate is
// what authorizes the cross-user read.
export default async function AdminSimulatedExecutionPage() {
  await requireSimulatedExecutionDiagnosticsViewer();
  const admin = createAdminClient();
  const { data: orderIntents } = await admin
    .from("order_intents")
    .select(
      "id, quote_id, user_id, market_id, selected_side, requested_amount_cents, quoted_effective_price, quoted_total_fee_estimate_cents, quoted_slippage_bps, lifecycle_state, result_reason, idempotency_key, confirmed_at",
    )
    .order("confirmed_at", { ascending: false })
    .limit(200);

  return (
    <div className="space-y-4">
      <h1 className="sr-only">Simulated Execution</h1>
      <p className="text-sm text-text-secondary">
        Read-only diagnostic view of the 200 most recent simulated OrderIntents. No real financial exposure exists for any row here.
      </p>
      <div className="overflow-x-auto rounded-xl border border-border-subtle">
        <table className="w-full text-sm">
          <thead className="bg-surface-secondary text-left text-text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Confirmed</th>
              <th className="px-3 py-2 font-medium">User</th>
              <th className="px-3 py-2 font-medium">Market</th>
              <th className="px-3 py-2 font-medium">Side</th>
              <th className="px-3 py-2 font-medium">Amount</th>
              <th className="px-3 py-2 font-medium">Effective price</th>
              <th className="px-3 py-2 font-medium">Fees</th>
              <th className="px-3 py-2 font-medium">Slippage</th>
              <th className="px-3 py-2 font-medium">State</th>
              <th className="px-3 py-2 font-medium">Reason</th>
              <th className="px-3 py-2 font-medium">Idempotency key</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {(orderIntents ?? []).map((row) => (
              <tr key={row.id}>
                <td className="whitespace-nowrap px-3 py-2 text-text-secondary">{new Date(row.confirmed_at).toLocaleString()}</td>
                <td className="px-3 py-2 text-text-secondary">{row.user_id.slice(0, 8)}</td>
                <td className="px-3 py-2 text-text-secondary">{row.market_id.slice(0, 8)}</td>
                <td className="px-3 py-2 text-text-primary">{row.selected_side}</td>
                <td className="px-3 py-2 text-text-secondary">${(row.requested_amount_cents / 100).toFixed(2)}</td>
                <td className="px-3 py-2 text-text-secondary">{Math.round(Number(row.quoted_effective_price) * 100)}%</td>
                <td className="px-3 py-2 text-text-secondary">${(row.quoted_total_fee_estimate_cents / 100).toFixed(2)}</td>
                <td className="px-3 py-2 text-text-secondary">{(row.quoted_slippage_bps / 100).toFixed(2)}%</td>
                <td className="px-3 py-2 text-text-secondary">{row.lifecycle_state}</td>
                <td className="px-3 py-2 text-text-secondary">{row.result_reason ?? "—"}</td>
                <td className="px-3 py-2 text-text-secondary">{row.idempotency_key.slice(0, 8)}</td>
              </tr>
            ))}
            {(!orderIntents || orderIntents.length === 0) && (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center text-text-muted">
                  No simulated executions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
