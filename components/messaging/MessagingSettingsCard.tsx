import { getMessagingSettingsForAdmin } from "@/lib/messaging/config";
import { MessagingSettingsForm } from "./MessagingSettingsForm";

// Settings → Brohda: the Member Messaging capability and its policy. OFF by default; fails closed. Separate from every other switch.
export async function MessagingSettingsCard() {
  const settings = await getMessagingSettingsForAdmin().catch(() => null);
  return (
    <section id="messaging" aria-label="Messaging" data-slot="messaging-settings" className="scroll-mt-4 space-y-2 rounded-lg border border-border-subtle p-3 text-sm">
      <h2 className="text-sm font-semibold text-text-primary">Messaging</h2>
      {settings ? (
        <>
          <p className="text-text-secondary">
            Status: <span className="font-medium text-text-primary" data-slot="messaging-state">{settings.messaging_enabled === true ? "On" : "Off"}</span>
          </p>
          <MessagingSettingsForm enabled={settings.messaging_enabled === true} values={settings} />
        </>
      ) : (
        <p role="alert" className="text-xs font-medium text-warning-muted">The settings couldn&apos;t be read, so Messaging stays off until they can.</p>
      )}
      <p className="text-xs text-text-muted">
        Messaging is private between two Members: no groups, no images. Turning it off hides it at once and keeps every record. Retention left blank keeps everything; set durations only after the owner and counsel
        approve them.
      </p>
    </section>
  );
}
