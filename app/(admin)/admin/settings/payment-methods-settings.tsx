"use client";

import { useActionState, useState, useTransition } from "react";
import {
  setPaymentMethodEnabledAction,
  updatePaymentMethodDestinationAction,
  type PaymentMethodSettingsState,
} from "@/lib/actions/payment-methods";
import { PAYMENT_METHOD_LABELS } from "@/lib/payment-methods/constants";
import type { PaymentMethodRow } from "@/lib/payment-methods/fetch";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

const initialState: PaymentMethodSettingsState = { error: null };

function PaymentMethodRowItem({ row }: { row: PaymentMethodRow }) {
  const [enabled, setEnabled] = useState(row.enabled);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [state, formAction, formPending] = useActionState(updatePaymentMethodDestinationAction, initialState);

  function handleToggle() {
    setToggleError(null);
    startTransition(async () => {
      const result = await setPaymentMethodEnabledAction(row.method, !enabled);
      if (!result.success) {
        setToggleError(result.error);
        return;
      }
      setEnabled(!enabled);
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-border-subtle p-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm font-medium text-text-primary">{PAYMENT_METHOD_LABELS[row.method]}</p>
        <Switch checked={enabled} onCheckedChange={handleToggle} disabled={isPending} />
      </div>
      {toggleError && <p className="text-sm text-danger">{toggleError}</p>}

      <form action={formAction} className="space-y-2">
        <input type="hidden" name="method" value={row.method} />
        <div className="space-y-1.5">
          <Label htmlFor={`destination-${row.method}`}>
            Destination (wallet address / username / cashtag / email)
          </Label>
          <Input
            id={`destination-${row.method}`}
            name="destination"
            defaultValue={row.destination ?? ""}
            placeholder="e.g. 0xAbc123... or @yourhandle"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`instructions-${row.method}`}>Instructions (optional)</Label>
          <Input
            id={`instructions-${row.method}`}
            name="instructions"
            defaultValue={row.instructions ?? ""}
            placeholder="e.g. on the ETH Network"
          />
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={formPending}>
          {formPending ? "Saving…" : "Save"}
        </Button>
        {state.error && <p className="text-sm text-danger">{state.error}</p>}
      </form>
    </div>
  );
}

export function PaymentMethodsSettings({ methods }: { methods: PaymentMethodRow[] }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium text-text-primary">Payment methods</p>
        <p className="text-xs text-text-muted">
          Enable the currencies players can use for Add Funds / Transfer Out, and set where deposits
          should be sent for each.
        </p>
      </div>
      <div className="space-y-3">
        {methods.map((row) => (
          // Keyed on the mutable fields too (not just row.method) — same
          // precedent as ProfileForm's key, forcing a full remount instead
          // of an in-place update whenever destination/instructions change.
          // The Input/Textarea primitives here (@base-ui/react/input) warn
          // ("changing the default value state of an uncontrolled
          // FieldControl after being initialized") and can misbehave if an
          // uncontrolled field's defaultValue changes on an instance kept
          // alive across a revalidatePath-triggered re-render.
          <PaymentMethodRowItem key={`${row.method}-${row.destination}-${row.instructions}`} row={row} />
        ))}
      </div>
    </div>
  );
}
