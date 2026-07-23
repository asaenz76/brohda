import { requireSuperAdmin } from "@/lib/auth/session";
import { getRegistrationEnabled } from "@/lib/settings/registration";
import { getPaymentMethods } from "@/lib/payment-methods/fetch";
import { Card, CardContent } from "@/components/ui/card";
import { RegistrationToggle } from "./registration-toggle";
import { PaymentMethodsSettings } from "./payment-methods-settings";

export default async function AdminSettingsPage() {
  await requireSuperAdmin();
  const [registrationEnabled, paymentMethods] = await Promise.all([
    getRegistrationEnabled(),
    getPaymentMethods(),
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
          <PaymentMethodsSettings methods={paymentMethods} />
        </CardContent>
      </Card>
    </div>
  );
}
