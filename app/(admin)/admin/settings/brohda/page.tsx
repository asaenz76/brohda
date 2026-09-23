import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth/session";
import { getBrohdaSettings } from "@/lib/admin-settings/repository";
import {
  PredictionSettingsSection,
  NotificationSettingsSection,
  MarketSettingsSection,
  CommunitySettingsSection,
  ConversationSettingsSection,
  CallBsSettingsSection,
  MonetarySettingsSection,
  ReputationSettingsSection,
  OperationsSettingsSection,
} from "./settings-sections";

// Milestone R12. A NEW, separate admin surface — deliberately does not
// hijack the pre-existing /admin/settings page (legacy pool defaults,
// registration, payment methods, provider status), which stays untouched.
// super_admin-only, mirroring that page's own established monolithic gate
// (§7 — see docs/architecture/admin-configuration.md's "Role model"
// section): nearly every setting here is a significant product or
// financial lever, so this milestone does not introduce a new, unproven
// per-domain admin/super_admin split.
export default async function BrohdaSettingsPage() {
  await requireSuperAdmin();
  const settings = await getBrohdaSettings();

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Brohda Settings</h1>
          <p className="text-sm text-text-muted">
            Product and operational policy for Predictions, Markets, Communities, Conversation, Call BS, Monetary P2P, Reputation, and Operations.
            {settings.updatedByDisplayName ? ` Last changed by ${settings.updatedByDisplayName} on ${new Date(settings.updatedAt).toLocaleString()}.` : ""}
          </p>
        </div>
        <Link href="/admin/settings/brohda/history" className="shrink-0 text-sm font-medium text-accent-primary hover:underline">
          View change history
        </Link>
      </div>

      <PredictionSettingsSection initial={settings.predictions} updatedAt={settings.updatedAt} />
      <NotificationSettingsSection initial={settings.notifications} updatedAt={settings.updatedAt} />
      <MarketSettingsSection initial={settings.markets} updatedAt={settings.updatedAt} />
      <CommunitySettingsSection initial={settings.communities} updatedAt={settings.updatedAt} />
      <ConversationSettingsSection initial={settings.conversation} updatedAt={settings.updatedAt} />
      <CallBsSettingsSection initial={settings.callBs} updatedAt={settings.updatedAt} />
      <MonetarySettingsSection initial={settings.monetary} updatedAt={settings.updatedAt} />
      <ReputationSettingsSection initial={settings.reputation} updatedAt={settings.updatedAt} />
      <OperationsSettingsSection initial={settings.operations} updatedAt={settings.updatedAt} />
    </div>
  );
}
