"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { setOnlinePaymentConfigAction, type AdminPaymentResult } from "@/lib/actions/sponsorship-payments";

// The Super Admin's control: Disabled, or one of the providers this deployment has installed (the list comes from the server's registry, never typed here).
export function OnlinePaymentsForm({ current, options }: { current: string; options: Array<{ key: string; label: string }> }) {
  const [state, action, pending] = useActionState<AdminPaymentResult | null, FormData>(setOnlinePaymentConfigAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" data-slot="online-payments-form">
      <label className="space-y-1 text-xs font-medium text-text-secondary">
        Provider for new payments
        <select name="provider" defaultValue={current} className="block h-9 rounded-md border border-border-subtle bg-surface-primary px-2 text-sm text-text-primary">
          <option value="DISABLED">Disabled</option>
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" variant="outline" disabled={pending}>
        Save
      </Button>
      {state && (
        <p role={state.success ? "status" : "alert"} className={state.success ? "w-full text-xs font-medium text-text-primary" : "w-full text-xs font-medium text-warning-muted"}>
          {state.error ?? state.message}
        </p>
      )}
    </form>
  );
}
