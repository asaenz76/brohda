import { requireSuperAdmin } from "@/lib/auth/session";
import { getRegistrationEnabled } from "@/lib/settings/registration";
import { getPoolFeeDefaults } from "@/lib/settings/pool-defaults";
import { getPaymentMethods } from "@/lib/payment-methods/fetch";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { apiNflProvider } from "@/lib/sports-data/api-nfl-provider";
import { getProviderStatus } from "@/lib/sports-data/provider-gateway";
import { API_FOOTBALL_PROVIDER, API_NFL_PROVIDER } from "@/lib/sports-data/provider-names";
import { formatBps } from "@/lib/utils/money";
import { Card, CardContent } from "@/components/ui/card";
import { RegistrationToggle } from "./registration-toggle";
import { PaymentMethodsSettings } from "./payment-methods-settings";
import { PoolFeeDefaultsForm } from "./pool-fee-defaults-form";
import { ProviderStatusPanel } from "./provider-status-panel";

export default async function AdminSettingsPage() {
  await requireSuperAdmin();
  // Both providers' health is fetched independently — spec §5/§6/§23:
  // one provider's status must never reflect or be gated by the other's,
  // and opening this page must never make a live provider request itself
  // (getProviderStatus only ever reads provider_request_log).
  const [registrationEnabled, poolFeeDefaults, paymentMethods, footballStatus, nflStatus] = await Promise.all([
    getRegistrationEnabled(),
    getPoolFeeDefaults(),
    getPaymentMethods(),
    getProviderStatus(apiFootballProvider.isEnabled(), API_FOOTBALL_PROVIDER),
    getProviderStatus(apiNflProvider.isEnabled(), API_NFL_PROVIDER),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Settings</h1>
      <Card>
        <CardContent className="pt-6">
          <RegistrationToggle initialEnabled={registrationEnabled} />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6">
          <PoolFeeDefaultsForm
            initialEntryFee={(poolFeeDefaults.entryFeeCents / 100).toFixed(2)}
            initialHouseFeePercent={formatBps(poolFeeDefaults.houseFeeBps).replace("%", "")}
          />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6">
          <PaymentMethodsSettings methods={paymentMethods} />
        </CardContent>
      </Card>
      <ProviderStatusPanel
        provider={API_FOOTBALL_PROVIDER}
        label="API-Football"
        enabledEnvHint="The sports data provider isn't enabled. Set API_FOOTBALL_ENABLED=true and a valid API_FOOTBALL_KEY to use it."
        status={footballStatus}
      />
      <ProviderStatusPanel
        provider={API_NFL_PROVIDER}
        label="API-NFL"
        enabledEnvHint="The NFL sports data provider isn't enabled. Set API_NFL_ENABLED=true and a valid API_NFL_KEY to use it."
        status={nflStatus}
      />
    </div>
  );
}
