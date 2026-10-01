import { requireSuperAdmin } from "@/lib/auth/session";
import { getRegistrationEnabled } from "@/lib/settings/registration";
import { getPaymentMethods } from "@/lib/payment-methods/fetch";
import { apiNflProvider } from "@/lib/sports-data/api-nfl-provider";
import { getProviderStatus } from "@/lib/sports-data/provider-gateway";
import { API_NFL_PROVIDER } from "@/lib/sports-data/provider-names";
import { Card, CardContent } from "@/components/ui/card";
import Link from "next/link";
import { RegistrationToggle } from "./registration-toggle";
import { PaymentMethodsSettings } from "./payment-methods-settings";
import { ProviderStatusPanel } from "./provider-status-panel";

export default async function AdminSettingsPage() {
  await requireSuperAdmin();
  // Both providers' health is fetched independently — spec §5/§6/§23:
  // one provider's status must never reflect or be gated by the other's,
  // and opening this page must never make a live provider request itself
  // (getProviderStatus only ever reads provider_request_log).
  const [registrationEnabled, paymentMethods, nflStatus] = await Promise.all([
    getRegistrationEnabled(),
    getPaymentMethods(),
    getProviderStatus(apiNflProvider.isEnabled(), API_NFL_PROVIDER),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Settings</h1>
      <p className="text-sm text-text-muted">
        Platform-level settings. Brohda 2.0 product and operational policy (Predictions, Markets, Communities, Conversation, Call BS, Monetary P2P, Reputation, Operations) lives in a{" "}
        <Link href="/admin/settings/brohda" className="font-medium text-accent-primary hover:underline">
          dedicated Brohda Settings area
        </Link>
        .
      </p>
      <Card>
        <CardContent className="pt-6">
          <RegistrationToggle initialEnabled={registrationEnabled} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6">
          <PaymentMethodsSettings methods={paymentMethods} />
        </CardContent>
      </Card>
      <ProviderStatusPanel
        provider={API_NFL_PROVIDER}
        label="API-NFL"
        enabledEnvHint="The NFL sports data provider isn't enabled. Set API_NFL_ENABLED=true and a valid API_NFL_KEY to use it."
        status={nflStatus}
      />
    </div>
  );
}
