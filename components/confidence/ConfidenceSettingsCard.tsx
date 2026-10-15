import Link from "next/link";
import { getConfidenceSettingsForAdmin } from "@/lib/confidence/config";
import { ConfidenceSettingsForm } from "./ConfidenceSettingsForm";

const NOTE =
  "Confidence is internal reputation. It can't be bought, redeemed or transferred. Turning it off hides it from Members at once and keeps every record; turning it on gives every eligible Member the baseline once.";

// Settings → Brohda: the Confidence capability and its policy. OFF by default; fails closed. Separate from every other switch.
export async function ConfidenceSettingsCard() {
  const settings = await getConfidenceSettingsForAdmin().catch(() => null);
  return (
    <section id="confidence" aria-label="Confidence" data-slot="confidence-settings" className="scroll-mt-4 space-y-2 rounded-lg border border-border-subtle p-3 text-sm">
      <h2 className="text-sm font-semibold text-text-primary">Confidence</h2>
      {settings ? (
        <>
          <p className="text-text-secondary">
            Status: <span className="font-medium text-text-primary" data-slot="confidence-state">{settings.enabled ? "On" : "Off"}</span>
            {" · "}
            <Link href="/admin/confidence" className="font-medium text-text-primary underline-offset-2 hover:underline">
              Economy and Member lookup
            </Link>
          </p>
          <ConfidenceSettingsForm settings={settings} />
        </>
      ) : (
        <p role="alert" className="text-xs font-medium text-warning-muted">The settings couldn&apos;t be read, so Confidence stays off until they can.</p>
      )}
      <p className="text-xs text-text-muted">{NOTE}</p>
    </section>
  );
}
