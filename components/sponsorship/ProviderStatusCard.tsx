import { onvoAvailability, resolveOnvoConfig, sponsorCheckoutOffered } from "@/lib/payments/config";

// Super Admin: is online payment configured, and in which mode? Operational, not decorative — no key or secret is ever shown, only whether each piece is present.
export function ProviderStatusCard() {
  const a = onvoAvailability();
  const hasWebhookSecret = Boolean(process.env.ONVO_WEBHOOK_SECRET?.trim());
  const resolved = resolveOnvoConfig();
  const liveDisabled = !(a.state === "live");
  return (
    <section aria-label="Online payment status" data-slot="provider-status" className="space-y-1 rounded-lg border border-border-subtle p-3 text-sm">
      <h2 className="text-sm font-semibold text-text-primary">Online payments (ONVO)</h2>
      <p className="text-text-secondary">
        Environment: <span className="font-medium text-text-primary" data-slot="provider-environment">{a.state === "unavailable" ? "Unavailable" : a.state === "test" ? "TEST" : "LIVE"}</span>
      </p>
      <p className="text-text-secondary">
        Webhook secret: <span className="font-medium text-text-primary">{hasWebhookSecret ? "configured" : "not configured"}</span>
      </p>
      <p className="text-text-secondary">
        Live payments: <span className="font-medium text-text-primary">{liveDisabled ? "disabled" : "enabled"}</span>
      </p>
      <p className="text-text-secondary">
        Offered to Sponsors: <span className="font-medium text-text-primary">{sponsorCheckoutOffered() ? "yes" : "no"}</span>
      </p>
      {!resolved.ok && <p className="text-xs text-text-muted">{resolved.reason}</p>}
      <p className="text-xs text-text-muted">Manual payment (Super Admin marks a payment received) is always available. ONVO is for sponsorship payments only — it is not the player money provider.</p>
    </section>
  );
}
