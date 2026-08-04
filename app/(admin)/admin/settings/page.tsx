import { requireSuperAdmin } from "@/lib/auth/session";
import { getRegistrationEnabled } from "@/lib/settings/registration";
import { getPoolFeeDefaults } from "@/lib/settings/pool-defaults";
import { getPaymentMethods } from "@/lib/payment-methods/fetch";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { getProviderStatus } from "@/lib/sports-data/provider-gateway";
import { formatBps } from "@/lib/utils/money";
import { Card, CardContent } from "@/components/ui/card";
import { RegistrationToggle } from "./registration-toggle";
import { PaymentMethodsSettings } from "./payment-methods-settings";
import { PoolFeeDefaultsForm } from "./pool-fee-defaults-form";
import { ProviderStatusPanel } from "./provider-status-panel";

export default async function AdminSettingsPage() {
  await requireSuperAdmin();
  const [registrationEnabled, poolFeeDefaults, paymentMethods, providerStatus] = await Promise.all([
    getRegistrationEnabled(),
    getPoolFeeDefaults(),
    getPaymentMethods(),
    getProviderStatus(apiFootballProvider.isEnabled()),
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
      <ProviderStatusPanel status={providerStatus} />
    </div>
  );
}
