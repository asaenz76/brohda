import { getOnlinePaymentPolicy, resolveOnlinePayment } from "@/lib/payments/active-provider";
import { registeredProviders } from "@/lib/payments/registry";
import { OnlinePaymentsForm } from "./OnlinePaymentsForm";

// Super Admin: ONLINE SPONSORSHIP PAYMENTS. Provider-neutral — the provider's name appears only as DATA (its registered label), never as copy. Operational, not decorative: no
// key or secret is ever shown, only whether the selected provider's configuration is complete. Disabling stops NEW online payments only; manual payment is always available.
export async function OnlinePaymentsCard() {
  const [policy, resolved] = await Promise.all([getOnlinePaymentPolicy(), resolveOnlinePayment()]);
  const providers = registeredProviders();
  const label = policy.providerKey ? (providers.find((p) => p.key === policy.providerKey)?.label ?? `${policy.providerKey} (not installed)`) : "—";
  const environment = resolved.state === "available" ? resolved.environment : "UNAVAILABLE";
  const configuration = resolved.state === "available" ? "Ready" : "Incomplete";
  return (
    <section aria-label="Online sponsorship payments" data-slot="online-payments-status" className="space-y-2 rounded-lg border border-border-subtle p-3 text-sm">
      <h2 className="text-sm font-semibold text-text-primary">Online sponsorship payments</h2>
      {resolved.state === "disabled" ? (
        <p className="text-text-secondary">
          Status: <span className="font-medium text-text-primary" data-slot="online-payments-state">Disabled</span>
        </p>
      ) : (
        <>
          <p className="text-text-secondary">
            Status: <span className="font-medium text-text-primary" data-slot="online-payments-state">Enabled</span>
          </p>
          <p className="text-text-secondary">
            Provider: <span className="font-medium text-text-primary" data-slot="online-payments-provider">{label}</span>
          </p>
          <p className="text-text-secondary">
            Environment: <span className="font-medium text-text-primary" data-slot="provider-environment">{environment}</span>
          </p>
          <p className="text-text-secondary">
            Configuration: <span className="font-medium text-text-primary" data-slot="online-payments-configuration">{configuration}</span>
          </p>
          {resolved.state === "unavailable" && <p className="text-xs text-text-muted">{resolved.reason} Sponsors aren&apos;t offered online payment until this is fixed — nothing falls back to another provider.</p>}
          {resolved.state === "available" && (
            <p className="text-text-secondary">
              Offered to Sponsors: <span className="font-medium text-text-primary">{resolved.offered ? "yes" : "no"}</span>
            </p>
          )}
        </>
      )}
      <OnlinePaymentsForm current={policy.enabled && policy.providerKey ? policy.providerKey : "DISABLED"} options={providers} />
      <p className="text-xs text-text-muted">
        Applies to new payments immediately. A payment already started stays with the provider that created it, and its confirmations and refunds are still handled. Manual payment (Super Admin marks a payment received) is always available. This is for sponsorship payments only — never player money.
      </p>
    </section>
  );
}
